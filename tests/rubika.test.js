// تست‌های اتصال روبیکا و ارسال OTP از طریق ربات (سمت سایت)
// اجرا: node --test tests/rubika.test.js     (بدون وابستگی؛ Node 20+)
import test from "node:test";
import assert from "node:assert/strict";
import { createRubika, generateCode, normalizeCode, formatCode, CODE_ALPHABET, CODE_LENGTH } from "../src/rubika.js";
import { createAuth } from "../src/auth.js";

// ---------- ابزارهای آزمایشی (هم‌شکل با worker.js) ----------
const enc = new TextEncoder();
const b64u = (bytes) => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const fromB64u = (str) => { const s = String(str).replace(/-/g, "+").replace(/_/g, "/"); const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4)); return Uint8Array.from(bin, (c) => c.charCodeAt(0)); };
async function hmac(secret, data) { const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return b64u(new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)))); }
const safeEqual = (a, b) => { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; };
class HttpError extends Error { constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; this.extra = extra; } }
const SECRET = "s".repeat(40), INTERNAL = "i".repeat(40);
const uidOf = async (phone) => (await hmac(SECRET, "uid:" + phone)).slice(0, 24);

function memKv() { // رفتار هم‌ارز Durable Object: هر عملیات یک‌تکه و اتمیک
  const m = new Map(); const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
  return { m, get: async (k) => (m.has(k) ? clone(m.get(k)) : null), put: async (k, v) => { m.set(k, clone(v)); },
    cas: async (k, expect, value) => { const cur = m.has(k) ? m.get(k) : null; if (JSON.stringify(cur) !== JSON.stringify(expect ?? null)) return false; m.set(k, clone(value)); return true; } };
}
function memRl(clock) {
  const m = new Map();
  return { check: async (key, max, windowMs) => { const a = (m.get(key) || []).filter((t) => clock.t - t < windowMs); return a.length >= max ? { blocked: true, retryAfterSec: Math.ceil((a[0] + windowMs - clock.t) / 1000) } : { blocked: false }; },
    hit: async (key, windowMs) => { const a = (m.get(key) || []).filter((t) => clock.t - t < windowMs); a.push(clock.t); m.set(key, a); },
    clear: async (key) => { m.delete(key); } };
}
function capLog() { const lines = []; const f = (...a) => lines.push(a.join(" ")); return { lines, log: f, warn: f, error: f, info: f }; }

function setup({ env = {}, fetchFn } = {}) {
  const clock = { t: 1_700_000_000_000 }; const kv = memKv(); const rl = memRl(clock); const logger = capLog();
  const fullEnv = { SESSION_SECRET: SECRET, RUBIKA_ENABLED: "true", RUBIKA_INTERNAL_SECRET: INTERNAL, RUBIKA_BOT_USERNAME: "qairo_bot", REGISTRATION_MODE: "open", SMS_PROVIDER: "kavenegar", KAVENEGAR_API_KEY: "key12345", KAVENEGAR_TEMPLATE: "tpl", ...env };
  const rubika = createRubika({ env: fullEnv, HttpError, kv, rl, hmac, safeEqual, uidOf, now: () => clock.t, log: logger, fetchFn });
  return { clock, kv, rl, logger, env: fullEnv, rubika };
}
const hdr = (o = {}) => new Headers(o);
const ok = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

// ===================== کد اتصال =====================
test("کد اتصال: الفبای بدون نویسه‌ی مبهم، طول ۱۲ و نرمال‌سازی", () => {
  const seen = new Set();
  for (let i = 0; i < 300; i++) { const c = generateCode(); assert.equal(c.length, CODE_LENGTH); for (const ch of c) assert.ok(CODE_ALPHABET.includes(ch)); assert.equal(normalizeCode(c), c); seen.add(c); }
  assert.equal(seen.size, 300);
  const c = generateCode(); assert.equal(normalizeCode(formatCode(c).toLowerCase()), c);
  assert.equal(normalizeCode("abc"), null); assert.equal(normalizeCode("O".repeat(12)), null); assert.equal(normalizeCode(null), null);
});

