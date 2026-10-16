// تست‌های ورود واقعی (شماره → پیامک → رمز) و اتصال واقعی کلید والکس.
// پیامک و والکس «جعلی» هستند؛ هیچ درخواست واقعی‌ای به شبکه نمی‌رود.
import test from "node:test";
import assert from "node:assert/strict";
import worker, { DashboardStore } from "../src/worker.js";
import { normalizePhone, parseAllowed } from "../src/auth.js";
import { seal, open } from "../src/vault.js";

const realNow = Date.now, realFetch = globalThis.fetch;
let vnow = Date.UTC(2026, 9, 15, 10, 0, 0);
Date.now = () => vnow; const advance = (ms) => { vnow += ms; };
test.after(() => { Date.now = realNow; globalThis.fetch = realFetch; });

const OWNER = "09121234567", STRANGER = "09350000000";
const net = { sms: [], wallexKeys: [], goodKey: "GOOD-KEY-abcdef123456", smsFail: false };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname === "api.kavenegar.com") {
    if (net.smsFail) return json({ return: { status: 411, message: "invalid" } }, 400);
    net.sms.push({ phone: u.searchParams.get("receptor"), code: u.searchParams.get("token"), template: u.searchParams.get("template"), path: u.pathname }); return json({ return: { status: 200, message: "ok" } });
  }
  if (u.hostname === "api.sms.ir") { net.sms.push({ smsir: JSON.parse(init.body), key: init.headers["x-api-key"] }); return json({ status: 1, message: "ok" }); }
  if (u.hostname === "api.wallex.ir") {
    const k = (init.headers || {})["X-API-Key"]; net.wallexKeys.push(k);
    if (u.pathname === "/v1/account/balances") { if (k !== net.goodKey) return json({ success: false, message: "invalid api key" }, 401); return json({ success: true, result: { balances: { TMN: { asset: "TMN", value: "250000", locked: "0" }, BTC: { asset: "BTC", value: "0.5", locked: "0" }, ETH: { asset: "ETH", value: "0", locked: "0" } } } }); }
    return json({ success: false, message: "not mocked" }, 404);
  }
  throw new Error("شبکه‌ی واقعی در تست مجاز نیست: " + u.hostname);
};

