// ===================================================================
// src/rubika.js — اتصال حساب کاربر به ربات روبیکا و ارسال کد ورود از طریق آن
// -------------------------------------------------------------------
// این فایل فقط «روش ارسال» را اضافه می‌کند؛ تولید و اعتبارسنجی OTP همچنان در auth.js است.
//
// • اتصال: کاربرِ واردشده یک «کد اتصال» تصادفی و یک‌بارمصرف می‌گیرد (۱۲ نویسه، حدود ۶۰ بیت، اعتبار ۱۰ دقیقه).
//   فقط HMAC کد ذخیره می‌شود. ربات کد را (از لینک شروع یا پیام کاربر) می‌گیرد و به endpoint داخلی می‌دهد.
// • هرگز بر اساس شماره‌ای که در ربات وارد می‌شود، حسابی متصل نمی‌شود.
// • یک chat_id فقط به یک حساب وصل می‌شود.
// • ارسال کد: سایت به API داخلی ربات (فقط لوکال + راز مشترک) درخواست می‌دهد؛ توکن ربات هرگز در سایت نیست.
// • کد OTP هرگز لاگ نمی‌شود.
//
// کلیدهای ذخیره‌سازی (همه در فضای سراسری kv؛ شماره‌ی موبایل ذخیره نمی‌شود، فقط uid ناشناس):
//   rubika:link:<uid>   → { userId, rubikaChatId, status, connectedAt, createdAt, updatedAt, pendingExp, failCount, disconnectReason }
//   rubika:chat:<chatId>→ uid   (یک chat_id ⇄ یک حساب)
//   rubika:tok:<hmac>   → { uid, exp }   (کد اتصال هش‌شده)
//   rubika:pend:<uid>   → { h, exp }     (فقط آخرین کد هر کاربر معتبر است)
// ===================================================================

export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // ۳۱ نویسه؛ بدون I L O 0 1 تا اشتباه خوانده نشود
export const CODE_LENGTH = 12;
const CHAT_ID_RE = /^[A-Za-z0-9_-]{4,80}$/;
const clampInt = (v, min, max, dflt) => { const n = Number(v); return Number.isInteger(n) && n >= min && n <= max ? n : dflt; };

export function normalizeCode(raw) {
  let s = String(raw === undefined || raw === null ? "" : raw).trim().toUpperCase();
  s = s.replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0)).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  s = s.replace(/[^A-Z0-9]/g, "");
  if (s.length !== CODE_LENGTH) return null;
  for (const ch of s) if (!CODE_ALPHABET.includes(ch)) return null;
  return s;
}
export const formatCode = (c) => c.match(/.{1,4}/g).join("-");
export function generateCode() {
  const limit = 256 - (256 % CODE_ALPHABET.length); // رد کردن مقادیر اریب (rejection sampling)
  let out = "";
  while (out.length < CODE_LENGTH) {
    const buf = crypto.getRandomValues(new Uint8Array(32));
    for (const b of buf) { if (b < limit && out.length < CODE_LENGTH) out += CODE_ALPHABET[b % CODE_ALPHABET.length]; }
  }
  return out;
}
export const isValidChatId = (x) => typeof x === "string" && CHAT_ID_RE.test(x);