// ===================== اتصال حساب =====================
test("۱-۲: شروع اتصال → ربات کد را می‌گیرد → حساب متصل می‌شود؛ کد خام ذخیره نمی‌شود", async () => {
  const { rubika, kv } = setup(); const uid = "U1";
  assert.equal((await rubika.status(uid)).status, "not_connected");
  const s = await rubika.startLink(uid, "1.1.1.1");
  assert.equal((await rubika.status(uid)).status, "pending");
  assert.match(s.link, /^https:\/\/rubika\.ir\/qairo_bot\?st=[A-Z0-9]{12}$/);
  const raw = normalizeCode(s.code);
  assert.ok(![...kv.m.keys()].some((k) => k.includes(raw)) && !JSON.stringify([...kv.m.values()]).includes(raw), "کد خام نباید در ذخیره‌سازی باشد");
  assert.deepEqual(await rubika.consume(s.code, "b0chatAAA"), { linked: true });
  const st = await rubika.status(uid); assert.equal(st.status, "connected"); assert.ok(st.connectedAt);
  assert.deepEqual(await rubika.verifyChat("b0chatAAA"), { connected: true });
  const rec = kv.m.get("rubika:link:U1");
  for (const f of ["userId", "rubikaChatId", "status", "connectedAt", "createdAt", "updatedAt"]) assert.ok(rec[f], "فیلد " + f);
});

test("توکن اتصال یک‌بارمصرف است", async () => {
  const { rubika } = setup(); const s = await rubika.startLink("U1", "ip");
  await rubika.consume(s.code, "b0chatAAA");
  await assert.rejects(() => rubika.consume(s.code, "b0chatBBB"), (e) => e.code === "BAD_CODE");
  assert.deepEqual(await rubika.verifyChat("b0chatBBB"), { connected: false });
});

test("۹: انقضای کد اتصال", async () => {
  const { rubika, clock } = setup({ env: { RUBIKA_LINK_TTL_SEC: "600" } }); const s = await rubika.startLink("U1", "ip");
  clock.t += 601_000;
  assert.equal((await rubika.status("U1")).status, "not_connected");
  await assert.rejects(() => rubika.consume(s.code, "b0chatAAA"), (e) => e.code === "BAD_CODE");
});

test("۱۰: ۲۰ مصرف هم‌زمان یک کد → فقط یکی موفق", async () => {
  const { rubika } = setup(); const s = await rubika.startLink("U1", "ip");
  const rs = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => rubika.consume(s.code, "b0chat" + String(i).padStart(3, "0"))));
  assert.equal(rs.filter((r) => r.status === "fulfilled").length, 1);
  const st = await rubika.status("U1"); assert.equal(st.status, "connected");
});

test("کد جدید، کد قبلی را باطل می‌کند", async () => {
  const { rubika } = setup(); const a = await rubika.startLink("U1", "ip"); const b = await rubika.startLink("U1", "ip");
  await assert.rejects(() => rubika.consume(a.code, "b0chatAAA"), (e) => e.code === "BAD_CODE");
  assert.deepEqual(await rubika.consume(b.code, "b0chatAAA"), { linked: true });
});

test("حدس‌زدن کد: پس از ۵ تلاش ناموفق همان چت مسدود می‌شود", async () => {
  const { rubika } = setup(); await rubika.startLink("U1", "ip");
  for (let i = 0; i < 5; i++) await assert.rejects(() => rubika.consume(generateCode(), "b0chatEVIL"), (e) => e.code === "BAD_CODE");
  await assert.rejects(() => rubika.consume(generateCode(), "b0chatEVIL"), (e) => e.code === "TOO_MANY_ATTEMPTS");
});

test("یک chat_id فقط به یک حساب؛ بعد از قطع اتصال آزاد می‌شود (اتصال حساب دیگر)", async () => {
  const { rubika } = setup();
  await rubika.consume((await rubika.startLink("U1", "ip")).code, "b0shared");
  const s2 = await rubika.startLink("U2", "ip2");
  await assert.rejects(() => rubika.consume(s2.code, "b0shared"), (e) => e.code === "CHAT_IN_USE");
  assert.equal((await rubika.status("U1")).status, "connected");
  // قطع اتصال U1 (۶: قطع اتصال حساب)
  assert.equal((await rubika.disconnect("U1")).status, "disconnected");
  assert.deepEqual(await rubika.verifyChat("b0shared"), { connected: false });
  assert.deepEqual(await rubika.consume(s2.code, "b0shared"), { linked: true });
  assert.equal((await rubika.status("U2")).status, "connected");
});

