// ===================================================================
// src/auth.js — ورود و ثبت‌نام واقعی با شماره موبایل
// -------------------------------------------------------------------
// جریان: شماره → کد پیامکی (OTP) → رمز عبور (ساخت حساب یا ورود)
// • این داشبورد «تک‌کاربره» است (یک کلید والکس روی سرور). پس فقط شماره‌های ALLOWED_PHONES
//   می‌توانند کد بگیرند و حساب بسازند؛ هر ثبت‌نام عمومی کنترل سفارش‌های صاحب را به غریبه می‌داد.
// • برای شماره‌ی غیرمجاز هم پاسخ «کد ارسال شد» می‌دهیم (بدون پیامک) تا مجاز بودن شماره لو نرود.
// • کد OTP فقط به‌صورت HMAC ذخیره می‌شود؛ رمز عبور با PBKDF2-SHA256 (تکرار بالا + salt).
// • محدودیت نرخ: هر شماره و هر IP؛ حداکثر ۵ تلاش برای هر کد؛ انقضای کد ۲ دقیقه.
// ===================================================================
const enc = new TextEncoder();

export const OTP_LENGTH = 6;

export function normalizePhone(raw) {
  let s = String(raw || "").trim().replace(/[\s\-()]/g, "");
  s = s.replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0)).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  if (/^\+989\d{9}$/.test(s)) s = "0" + s.slice(3);
  else if (/^989\d{9}$/.test(s)) s = "0" + s.slice(2);
  else if (/^9\d{9}$/.test(s)) s = "0" + s;
  return /^09\d{9}$/.test(s) ? s : null;
}
export function parseAllowed(list) {
  return new Set(String(list || "").split(/[,\s;]+/).map(normalizePhone).filter(Boolean));
}
const clampInt = (v, min, max, dflt) => { const n = Number(v); return Number.isInteger(n) && n >= min && n <= max ? n : dflt; };
const COMMON = new Set(["12345678", "123456789", "1234567890", "11111111", "00000000", "password", "qwertyui", "12341234", "87654321"]);