class MemStorage { constructor() { this.m = new Map(); } async get(k) { const v = this.m.get(k); return v === undefined ? undefined : structuredClone(v); } async put(k, v) { this.m.set(k, structuredClone(v)); } async delete(k) { return this.m.delete(k); } }
function mkEnv(extra = {}) {
  const storage = new MemStorage(); const durable = new DashboardStore({ storage }); let chain = Promise.resolve();
  const STORE = { idFromName: (n) => n, get: () => ({ fetch: (url, init) => { const p = chain.then(() => durable.fetch(new Request(url, init))); chain = p.catch(() => {}); return p; } }) };
  return { env: { STORE, SESSION_SECRET: "s".repeat(40), ALLOWED_PHONES: OWNER, SMS_PROVIDER: "kavenegar", KAVENEGAR_API_KEY: "kv-key-SECRET", KAVENEGAR_TEMPLATE: "verify", PBKDF2_ITER: "1000", UPSTREAM_GAP_MS: "0", ...extra }, storage };
}
async function call(env, method, path, body, token) {
  const headers = { Accept: "application/json" }; if (body !== undefined) headers["Content-Type"] = "application/json"; if (token) headers.Authorization = "Bearer " + token;
  const res = await worker.fetch(new Request("https://dash.test" + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }), env, { waitUntil() {} });
  return { status: res.status, body: await res.json() };
}
const lastCode = () => net.sms[net.sms.length - 1].code;
async function otp(env, phone = OWNER) { const r = await call(env, "POST", "/api/auth/otp/send", { phone }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r; }
async function verified(env, phone = OWNER) { await otp(env, phone); const v = await call(env, "POST", "/api/auth/otp/verify", { phone, code: lastCode() }); assert.equal(v.status, 200, JSON.stringify(v.body)); return v.body.data; }

test("نرمال‌سازی شماره و فهرست مجاز", () => {
  assert.equal(normalizePhone("0912 123 4567"), OWNER); assert.equal(normalizePhone("+989121234567"), OWNER); assert.equal(normalizePhone("9121234567"), OWNER);
  assert.equal(normalizePhone("۰۹۱۲۱۲۳۴۵۶۷"), OWNER); assert.equal(normalizePhone("0212345678"), null); assert.equal(normalizePhone("abc"), null);
  assert.deepEqual([...parseAllowed("09121234567, 09350000000;")], [OWNER, STRANGER]);
});

test("پیکربندی ناقص: بدون ALLOWED_PHONES یا SMS_PROVIDER ثبت‌نام غیرفعال است", async () => {
  const a = mkEnv({ ALLOWED_PHONES: "" }); assert.equal((await call(a.env, "POST", "/api/auth/otp/send", { phone: OWNER })).body.error.code, "NOT_CONFIGURED");
  const b = mkEnv({ SMS_PROVIDER: "" }); assert.equal((await call(b.env, "POST", "/api/auth/otp/send", { phone: OWNER })).body.error.code, "SMS_NOT_CONFIGURED");
  const c = mkEnv(); assert.equal((await call(c.env, "POST", "/api/auth/otp/send", { phone: "123" })).body.error.code, "INVALID_PHONE");
});

test("پیامک کاوه‌نگار واقعاً با قالب و کد ارسال می‌شود؛ شماره‌ی غیرمجاز پیامک نمی‌گیرد ولی پاسخ یکسان است", async () => {
  const { env } = mkEnv(); net.sms.length = 0;
  const ok = await otp(env); assert.equal(net.sms.length, 1); assert.equal(net.sms[0].phone, OWNER); assert.equal(net.sms[0].template, "verify"); assert.match(net.sms[0].code, /^\d{6}$/);
  assert.match(net.sms[0].path, /^\/v1\/kv-key-SECRET\/verify\/lookup\.json$/);
  const other = await call(env, "POST", "/api/auth/otp/send", { phone: STRANGER }); assert.equal(other.status, 200);
  assert.deepEqual(other.body.data, ok.body.data); assert.equal(net.sms.length, 1, "برای غریبه پیامک نرود");
  // کولداون هم برای هر دو یکسان
  assert.equal((await call(env, "POST", "/api/auth/otp/send", { phone: OWNER })).body.error.code, "OTP_COOLDOWN");
  assert.equal((await call(env, "POST", "/api/auth/otp/send", { phone: STRANGER })).body.error.code, "OTP_COOLDOWN");
  // کد برای غریبه هرگز تأیید نمی‌شود
  assert.equal((await call(env, "POST", "/api/auth/otp/verify", { phone: STRANGER, code: lastCode() })).body.error.code, "BAD_OTP");
});

test("SMS.ir: درخواست verify با templateId و پارامتر", async () => {
  const { env } = mkEnv({ SMS_PROVIDER: "smsir", SMSIR_API_KEY: "ir-key", SMSIR_TEMPLATE_ID: "12345" }); net.sms.length = 0; await otp(env);
  assert.equal(net.sms[0].smsir.templateId, 12345); assert.equal(net.sms[0].smsir.mobile, OWNER); assert.equal(net.sms[0].smsir.parameters[0].name, "CODE"); assert.equal(net.sms[0].key, "ir-key");
});

test("خطای ارسال پیامک: کد ذخیره نمی‌ماند و کلید پیامک در پاسخ نشت نمی‌کند", async () => {
  const { env, storage } = mkEnv(); net.smsFail = true;
  const r = await call(env, "POST", "/api/auth/otp/send", { phone: OWNER }); net.smsFail = false;
  assert.equal(r.status, 502); assert.equal(r.body.error.code, "SMS_FAILED"); assert.ok(!JSON.stringify(r.body).includes("kv-key-SECRET"));
  assert.equal(storage.m.get("kv:auth:otp:" + OWNER), null);
});

test("کد: غلط، ۵ تلاش، انقضا و یک‌بار مصرف", async () => {
  const { env } = mkEnv(); await otp(env); const code = lastCode(); const wrong = code === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++) assert.equal((await call(env, "POST", "/api/auth/otp/verify", { phone: OWNER, code: wrong })).body.error.code, "BAD_OTP");
  assert.equal((await call(env, "POST", "/api/auth/otp/verify", { phone: OWNER, code })).body.error.code, "BAD_OTP", "پس از ۵ تلاش، کد درست هم دیگر پذیرفته نمی‌شود");
  advance(61_000); await otp(env); const c2 = lastCode(); advance(121_000);
  assert.equal((await call(env, "POST", "/api/auth/otp/verify", { phone: OWNER, code: c2 })).body.error.code, "BAD_OTP", "کد منقضی");
  advance(61_000); await otp(env); const c3 = lastCode();
  assert.equal((await call(env, "POST", "/api/auth/otp/verify", { phone: OWNER, code: c3 })).status, 200);
  assert.equal((await call(env, "POST", "/api/auth/otp/verify", { phone: OWNER, code: c3 })).body.error.code, "BAD_OTP", "کد دوباره قابل استفاده نیست");
});