test("وقتی متصل است، شروع اتصال جدید رد می‌شود؛ بعد از قطع، دوباره ممکن است", async () => {
  const { rubika } = setup(); await rubika.consume((await rubika.startLink("U1", "ip")).code, "b0chatAAA");
  await assert.rejects(() => rubika.startLink("U1", "ip"), (e) => e.code === "ALREADY_CONNECTED");
  await rubika.disconnect("U1");
  const s = await rubika.startLink("U1", "ip"); await rubika.consume(s.code, "b0chatNEW");
  assert.deepEqual(await rubika.verifyChat("b0chatNEW"), { connected: true }); assert.deepEqual(await rubika.verifyChat("b0chatAAA"), { connected: false });
});

test("توقف ربات توسط کاربر (chatStopped) اتصال را قطع می‌کند", async () => {
  const { rubika } = setup(); await rubika.consume((await rubika.startLink("U1", "ip")).code, "b0chatAAA");
  assert.deepEqual(await rubika.chatStopped("b0chatAAA"), { unlinked: true });
  const st = await rubika.status("U1"); assert.equal(st.status, "disconnected"); assert.equal(st.disconnectReason, "bot_stopped");
  assert.deepEqual(await rubika.chatStopped("b0chatAAA"), { unlinked: false });
});

test("محدودیت تعداد درخواست شروع اتصال", async () => {
  const { rubika } = setup();
  for (let i = 0; i < 5; i++) await rubika.startLink("U1", "ip");
  await assert.rejects(() => rubika.startLink("U1", "ip"), (e) => e.status === 429);
});

// ===================== API داخلی =====================
test("endpoint داخلی: بدون/با راز اشتباه رد، از پشت proxy رد، با راز درست قبول", async () => {
  const { rubika } = setup();
  await assert.rejects(() => rubika.assertInternal(hdr()), (e) => e.status === 401);
  await assert.rejects(() => rubika.assertInternal(hdr({ authorization: "Bearer wrong" })), (e) => e.status === 401);
  await assert.rejects(() => rubika.assertInternal(hdr({ authorization: "Bearer " + INTERNAL, "x-forwarded-for": "5.5.5.5" })), (e) => e.status === 404);
  await rubika.assertInternal(hdr({ authorization: "Bearer " + INTERNAL }));
  const off = setup({ env: { RUBIKA_ENABLED: "false" } }).rubika;
  await assert.rejects(() => off.assertInternal(hdr({ authorization: "Bearer " + INTERNAL })), (e) => e.code === "RUBIKA_NOT_CONFIGURED");
  const weak = setup({ env: { RUBIKA_INTERNAL_SECRET: "short" } }).rubika;
  await assert.rejects(() => weak.startLink("U1", "ip"), (e) => e.code === "RUBIKA_NOT_CONFIGURED");
});

// ===================== ارسال OTP =====================
async function linked(phone, chatId, ctx) { const uid = await uidOf(phone); await ctx.rubika.consume((await ctx.rubika.startLink(uid, "ip")).code, chatId); return uid; }

test("۵: کاربر بدون اتصال روبیکا → used:false (مسیر پیامک) و هیچ درخواستی به ربات نمی‌رود", async () => {
  let calls = 0; const ctx = setup({ fetchFn: async () => { calls++; return ok({ ok: true }); } });
  assert.deepEqual(await ctx.rubika.sendOtp("09120000000", "123456", 120), { used: false }); assert.equal(calls, 0);
});