export function createRubika(d) {
  const { env, HttpError, kv, rl, hmac, safeEqual, uidOf, now = () => Date.now(), log = console } = d;
  const doFetch = d.fetchFn || ((...a) => fetch(...a));
  const bad = (status, code, msg, extra) => new HttpError(status, code, msg, extra);

  const cfg = () => ({
    enabled: String(env.RUBIKA_ENABLED || "").trim().toLowerCase() === "true",
    botUrl: String(env.RUBIKA_BOT_URL || "http://127.0.0.1:8790").trim().replace(/\/+$/, ""),
    secret: String(env.RUBIKA_INTERNAL_SECRET || ""),
    username: String(env.RUBIKA_BOT_USERNAME || "").trim().replace(/^@/, ""),
    // UNVERIFIED: مستندات روبیکا می‌گوید start_id از لینک دارای پارامتر «st» پر می‌شود. اگر لینک در عمل کار نکرد
    // قالب را با RUBIKA_LINK_TEMPLATE عوض کنید؛ مسیر «ارسال دستی کد به ربات» همیشه کار می‌کند.
    linkTemplate: String(env.RUBIKA_LINK_TEMPLATE || "https://rubika.ir/{username}?st={code}"),
    linkTtlSec: clampInt(env.RUBIKA_LINK_TTL_SEC, 120, 3600, 600),
    fallbackSms: String(env.RUBIKA_FALLBACK_TO_SMS || "true").trim().toLowerCase() !== "false",
    sendTimeoutMs: clampInt(env.RUBIKA_SEND_TIMEOUT_MS, 1000, 20000, 8000),
    allowProxied: String(env.RUBIKA_INTERNAL_ALLOW_PROXIED || "").trim().toLowerCase() === "true",
    failLimit: 3,
  });
  const configured = (c) => c.enabled && c.secret.length >= 32;
  const assertConfigured = (c) => { if (!configured(c)) throw bad(503, "RUBIKA_NOT_CONFIGURED", "اتصال روبیکا در این سرور فعال نیست."); };

  const linkKey = (uid) => `rubika:link:${uid}`;
  const chatKey = (chatId) => `rubika:chat:${chatId}`;
  const tokKey = (h) => `rubika:tok:${h}`;
  const pendKey = (uid) => `rubika:pend:${uid}`;
  const iso = () => new Date(now()).toISOString();
  const hashCode = (code) => hmac(env.SESSION_SECRET, "rubika-link:" + code);

  async function limit(key, max, windowMs) {
    const r = await rl.check(key, max, windowMs);
    if (r.blocked) throw bad(429, "TOO_MANY_REQUESTS", "تعداد درخواست‌ها زیاد است؛ کمی بعد دوباره تلاش کنید.", { retryAfter: r.retryAfterSec });
    await rl.hit(key, windowMs);
  }
  async function blockedOnly(key, max, windowMs) {
    const r = await rl.check(key, max, windowMs);
    if (r.blocked) throw bad(429, "TOO_MANY_ATTEMPTS", "تعداد تلاش‌های ناموفق زیاد است؛ بعداً دوباره امتحان کنید.", { retryAfter: r.retryAfterSec });
  }

  // ---------- احراز endpointهای داخلی (فقط ربات) ----------
  async function assertInternal(headers) {
    const c = cfg(); assertConfigured(c);
    // درخواستی که از reverse proxy عبور کرده (X-Forwarded-For دارد) یعنی از اینترنت آمده، نه از ربات روی همین سرور
    if (!c.allowProxied && headers.get("x-forwarded-for")) throw bad(404, "NOT_FOUND", "مسیر یافت نشد.");
    const m = (headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
    const given = m ? m[1].trim() : "";
    // مقایسه‌ی ثابت‌زمان روی HMAC (طول ثابت) تا طول راز لو نرود
    const a = await hmac(env.SESSION_SECRET, "rubika-int:" + given), b = await hmac(env.SESSION_SECRET, "rubika-int:" + c.secret);
    if (!given || !safeEqual(a, b)) throw bad(401, "INTERNAL_UNAUTHORIZED", "دسترسی مجاز نیست.");
  }

  // ---------- وضعیت ----------
  const effective = (rec) => {
    if (!rec) return "not_connected";
    if (rec.status === "pending" && (!rec.pendingExp || rec.pendingExp < now())) return "not_connected";
    return rec.status;
  };
  async function status(uid) {
    const c = cfg(); const rec = await kv.get(linkKey(uid)); const st = effective(rec);
    return {
      available: configured(c), botUsername: c.username || null, status: st,
      connectedAt: st === "connected" ? rec.connectedAt : null,
      pendingExpiresAt: st === "pending" ? new Date(rec.pendingExp).toISOString() : null,
      disconnectReason: st === "disconnected" ? rec.disconnectReason || null : null,
    };
  }

  // ---------- شروع اتصال (کاربر واردشده) ----------
  async function startLink(uid, ip) {
    const c = cfg(); assertConfigured(c);
    await limit(`rubika-start:${uid}`, 5, 15 * 60000); await limit(`rubika-start-ip:${ip}`, 20, 3600000);
    const rec = await kv.get(linkKey(uid));
    if (rec && rec.status === "connected") throw bad(409, "ALREADY_CONNECTED", "حساب روبیکا قبلاً متصل شده است. برای اتصال حساب دیگر، ابتدا اتصال فعلی را قطع کنید.");
    const prev = await kv.get(pendKey(uid)); if (prev && prev.h) await kv.put(tokKey(prev.h), null); // کد قبلی باطل می‌شود
    const code = generateCode(); const h = await hashCode(code); const exp = now() + c.linkTtlSec * 1000;
    await kv.put(tokKey(h), { uid, exp }); await kv.put(pendKey(uid), { h, exp });
    await kv.put(linkKey(uid), { userId: uid, rubikaChatId: null, status: "pending", connectedAt: null, createdAt: (rec && rec.createdAt) || iso(), updatedAt: iso(), pendingExp: exp, failCount: 0, disconnectReason: null });
    const link = c.username ? c.linkTemplate.replace("{username}", encodeURIComponent(c.username)).replace("{code}", encodeURIComponent(code)) : null;
    return { code: formatCode(code), link, expiresAt: new Date(exp).toISOString(), expiresInSec: c.linkTtlSec, botUsername: c.username || null };
  }

  // ---------- قطع اتصال ----------
  async function release(uid, rec, reason) {
    const pend = await kv.get(pendKey(uid)); if (pend && pend.h) await kv.put(tokKey(pend.h), null); await kv.put(pendKey(uid), null);
    if (rec && rec.rubikaChatId) await kv.cas(chatKey(rec.rubikaChatId), uid, null); // آزادسازی chat_id (اتمیک؛ فقط اگر هنوز مال همین کاربر است)
    await kv.put(linkKey(uid), { ...(rec || { userId: uid, createdAt: iso() }), rubikaChatId: null, status: "disconnected", connectedAt: null, pendingExp: null, failCount: 0, disconnectReason: reason, updatedAt: iso() });
  }
  async function disconnect(uid) {
    const rec = await kv.get(linkKey(uid));
    if (rec && (rec.status === "connected" || rec.status === "pending")) await release(uid, rec, "user");
    return status(uid);
  }

  // ---------- مصرف کد اتصال (فقط ربات صدا می‌زند) ----------
  async function consume(codeRaw, chatId) {
    const c = cfg(); assertConfigured(c);
    if (!isValidChatId(chatId)) throw bad(400, "BAD_CHAT", "شناسه‌ی چت نامعتبر است.");
    await blockedOnly(`rubika-consume:${chatId}`, 5, 15 * 60000); await blockedOnly("rubika-consume-global", 300, 3600000);
    const fail = async () => { await rl.hit(`rubika-consume:${chatId}`, 15 * 60000); await rl.hit("rubika-consume-global", 3600000); throw bad(400, "BAD_CODE", "کد اتصال نامعتبر، منقضی یا استفاده‌شده است."); };
    const code = normalizeCode(codeRaw); if (!code) return fail();
    const h = await hashCode(code); const tok = await kv.get(tokKey(h));
    if (!tok || !tok.uid || tok.exp < now()) return fail();
    const uid = tok.uid; const pend = await kv.get(pendKey(uid)); const rec = await kv.get(linkKey(uid));
    if (!pend || pend.h !== h || !rec || rec.status !== "pending") return fail();
    // یک chat_id فقط به یک حساب
    const holder = await kv.get(chatKey(chatId));
    if (holder && holder !== uid) {
      const hrec = await kv.get(linkKey(holder));
      if (hrec && hrec.status === "connected" && hrec.rubikaChatId === chatId) throw bad(409, "CHAT_IN_USE", "این حساب روبیکا به حساب دیگری متصل است.");
    }
    // مصرف یک‌بارمصرف و اتمیک: فقط یکی از درخواست‌های هم‌زمان موفق می‌شود
    if (!(await kv.cas(tokKey(h), tok, null))) return fail();
    await kv.put(pendKey(uid), null);
    if (!(await kv.cas(chatKey(chatId), holder || null, uid))) throw bad(409, "CHAT_IN_USE", "این حساب روبیکا به حساب دیگری متصل است.");
    await kv.put(linkKey(uid), { ...rec, rubikaChatId: chatId, status: "connected", connectedAt: iso(), updatedAt: iso(), pendingExp: null, failCount: 0, disconnectReason: null });
    await rl.clear(`rubika-consume:${chatId}`);
    return { linked: true };
  }

  // ---------- پرس‌وجوهای ربات ----------
  async function verifyChat(chatId) {
    if (!isValidChatId(chatId)) return { connected: false };
    const uid = await kv.get(chatKey(chatId)); if (!uid) return { connected: false };
    const rec = await kv.get(linkKey(uid));
    return { connected: !!rec && rec.status === "connected" && rec.rubikaChatId === chatId };
  }
  async function chatStopped(chatId) { // کاربر ربات را متوقف کرد یا /unlink زد
    if (!isValidChatId(chatId)) return { unlinked: false };
    const uid = await kv.get(chatKey(chatId)); if (!uid) return { unlinked: false };
    const rec = await kv.get(linkKey(uid));
    if (!rec || rec.status !== "connected" || rec.rubikaChatId !== chatId) { await kv.cas(chatKey(chatId), uid, null); return { unlinked: false }; }
    await release(uid, rec, "bot_stopped");
    return { unlinked: true };
  }

  // ---------- ارسال OTP از طریق ربات (auth.js صدا می‌زند) ----------
  // خروجی: {used:false} = کاربر متصل نیست (مسیر پیامک)، {used:true, ok:true} = ارسال شد، {used:true, ok:false} = شکست
  async function sendOtp(phone, code, ttlSec) {
    const c = cfg(); if (!configured(c)) return { used: false };
    const uid = await uidOf(phone); const rec = await kv.get(linkKey(uid));
    if (!rec || rec.status !== "connected" || !isValidChatId(rec.rubikaChatId)) return { used: false };
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), c.sendTimeoutMs);
    let res = null, j = null;
    try {
      res = await doFetch(c.botUrl + "/internal/send-otp", { method: "POST", signal: ctl.signal,
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + c.secret },
        body: JSON.stringify({ chatId: rec.rubikaChatId, code: String(code), ttlSec }) });
      try { j = await res.json(); } catch (_) { /* غیر JSON */ }
    } catch (_) {
      log.warn("[rubika] ربات در دسترس نیست (ارسال کد انجام نشد)."); // پیام خام خطا را لاگ نمی‌کنیم
      return { used: true, ok: false, code: "BOT_UNREACHABLE" };
    } finally { clearTimeout(timer); }
    if (res.ok && j && j.ok === true) { if (rec.failCount) await kv.put(linkKey(uid), { ...rec, failCount: 0, updatedAt: iso() }); return { used: true, ok: true }; }
    const err = (j && j.error) || {}; const permanent = err.permanent === true;
    log.warn(`[rubika] ارسال کد ناموفق بود (${String(err.code || "HTTP_" + res.status).slice(0, 40)}).`);
    if (permanent) { // چت نامعتبر: بعد از چند شکست پیاپی اتصال قطع می‌شود تا هر بار تأخیر بی‌فایده نداشته باشیم
      const n = (rec.failCount || 0) + 1;
      if (n >= c.failLimit) await release(uid, rec, "delivery_failed"); else await kv.put(linkKey(uid), { ...rec, failCount: n, updatedAt: iso() });
    }
    return { used: true, ok: false, code: String(err.code || "BOT_ERROR"), permanent };
  }

  return { enabled: () => configured(cfg()), fallbackToSms: () => cfg().fallbackSms, assertInternal, status, startLink, disconnect, consume, verifyChat, chatStopped, sendOtp };
}