test("ثبت‌نام: رمز ضعیف رد؛ حساب با هش PBKDF2 ذخیره می‌شود (نه متن رمز)؛ نشست کار می‌کند؛ ثبت‌نام دوباره ممنوع", async () => {
  const { env, storage } = mkEnv(); advance(10 * 60_000);
  const v = await verified(env); assert.equal(v.hasAccount, false); assert.equal(v.resetAllowed, false);
  assert.equal((await call(env, "POST", "/api/auth/register", { phone: OWNER, otpToken: v.otpToken, password: "12345678" })).body.error.code, "WEAK_PASSWORD");
  assert.equal((await call(env, "POST", "/api/auth/register", { phone: OWNER, otpToken: "x".repeat(32), password: "Strong-pass-9" })).body.error.code, "OTP_TOKEN_INVALID");
  const reg = await call(env, "POST", "/api/auth/register", { phone: OWNER, otpToken: v.otpToken, password: "Strong-pass-9" }); assert.equal(reg.status, 200); assert.equal(reg.body.data.phone, OWNER);
  const user = storage.m.get("kv:auth:user:" + OWNER); assert.equal(user.pw.alg, "pbkdf2-sha256"); assert.ok(!JSON.stringify(user).includes("Strong-pass-9"));
  assert.equal((await call(env, "GET", "/api/session/check", undefined, reg.body.data.token)).status, 200);
  assert.equal((await call(env, "GET", "/api/session/check")).status, 401);
  assert.equal((await call(env, "POST", "/api/auth/register", { phone: OWNER, otpToken: v.otpToken, password: "Another-pass-9" })).body.error.code, "OTP_TOKEN_INVALID", "توکن یک‌بار مصرف است");
  advance(61_000); const v2 = await verified(env); assert.equal(v2.hasAccount, true);
  assert.equal((await call(env, "POST", "/api/auth/register", { phone: OWNER, otpToken: v2.otpToken, password: "Another-pass-9" })).body.error.code, "ACCOUNT_EXISTS");
});