test("۴: ارسال موفق OTP به ربات؛ Bearer درست، chatId درست، و کد در لاگ نیست", async () => {
  let req = null;
  const ctx = setup({ fetchFn: async (url, init) => { req = { url, init }; return ok({ ok: true, messageId: "m1" }); } });
  await linked("09120000000", "b0chatAAA", ctx);
  const r = await ctx.rubika.sendOtp("09120000000", "654321", 120);
  assert.deepEqual(r, { used: true, ok: true });
  assert.equal(req.url, "http://127.0.0.1:8790/internal/send-otp"); assert.equal(req.init.headers.Authorization, "Bearer " + INTERNAL);
  assert.deepEqual(JSON.parse(req.init.body), { chatId: "b0chatAAA", code: "654321", ttlSec: 120 });
  assert.ok(!ctx.logger.lines.join("\n").includes("654321"));
});

test("۸: خطای ربات/روبیکا → ok:false (بدون پرتاب) و کد لاگ نمی‌شود", async () => {
  const ctx = setup({ fetchFn: async () => new Response(JSON.stringify({ ok: false, error: { code: "UPSTREAM", retryable: true, permanent: false } }), { status: 502 }) });
  await linked("09120000000", "b0chatAAA", ctx);
  const r = await ctx.rubika.sendOtp("09120000000", "111222", 120);
  assert.equal(r.used, true); assert.equal(r.ok, false); assert.equal((await ctx.rubika.status(await uidOf("09120000000"))).status, "connected");
  assert.ok(!ctx.logger.lines.join("\n").includes("111222"));
});

test("ربات خاموش/غیرقابل‌دسترس → ok:false با BOT_UNREACHABLE", async () => {
  const ctx = setup({ fetchFn: async () => { throw new Error("ECONNREFUSED http://127.0.0.1:8790?code=111222"); } });
  await linked("09120000000", "b0chatAAA", ctx);
  const r = await ctx.rubika.sendOtp("09120000000", "111222", 120); assert.deepEqual([r.used, r.ok, r.code], [true, false, "BOT_UNREACHABLE"]);
  assert.ok(!ctx.logger.lines.join("\n").includes("111222"));
});

test("۷: chat_id نامعتبر (خطای دائمی) ← بعد از ۳ شکست پیاپی اتصال قطع می‌شود", async () => {
  const ctx = setup({ fetchFn: async () => new Response(JSON.stringify({ ok: false, error: { code: "CHAT_REJECTED", retryable: false, permanent: true } }), { status: 502 }) });
  const uid = await linked("09120000000", "b0deadchat", ctx);
  for (let i = 0; i < 2; i++) { await ctx.rubika.sendOtp("09120000000", "123456", 120); assert.equal((await ctx.rubika.status(uid)).status, "connected"); }
  await ctx.rubika.sendOtp("09120000000", "123456", 120);
  const st = await ctx.rubika.status(uid); assert.equal(st.status, "disconnected"); assert.equal(st.disconnectReason, "delivery_failed");
  assert.deepEqual(await ctx.rubika.sendOtp("09120000000", "123456", 120), { used: false });
});

// ===================== یکپارچگی با auth.js (سیستم OTP فعلی) =====================
function authSetup({ rubikaEnv = {}, botFetch, smsFetch }) {
  const ctx = setup({ env: rubikaEnv, fetchFn: botFetch });
  const smsCalls = []; const smsF = smsFetch || (async () => ok({ return: { status: 200 } }));
  const wrapped = async (...a) => { smsCalls.push(String(a[0])); return smsF(...a); };
  const auth = createAuth({ env: ctx.env, HttpError, kv: ctx.kv, rl: ctx.rl, hmac, b64u, fromB64u, safeEqual, issueSession: async () => ({ token: "t" }), sleep: async () => {}, rubika: ctx.rubika, fetchFn: wrapped, now: () => ctx.clock.t, log: ctx.logger });
  return { ...ctx, auth, smsCalls };
}

test("سیستم فعلی OTP: کاربر متصل → کد فقط از ربات می‌رسد و با همان اعتبارسنجی قبلی تأیید می‌شود", async () => {
  let delivered = null;
  const t = authSetup({ botFetch: async (u, init) => { delivered = JSON.parse(init.body); return ok({ ok: true }); } });
  await linked("09121111111", "b0chatAAA", t);
  const out = await t.auth.otpSend("09121111111", "9.9.9.9");
  assert.deepEqual(Object.keys(out).sort(), ["expiresInSec", "length", "resendAfterSec", "sent"]); // قالب پاسخ دست‌نخورده؛ کانال لو نمی‌رود
  assert.equal(t.smsCalls.length, 0, "پیامک نباید ارسال شود");
  assert.match(delivered.code, /^\d{6}$/);
  await assert.rejects(() => t.auth.otpVerify("09121111111", delivered.code === "000000" ? "000001" : "000000", "9.9.9.9"), (e) => e.code === "BAD_OTP");
  const v = await t.auth.otpVerify("09121111111", delivered.code, "9.9.9.9"); assert.ok(v.otpToken);
  assert.ok(!t.logger.lines.join("\n").includes(delivered.code));
});