export function createAuth(d) {
  const { env, HttpError, kv, rl, hmac, b64u, fromB64u, safeEqual, issueSession, now = () => Date.now(), log = console } = d;
  const doFetch = d.fetchFn || ((...a) => fetch(...a));
  const bad = (status, code, msg, extra) => new HttpError(status, code, msg, extra);
  const secret = () => env.SESSION_SECRET;
  const cfg = () => ({
    allowed: parseAllowed(env.ALLOWED_PHONES), provider: String(env.SMS_PROVIDER || "").toLowerCase(),
    otpTtl: clampInt(env.OTP_TTL_SEC, 60, 600, 120), resend: clampInt(env.OTP_RESEND_SEC, 30, 600, 60), maxAttempts: 5,
    iter: Math.max(1000, Number(env.PBKDF2_ITER) || 600000), resetOk: env.ALLOW_PASSWORD_RESET === "true",
  });

  async function limit(key, max, windowMs) {
    const r = await rl.check(key, max, windowMs);
    if (r.blocked) throw bad(429, "TOO_MANY_REQUESTS", "تعداد درخواست‌ها زیاد است؛ کمی بعد دوباره تلاش کنید.", { retryAfter: r.retryAfterSec });
    await rl.hit(key, windowMs);
  }
  async function blockedOnly(key, max, windowMs) {
    const r = await rl.check(key, max, windowMs);
    if (r.blocked) throw bad(429, "TOO_MANY_ATTEMPTS", "تعداد تلاش‌های ناموفق زیاد است؛ بعداً دوباره امتحان کنید.", { retryAfter: r.retryAfterSec });
  }
  function randomCode() { const buf = new Uint32Array(1); let n; do { crypto.getRandomValues(buf); n = buf[0]; } while (n >= 4294000000); return String(n % 1000000).padStart(OTP_LENGTH, "0"); }
  const rand = (n) => b64u(crypto.getRandomValues(new Uint8Array(n)));

  // ---------- ارسال پیامک ----------
  async function timedFetch(url, init) {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 10000);
    try { return await doFetch(url, { ...init, signal: ctl.signal }); }
    catch (_) { throw bad(502, "SMS_UNREACHABLE", "ارتباط با سرویس پیامک برقرار نشد."); } // پیام خام نمی‌دهیم: ممکن است شامل کلید در URL باشد
    finally { clearTimeout(timer); }
  }
  async function sendSms(c, phone, code) {
    if (c.provider === "console") { log.log(`[OTP] ${phone} → ${code}  (SMS_PROVIDER=console؛ فقط برای راه‌اندازی/آزمایش — پیامکی ارسال نشد)`); return; }
    if (c.provider === "kavenegar") {
      const key = String(env.KAVENEGAR_API_KEY || "").trim(), tpl = String(env.KAVENEGAR_TEMPLATE || "").trim();
      if (!key || !tpl) throw bad(503, "SMS_NOT_CONFIGURED", "KAVENEGAR_API_KEY و KAVENEGAR_TEMPLATE تنظیم نشده‌اند.");
      const url = new URL(`https://api.kavenegar.com/v1/${encodeURIComponent(key)}/verify/lookup.json`);
      url.searchParams.set("receptor", phone); url.searchParams.set("token", code); url.searchParams.set("template", tpl);
      const res = await timedFetch(url, { method: "GET" }); let j = null; try { j = await res.json(); } catch (_) { /* غیر JSON */ }
      if (!res.ok || !j || !j.return || j.return.status !== 200) throw bad(502, "SMS_FAILED", `ارسال پیامک ناموفق بود (کاوه‌نگار${j && j.return ? " — کد " + j.return.status : ", HTTP " + res.status}).`);
      return;
    }
    if (c.provider === "smsir") {
      const key = String(env.SMSIR_API_KEY || "").trim(), tpl = Number(env.SMSIR_TEMPLATE_ID);
      if (!key || !Number.isInteger(tpl)) throw bad(503, "SMS_NOT_CONFIGURED", "SMSIR_API_KEY و SMSIR_TEMPLATE_ID (عدد) تنظیم نشده‌اند.");
      const res = await timedFetch("https://api.sms.ir/v1/send/verify", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", "x-api-key": key },
        body: JSON.stringify({ mobile: phone, templateId: tpl, parameters: [{ name: String(env.SMSIR_PARAM_NAME || "CODE"), value: code }] }) });
      let j = null; try { j = await res.json(); } catch (_) { /* غیر JSON */ }
      // UNVERIFIED: ساختار پاسخ موفق sms.ir (status=1) از نمونه‌های رایج گرفته شده
      if (!res.ok || !j || j.status !== 1) throw bad(502, "SMS_FAILED", `ارسال پیامک ناموفق بود (SMS.ir${j && j.status !== undefined ? " — status " + j.status : ", HTTP " + res.status}).`);
      return;
    }
    throw bad(503, "SMS_NOT_CONFIGURED", "ارسال پیامک تنظیم نشده است (SMS_PROVIDER = kavenegar | smsir | console).");
  }

  // ---------- مرحله ۱: ارسال کد ----------
  async function otpSend(phoneRaw, ip) {
    const c = cfg(); const phone = normalizePhone(phoneRaw);
    if (!phone) throw bad(400, "INVALID_PHONE", "شماره موبایل باید با ۰۹ شروع شود و ۱۱ رقم باشد.");
    if (!c.allowed.size) throw bad(503, "NOT_CONFIGURED", "ALLOWED_PHONES (شماره‌های مجاز) در تنظیمات سرور خالی است؛ ثبت‌نام/ورود غیرفعال است.");
    if (!c.provider) throw bad(503, "SMS_NOT_CONFIGURED", "ارسال پیامک تنظیم نشده است (SMS_PROVIDER).");
    await limit(`otp-ip:${ip}`, 20, 3600000); await limit(`otp:${phone}`, 5, 15 * 60000);
    const key = `auth:otp:${phone}`; const prev = await kv.get(key); const t = now();
    if (prev && t - prev.sentAt < c.resend * 1000) throw bad(429, "OTP_COOLDOWN", "کد قبلی هنوز معتبر است؛ کمی صبر کنید و دوباره درخواست دهید.", { retryAfter: Math.ceil((prev.sentAt + c.resend * 1000 - t) / 1000) });
    const out = { sent: true, expiresInSec: c.otpTtl, resendAfterSec: c.resend, length: OTP_LENGTH };
    if (!c.allowed.has(phone)) { // بدون پیامک؛ ولی دقیقاً مثل شماره‌ی مجاز رفتار می‌کند (کولداون و پاسخ یکسان)
      log.warn("[auth] درخواست کد برای شماره‌ای که در ALLOWED_PHONES نیست نادیده گرفته شد.");
      await kv.put(key, { fake: true, sentAt: t, exp: t + c.otpTtl * 1000, attempts: 0, h: "", salt: "" }); return out;
    }
    const code = randomCode(); const salt = rand(12);
    await kv.put(key, { h: await hmac(secret(), `otp:${phone}:${salt}:${code}`), salt, exp: t + c.otpTtl * 1000, attempts: 0, sentAt: t });
    try { await sendSms(c, phone, code); } catch (e) { await kv.put(key, null); throw e; }
    return out;
  }

  // ---------- مرحله ۲: بررسی کد ----------
  async function otpVerify(phoneRaw, codeRaw, ip) {
    const c = cfg(); const phone = normalizePhone(phoneRaw); const code = String(codeRaw || "").trim().replace(/[۰-۹]/g, (x) => String(x.charCodeAt(0) - 0x06f0));
    if (!phone) throw bad(400, "INVALID_PHONE", "شماره موبایل نامعتبر است.");
    await limit(`otpv-ip:${ip}`, 30, 15 * 60000); await limit(`otpv:${phone}`, 10, 15 * 60000);
    const fail = () => bad(400, "BAD_OTP", "کد نادرست یا منقضی شده است.");
    if (!new RegExp(`^\\d{${OTP_LENGTH}}$`).test(code)) throw fail();
    const key = `auth:otp:${phone}`; const rec = await kv.get(key);
    if (!rec || rec.exp < now() || rec.attempts >= c.maxAttempts) throw fail();
    rec.attempts += 1; await kv.put(key, rec); // اول شمارش، بعد مقایسه
    const good = !rec.fake && safeEqual(await hmac(secret(), `otp:${phone}:${rec.salt}:${code}`), rec.h);
    if (!good) throw fail();
    await kv.put(key, null);
    const token = rand(24);
    await kv.put(`auth:ot:${phone}`, { h: await hmac(secret(), "ot:" + token), exp: now() + 10 * 60000 });
    const user = await kv.get(`auth:user:${phone}`);
    return { otpToken: token, hasAccount: !!user, resetAllowed: c.resetOk && !!user };
  }
  async function checkOtpToken(phone, token) {
    const rec = await kv.get(`auth:ot:${phone}`);
    if (!rec || rec.exp < now() || !token || !safeEqual(await hmac(secret(), "ot:" + String(token)), rec.h)) throw bad(401, "OTP_TOKEN_INVALID", "اعتبار تأیید شماره تمام شده؛ دوباره کد بگیرید.");
  }

  // ---------- رمز عبور ----------
  function checkPasswordPolicy(pw, phone) {
    const p = String(pw || "");
    if (p.length < 8) throw bad(400, "WEAK_PASSWORD", "رمز عبور باید حداقل ۸ کاراکتر باشد.");
    if (p.length > 128) throw bad(400, "WEAK_PASSWORD", "رمز عبور حداکثر ۱۲۸ کاراکتر می‌تواند باشد.");
    if (p === phone || COMMON.has(p.toLowerCase()) || /^(.)\1+$/.test(p)) throw bad(400, "WEAK_PASSWORD", "این رمز بسیار ساده و قابل حدس است؛ رمز قوی‌تری انتخاب کنید.");
  }
  async function pbkdf2(pw, salt, iter) {
    const km = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, km, 256));
  }
  async function makeHash(pw, iter) { const salt = crypto.getRandomValues(new Uint8Array(16)); return { alg: "pbkdf2-sha256", iter, salt: b64u(salt), hash: b64u(await pbkdf2(pw, salt, iter)) }; }
  async function verifyHash(pw, rec) { const got = b64u(await pbkdf2(pw, fromB64u(rec.salt), rec.iter)); return safeEqual(got, rec.hash); }

  async function session(phone) { const s = await issueSession(env); return { ...s, phone }; }

  async function register(phoneRaw, otpToken, password, ip) {
    const c = cfg(); const phone = normalizePhone(phoneRaw); if (!phone || !c.allowed.has(phone)) throw bad(401, "OTP_TOKEN_INVALID", "اعتبار تأیید شماره تمام شده؛ دوباره کد بگیرید.");
    await limit(`reg-ip:${ip}`, 10, 3600000); await checkOtpToken(phone, otpToken);
    if (await kv.get(`auth:user:${phone}`)) throw bad(409, "ACCOUNT_EXISTS", "برای این شماره قبلاً حساب ساخته شده؛ با رمز عبور وارد شوید.");
    checkPasswordPolicy(password, phone);
    await kv.put(`auth:user:${phone}`, { phone, pw: await makeHash(password, c.iter), createdAt: new Date(now()).toISOString(), lastLoginAt: new Date(now()).toISOString() });
    await kv.put(`auth:ot:${phone}`, null); return session(phone);
  }
  async function login(phoneRaw, otpToken, password, ip) {
    const c = cfg(); const phone = normalizePhone(phoneRaw); if (!phone || !c.allowed.has(phone)) throw bad(401, "OTP_TOKEN_INVALID", "اعتبار تأیید شماره تمام شده؛ دوباره کد بگیرید.");
    await blockedOnly(`pw:${phone}`, 5, 15 * 60000); await blockedOnly(`pwip:${ip}`, 20, 15 * 60000); await checkOtpToken(phone, otpToken);
    const user = await kv.get(`auth:user:${phone}`); if (!user) throw bad(404, "NO_ACCOUNT", "حسابی برای این شماره وجود ندارد؛ ثبت‌نام کنید.");
    if (!(await verifyHash(String(password || ""), user.pw))) { await rl.hit(`pw:${phone}`, 15 * 60000); await rl.hit(`pwip:${ip}`, 15 * 60000); await d.sleep(400); throw bad(401, "BAD_PASSWORD", "رمز عبور نادرست است."); }
    await rl.clear(`pw:${phone}`); user.lastLoginAt = new Date(now()).toISOString();
    if (user.pw.iter < c.iter) user.pw = await makeHash(password, c.iter); // ارتقای خودکار تعداد تکرار
    await kv.put(`auth:user:${phone}`, user); await kv.put(`auth:ot:${phone}`, null); return session(phone);
  }
  async function reset(phoneRaw, otpToken, password, ip) {
    const c = cfg(); if (!c.resetOk) throw bad(403, "RESET_DISABLED", "بازنشانی رمز در سرور غیرفعال است (ALLOW_PASSWORD_RESET).");
    const phone = normalizePhone(phoneRaw); if (!phone || !c.allowed.has(phone)) throw bad(401, "OTP_TOKEN_INVALID", "اعتبار تأیید شماره تمام شده؛ دوباره کد بگیرید.");
    await limit(`reset-ip:${ip}`, 5, 3600000); await checkOtpToken(phone, otpToken);
    const user = await kv.get(`auth:user:${phone}`); if (!user) throw bad(404, "NO_ACCOUNT", "حسابی برای این شماره وجود ندارد.");
    checkPasswordPolicy(password, phone); user.pw = await makeHash(password, c.iter); user.passwordChangedAt = new Date(now()).toISOString(); user.lastLoginAt = user.passwordChangedAt;
    await kv.put(`auth:user:${phone}`, user); await rl.clear(`pw:${phone}`); await kv.put(`auth:ot:${phone}`, null); return session(phone);
  }
  return { otpSend, otpVerify, register, login, reset };
}