test("ورود: رمز غلط، محدودیت ۵ تلاش، رمز درست، و بازنشانی فقط وقتی سرور اجازه دهد", async () => {
  const { env } = mkEnv(); advance(10 * 60_000);
  let v = await verified(env); await call(env, "POST", "/api/auth/register", { phone: OWNER, otpToken: v.otpToken, password: "Strong-pass-9" });
  advance(61_000); v = await verified(env); assert.equal(v.hasAccount, true);
  for (let i = 0; i < 5; i++) assert.equal((await call(env, "POST", "/api/auth/login", { phone: OWNER, otpToken: v.otpToken, password: "wrong-pass-" + i })).body.error.code, "BAD_PASSWORD");
  assert.equal((await call(env, "POST", "/api/auth/login", { phone: OWNER, otpToken: v.otpToken, password: "Strong-pass-9" })).body.error.code, "TOO_MANY_ATTEMPTS", "حتی رمز درست پس از قفل شدن پذیرفته نمی‌شود");
  advance(16 * 60_000); v = await verified(env);
  const ok = await call(env, "POST", "/api/auth/login", { phone: OWNER, otpToken: v.otpToken, password: "Strong-pass-9" }); assert.equal(ok.status, 200); assert.ok(ok.body.data.token);
  advance(61_000); v = await verified(env);
  assert.equal((await call(env, "POST", "/api/auth/reset", { phone: OWNER, otpToken: v.otpToken, password: "New-strong-pass-1" })).body.error.code, "RESET_DISABLED");
  const r = mkEnv({ ALLOW_PASSWORD_RESET: "true" }); advance(10 * 60_000);
  let w = await verified(r.env); await call(r.env, "POST", "/api/auth/register", { phone: OWNER, otpToken: w.otpToken, password: "Strong-pass-9" });
  advance(61_000); w = await verified(r.env); assert.equal(w.resetAllowed, true);
  assert.equal((await call(r.env, "POST", "/api/auth/reset", { phone: OWNER, otpToken: w.otpToken, password: "New-strong-pass-1" })).status, 200);
  advance(61_000); w = await verified(r.env);
  assert.equal((await call(r.env, "POST", "/api/auth/login", { phone: OWNER, otpToken: w.otpToken, password: "New-strong-pass-1" })).status, 200);
});

test("ورود قدیمی با رمز ثابت به‌صورت پیش‌فرض خاموش است", async () => {
  const { env } = mkEnv({ DASHBOARD_PASSCODE: "old-pass" });
  assert.equal((await call(env, "POST", "/api/session", { passcode: "old-pass" })).body.error.code, "PASSCODE_LOGIN_DISABLED");
  const on = mkEnv({ DASHBOARD_PASSCODE: "old-pass", ALLOW_PASSCODE_LOGIN: "true" }); assert.equal((await call(on.env, "POST", "/api/session", { passcode: "old-pass" })).status, 200);
});

async function loginSession(env) {
  advance(10 * 60_000); let v = await verified(env); const reg = await call(env, "POST", "/api/auth/register", { phone: OWNER, otpToken: v.otpToken, password: "Strong-pass-9" }); return reg.body.data.token;
}