test("کاربر بدون اتصال → رفتار قبلی (پیامک)", async () => {
  let bot = 0; const t = authSetup({ botFetch: async () => { bot++; return ok({ ok: true }); } });
  await t.auth.otpSend("09122222222", "9.9.9.9");
  assert.equal(bot, 0); assert.equal(t.smsCalls.length, 1); assert.match(t.smsCalls[0], /kavenegar/);
});

test("شکست ارسال روبیکا → پیامک جایگزین (پیش‌فرض)، و کد معتبر می‌ماند", async () => {
  const t = authSetup({ botFetch: async () => { throw new Error("down"); } });
  await linked("09123333333", "b0chatAAA", t);
  const out = await t.auth.otpSend("09123333333", "9.9.9.9"); assert.equal(out.sent, true); assert.equal(t.smsCalls.length, 1);
  assert.ok(await t.kv.get("auth:otp:09123333333"), "رکورد کد باید باقی بماند");
});

test("شکست روبیکا + RUBIKA_FALLBACK_TO_SMS=false → خطا، کد باطل، ورود ممکن نیست", async () => {
  const t = authSetup({ rubikaEnv: { RUBIKA_FALLBACK_TO_SMS: "false" }, botFetch: async () => { throw new Error("down"); } });
  await linked("09124444444", "b0chatAAA", t);
  await assert.rejects(() => t.auth.otpSend("09124444444", "9.9.9.9"), (e) => e.code === "OTP_DELIVERY_FAILED" && e.status === 502);
  assert.equal(t.smsCalls.length, 0); assert.equal(await t.kv.get("auth:otp:09124444444"), null);
  await assert.rejects(() => t.auth.otpVerify("09124444444", "123456", "9.9.9.9"), (e) => e.code === "BAD_OTP");
});

test("شکست روبیکا و شکست پیامک → خطا و کد باطل (هیچ ورودی بدون تحویل کد ممکن نیست)", async () => {
  const t = authSetup({ botFetch: async () => { throw new Error("down"); }, smsFetch: async () => ok({ return: { status: 411 } }) });
  await linked("09125555555", "b0chatAAA", t);
  await assert.rejects(() => t.auth.otpSend("09125555555", "9.9.9.9"), (e) => e.code === "SMS_FAILED");
  assert.equal(await t.kv.get("auth:otp:09125555555"), null);
});

test("بدون rubika (وابستگی اختیاری) auth.js دقیقاً مثل قبل کار می‌کند", async () => {
  const ctx = setup(); const smsCalls = [];
  const auth = createAuth({ env: ctx.env, HttpError, kv: ctx.kv, rl: ctx.rl, hmac, b64u, fromB64u, safeEqual, issueSession: async () => ({}), sleep: async () => {}, fetchFn: async (u) => { smsCalls.push(u); return ok({ return: { status: 200 } }); }, now: () => ctx.clock.t, log: ctx.logger });
  await auth.otpSend("09126666666", "1.1.1.1"); assert.equal(smsCalls.length, 1);
});

test("cooldown سیستم فعلی دست‌نخورده: درخواست دوم پشت‌سرهم به ربات نمی‌رسد", async () => {
  let n = 0; const t = authSetup({ botFetch: async () => { n++; return ok({ ok: true }); } });
  await linked("09127777777", "b0chatAAA", t);
  await t.auth.otpSend("09127777777", "9.9.9.9");
  await assert.rejects(() => t.auth.otpSend("09127777777", "9.9.9.9"), (e) => e.code === "OTP_COOLDOWN");
  assert.equal(n, 1);
});