test("اتصال واقعی: کلید با والکس آزمایش می‌شود؛ کلید غلط ذخیره نمی‌شود؛ کلید درست رمز می‌شود و در همه‌ی درخواست‌های بعدی استفاده می‌شود", async () => {
  const { env, storage } = mkEnv(); const token = await loginSession(env);
  let st = await call(env, "GET", "/api/session/check", undefined, token); assert.equal(st.body.data.exchangeKeyConfigured, false);
  assert.equal((await call(env, "POST", "/api/connect", { apiKey: "short" }, token)).body.error.code, "INVALID_KEY");
  net.wallexKeys.length = 0;
  const badKey = await call(env, "POST", "/api/connect", { apiKey: "WRONG-KEY-0000000000" }, token);
  assert.equal(badKey.status, 400); assert.equal(badKey.body.error.code, "BAD_API_KEY"); assert.ok(net.wallexKeys.includes("WRONG-KEY-0000000000"), "درخواست واقعی به والکس با همان کلید رفته");
  assert.equal(storage.m.get("kv:secret:wallex"), undefined, "کلید غلط ذخیره نشود");
  const good = await call(env, "POST", "/api/connect", { apiKey: "  " + net.goodKey + "\n" }, token);
  assert.equal(good.status, 200); assert.equal(good.body.data.connected, true); assert.equal(good.body.data.assets, 2); assert.equal(good.body.data.hint, net.goodKey.slice(-4));
  assert.ok(!JSON.stringify(good.body).includes(net.goodKey), "کلید نباید به کلاینت برگردد");
  // رمز‌شده روی دیسک
  const raw = JSON.stringify([...storage.m.entries()]); assert.ok(!raw.includes(net.goodKey), "کلید نباید به‌صورت متن ساده ذخیره شود");
  const rec = storage.m.get("kv:secret:wallex"); assert.equal(await open(env.SESSION_SECRET, rec.sealed), net.goodKey); await assert.rejects(open("x".repeat(40), rec.sealed));
  st = await call(env, "GET", "/api/session/check", undefined, token); assert.equal(st.body.data.exchangeKeyConfigured, true); assert.equal(st.body.data.keySource, "ui");
  // درخواست خصوصی بعدی با همین کلید می‌رود
  net.wallexKeys.length = 0; const w = await call(env, "GET", "/api/wallets", undefined, token); const authed = net.wallexKeys.filter(Boolean); assert.ok(authed.length > 0 && authed.every((k) => k === net.goodKey), JSON.stringify(net.wallexKeys)); // درخواست‌های عمومی بازار کلید ندارند
  // پس از «ری‌استارت» (env جدید با همان ذخیره‌سازی) کلید از دیسک خوانده می‌شود
  const env2 = { ...env }; advance(30_000); net.wallexKeys.length = 0; // (کش حافظه‌ی ۵ثانیه‌ای منقضی شود) await call(env2, "GET", "/api/wallets", undefined, token); const a2 = net.wallexKeys.filter(Boolean); assert.ok(a2.length > 0 && a2.every((k) => k === net.goodKey));
});

test("قطع اتصال: کلید پاک می‌شود؛ با موقعیت واقعی باز ممنوع است", async () => {
  const { env, storage } = mkEnv(); const token = await loginSession(env);
  await call(env, "POST", "/api/connect", { apiKey: net.goodKey }, token);
  storage.m.set("kv:eng:trades", [{ id: "t1", mode: "live", status: "open" }]);
  assert.equal((await call(env, "POST", "/api/disconnect", {}, token)).body.error.code, "OPEN_LIVE_POSITIONS");
  storage.m.set("kv:eng:trades", []);
  const d = await call(env, "POST", "/api/disconnect", {}, token); assert.equal(d.status, 200); assert.equal(d.body.data.connected, false);
  assert.equal((await call(env, "GET", "/api/session/check", undefined, token)).body.data.exchangeKeyConfigured, false);
  assert.equal((await call(env, "GET", "/api/wallets", undefined, token)).body.error.code, "TOKEN_NOT_CONFIGURED");
});

test("کلید ثابت .env همچنان کار می‌کند و کلید UI بر آن ترجیح دارد؛ با تغییر SESSION_SECRET کلید ذخیره‌شده خوانا نیست", async () => {
  const { env, storage } = mkEnv({ WALLEX_API_KEY: "ENV-KEY-0123456789" }); const token = await loginSession(env);
  let st = await call(env, "GET", "/api/session/check", undefined, token); assert.equal(st.body.data.keySource, "env"); assert.equal(st.body.data.exchangeKeyConfigured, true);
  await call(env, "POST", "/api/connect", { apiKey: net.goodKey }, token); st = await call(env, "GET", "/api/session/check", undefined, token); assert.equal(st.body.data.keySource, "ui");
  const rotated = { ...env, SESSION_SECRET: "r".repeat(40) }; const t2 = (await (async () => { return null; })());
  const st2 = await worker.fetch(new Request("https://dash.test/api/session/check", { headers: { Authorization: "Bearer " + token } }), rotated, { waitUntil() {} });
  assert.equal(st2.status, 401, "با Secret جدید نشست قبلی نامعتبر است");
  assert.ok(storage.m.get("kv:secret:wallex"));
});
