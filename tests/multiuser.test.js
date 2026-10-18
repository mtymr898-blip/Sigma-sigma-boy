// تست جداسازی کاربران: کلید، دارایی‌ها، نشست و رمزنگاری — با والکس و پیامک شبیه‌سازی‌شده
import test from "node:test";
import assert from "node:assert/strict";
import worker, { DashboardStore } from "../src/worker.js";

const KEY_A = "WLX-KEY-AAAA-1111-SECRET-A", KEY_B = "WLX-KEY-BBBB-2222-SECRET-B";
const BAL = { [KEY_A]: { BTC: { asset: "BTC", faName: "بیت‌کوین", value: "1.5", locked: "0" } }, [KEY_B]: { ETH: { asset: "ETH", faName: "اتریوم", value: "5", locked: "0" } } };
const MARKETS = { symbols: {
  BTCTMN: { stats: { lastPrice: "100", bidPrice: "99", askPrice: "101", "24h_ch": 1 }, stepSize: 6, tickSize: 0, minQty: 0, minNotional: 0 },
  ETHTMN: { stats: { lastPrice: "10", bidPrice: "9", askPrice: "11", "24h_ch": -1 }, stepSize: 6, tickSize: 0, minQty: 0, minNotional: 0 },
  USDTTMN: { stats: { lastPrice: "1", bidPrice: "1", askPrice: "1", "24h_ch": 0 }, stepSize: 2, tickSize: 0, minQty: 0, minNotional: 0 } } };

let otps = {};
const realLog = console.log;
console.log = (...a) => { const m = String(a[0]).match(/\[OTP\] (\d+) → (\d+)/); if (m) otps[m[1]] = m[2]; else realLog(...a); };
console.warn = () => {};

const sent = { orders: 0, hosts: new Set() };
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url)); sent.hosts.add(u.host);
  if (u.host !== "api.wallex.ir") throw new Error("شبکه‌ی واقعی در تست مجاز نیست: " + u.host); // هیچ درخواستی به بیرون نمی‌رود
  const key = (init.headers || {})["X-API-Key"];
  const json = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { "Content-Type": "application/json" } });
  if (u.pathname === "/v1/markets") return json({ success: true, result: MARKETS });
  if (u.pathname === "/v1/account/balances") return BAL[key] ? json({ success: true, result: { balances: BAL[key] } }) : json({ success: false, message: "bad key" }, 401);
  if (u.pathname === "/v1/account/orders" && init.method === "POST") { sent.orders++; return BAL[key] ? json({ success: true, result: { clientOrderId: JSON.parse(init.body).client_id } }) : json({}, 401); }
  if (u.pathname.startsWith("/v1/account/orders/")) return json({ success: true, result: { symbol: "BTCTMN", type: "MARKET", side: "BUY", status: "FILLED", active: false, clientOrderId: u.pathname.split("/").pop(), origQty: "1", executedQty: "1" } });
  if (u.pathname === "/v1/account/openOrders") return BAL[key] ? json({ success: true, result: { orders: [] } }) : json({}, 401);
  return json({ success: false }, 404);
};

const map = new Map();
const storage = { get: async (k) => (map.has(k) ? structuredClone(map.get(k)) : undefined), put: async (k, v) => { map.set(k, structuredClone(v)); }, delete: async (k) => map.delete(k) };
const durable = new DashboardStore({ storage });
let chain = Promise.resolve();
const STORE = { idFromName: (n) => n, get: () => ({ fetch: (url, init) => { const p = chain.then(() => durable.fetch(new Request(url, init))); chain = p.catch(() => {}); return p; } }) };
const env = { REGISTRATION_MODE: "open", SESSION_SECRET: "s".repeat(40), VAULT_SECRET: "v".repeat(40), SMS_PROVIDER: "console", PBKDF2_ITER: "1000", UPSTREAM_GAP_MS: "0", STORE, ASSETS: { fetch: () => new Response("x") } };
const ctx = { waitUntil: () => {} };

let ipN = 0, curEnv = env;
async function call(path, { token, body, method } = {}) {
  const headers = { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0." + (ipN++ % 200) };
  if (token) headers.Authorization = "Bearer " + token;
  const res = await worker.fetch(new Request("http://x" + path, { method: method || (body ? "POST" : "GET"), headers, body: body ? JSON.stringify(body) : undefined }), curEnv, ctx);
  return { status: res.status, json: await res.json() };
}
async function signup(phone) {
  await call("/api/auth/otp/send", { body: { phone } });
  const v = await call("/api/auth/otp/verify", { body: { phone, code: otps[phone] } });
  const r = await call("/api/auth/register", { body: { phone, otpToken: v.json.data.otpToken, password: "Str0ng-pass-" + phone } });
  assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json.data.token;
}

let A, B, C;
test("ثبت‌نام عمومی (بدون ALLOWED_PHONES) و اتصال کلیدهای جدا", async () => {
  A = await signup("09121111111"); B = await signup("09122222222"); C = await signup("09123333333");
  const bad = await call("/api/connect", { token: A, body: { apiKey: "not-a-valid-key-123" } });
  assert.equal(bad.status, 400); // والکس کلید را نپذیرفت → اتصال انجام نشد
  assert.equal((await call("/api/session/check", { token: A })).json.data.exchangeKeyConfigured, false);
  assert.equal((await call("/api/connect", { token: A, body: { apiKey: KEY_A } })).status, 200);
  assert.equal((await call("/api/connect", { token: B, body: { apiKey: KEY_B } })).status, 200);
});
test("هر کاربر فقط دارایی خودش را می‌بیند", async () => {
  const a = (await call("/api/wallets", { token: A })).json.data, b = (await call("/api/wallets", { token: B })).json.data;
  assert.deepEqual(a.map((x) => x.coinId), ["btc"]); assert.deepEqual(b.map((x) => x.coinId), ["eth"]);
});
test("کاربر بدون کلید به داده‌ی دیگران دسترسی ندارد", async () => {
  assert.equal((await call("/api/session/check", { token: C })).json.data.exchangeKeyConfigured, false);
  assert.equal((await call("/api/wallets", { token: C })).status, 503);
});
test("کلیدها در ذخیره‌سازی متن ساده نیستند و hint فقط ۴ رقم آخر است", async () => {
  const dump = JSON.stringify([...map]);
  for (const k of [KEY_A, KEY_B, "SECRET-A", "SECRET-B"]) assert.ok(!dump.includes(k), "کلید خام در ذخیره‌سازی پیدا شد: " + k);
  const chk = (await call("/api/session/check", { token: A })).json.data;
  assert.equal(chk.keyHint, KEY_A.slice(-4)); assert.ok(!JSON.stringify(chk).includes(KEY_A));
});
test("جابه‌جایی رکورد رمزشده‌ی یک کاربر روی کاربر دیگر باز نمی‌شود (AAD)", async () => {
  const kA = [...map.keys()].find((k) => k.startsWith("kv:u:") && k.endsWith(":secret:wallex") && map.get(k) && map.get(k).hint === KEY_A.slice(-4));
  const kB = [...map.keys()].find((k) => k.startsWith("kv:u:") && k.endsWith(":secret:wallex") && map.get(k) && map.get(k).hint === KEY_B.slice(-4));
  assert.ok(kA && kB && kA !== kB);
  const savedB = structuredClone(map.get(kB)); map.set(kB, structuredClone(map.get(kA)));
  // کاربر B با محیط تازه (کش حافظه خالی) نباید کلید A را بخواند
  const env2 = { ...env }; const res = await worker.fetch(new Request("http://x/api/session/check", { headers: { Authorization: "Bearer " + B } }), env2, ctx);
  const j = await res.json(); assert.equal(j.data.exchangeKeyConfigured, false); assert.equal(j.data.keyUnreadable, true);
  map.set(kB, savedB);
});
test("توکن دست‌کاری‌شده یا قدیمی رد می‌شود", async () => {
  const p = A.split("."); const forged = [p[0], p[1], B.split(".")[2], p[3]].join(".");
  assert.equal((await call("/api/wallets", { token: forged })).status, 401);
  assert.equal((await call("/api/wallets", { token: p.slice(0, 3).join(".") })).status, 401);
  assert.equal((await call("/api/wallets")).status, 401);
});
test("قطع اتصال یک کاربر روی دیگری اثر ندارد و ورود با رمز ثابت حذف شده", async () => {
  assert.equal((await call("/api/disconnect", { token: B, body: {} })).status, 200);
  assert.equal((await call("/api/session/check", { token: B })).json.data.exchangeKeyConfigured, false);
  assert.equal((await call("/api/wallets", { token: A })).status, 200);
  assert.equal((await call("/api/session", { body: { passcode: "x" } })).status, 403);
});
test("فهرست کاربران دارای کلید برای موتور پس‌زمینه درست نگه داشته می‌شود", async () => {
  const ids = (await durable.fetch(new Request("https://s/idx/list", { method: "POST", body: JSON.stringify({ name: "keyed" }) })).then((r) => r.json())).ids;
  assert.equal(ids.length, 1);
  await worker.engineTick({}, env, ctx); await worker.scheduled({}, env, ctx);
});

// ---------------------------------------------------------------------------------
// تست‌های تکمیلی: ثبت‌نام fail-closed، رمز ثابت، راه‌اندازی مجدد، چرخش راز، محدودیت نرخ، بازنشانی رمز، ایمنی معاملات
// ---------------------------------------------------------------------------------
const wait = () => new Promise((r) => setTimeout(r, 5));
const clearOtpCooldown = (phone) => map.delete("kv:auth:otp:" + phone); // فقط در تست: عبور از کولداون ۶۰ثانیه‌ای

test("ثبت‌نام به‌صورت پیش‌فرض بسته است (fail-closed) و فقط با تنظیم صریح عمومی می‌شود", async () => {
  curEnv = { ...env, REGISTRATION_MODE: undefined, ALLOWED_PHONES: "" };
  const r = await call("/api/auth/otp/send", { body: { phone: "09124444444" } });
  assert.equal(r.status, 503); assert.equal(r.json.error.code, "NOT_CONFIGURED");
  // حالت دعوت‌نامه‌ای: شماره‌ی غیرمجاز همان پاسخ را می‌گیرد ولی هیچ کدی صادر نمی‌شود
  curEnv = { ...env, REGISTRATION_MODE: "invite", ALLOWED_PHONES: "09125555555" };
  delete otps["09126666666"];
  const x = await call("/api/auth/otp/send", { body: { phone: "09126666666" } });
  assert.equal(x.status, 200); assert.equal(x.json.data.sent, true); assert.equal(otps["09126666666"], undefined);
  const y = await call("/api/auth/otp/send", { body: { phone: "09125555555" } });
  assert.equal(y.status, 200); assert.ok(otps["09125555555"]);
  curEnv = env;
});
test("ورود با رمز ثابت همیشه ۴۰۳ است و نشست صادر نمی‌کند", async () => {
  for (const b of [{ passcode: "x" }, {}, { passcode: process.env.DASHBOARD_PASSCODE || "demo" }]) {
    const r = await call("/api/session", { body: b });
    assert.equal(r.status, 403); assert.equal(r.json.error.code, "PASSCODE_LOGIN_DISABLED"); assert.equal(r.json.data, undefined);
  }
});
test("بدون نشست همه‌ی مسیرهای حساس ۴۰۱ می‌دهند", async () => {
  for (const [path, body] of [["/api/wallets"], ["/api/portfolio"], ["/api/profile"], ["/api/orders/open"], ["/api/trade/config"], ["/api/connect", { apiKey: KEY_A }], ["/api/disconnect", {}], ["/api/trade/preview", {}], ["/api/trade/submit", {}]]) {
    const r = await call(path, { body }); assert.equal(r.status, 401, path); assert.equal(r.json.error.code, "SESSION_INVALID");
  }
  const exp = Math.floor(Date.now() / 1000) - 10; // توکن منقضی با امضای معتبر نباید پذیرفته شود
  const p = A.split("."); assert.equal((await call("/api/wallets", { token: [exp, p[1], p[2], p[3]].join(".") })).status, 401);
});
test("پس از راه‌اندازی مجدد (حافظه‌ی خالی) کلید رمزشده بازیابی می‌شود", async () => {
  curEnv = { ...env }; // شیء env جدید = حافظه‌ی درون‌فرایندی خالی، ولی ذخیره‌سازی همان است
  const r = await call("/api/wallets", { token: A }); assert.equal(r.status, 200); assert.deepEqual(r.json.data.map((x) => x.coinId), ["btc"]);
  curEnv = env;
});
test("تغییر راز رمزنگاری کلید را غیرقابل‌خواندن اعلام می‌کند، نه معتبر", async () => {
  curEnv = { ...env, VAULT_SECRET: "x".repeat(40) };
  const c = (await call("/api/session/check", { token: A })).json.data;
  assert.equal(c.exchangeKeyConfigured, false); assert.equal(c.keyUnreadable, true);
  assert.equal((await call("/api/wallets", { token: A })).status, 503);
  curEnv = env;
  assert.equal((await call("/api/wallets", { token: A })).status, 200); // با راز درست دوباره خوانده می‌شود
});
test("پیام خطا و پاسخ‌ها کلید را فاش نمی‌کنند", async () => {
  const leak = "WLX-LEAK-TEST-0000-ZZZZ";
  const r = await call("/api/connect", { token: C, body: { apiKey: leak } });
  assert.equal(r.status, 400); assert.ok(!JSON.stringify(r.json).includes(leak));
});
test("محدودیت نرخ ورود: پس از ۵ رمز غلط، تلاش بعدی ۴۲۹ است", async () => {
  const phone = "09121111111"; clearOtpCooldown(phone);
  await call("/api/auth/otp/send", { body: { phone } });
  const v = await call("/api/auth/otp/verify", { body: { phone, code: otps[phone] } }); const ot = v.json.data.otpToken;
  for (let i = 0; i < 5; i++) assert.equal((await call("/api/auth/login", { body: { phone, otpToken: ot, password: "wrong-password-" + i } })).status, 401);
  const blocked = await call("/api/auth/login", { body: { phone, otpToken: ot, password: "Str0ng-pass-" + phone } });
  assert.equal(blocked.status, 429); assert.equal(blocked.json.error.code, "TOO_MANY_ATTEMPTS");
});
test("درخواست مجدد OTP پیش از پایان کولداون ۴۲۹ می‌شود", async () => {
  const phone = "09127777777"; await call("/api/auth/otp/send", { body: { phone } });
  const again = await call("/api/auth/otp/send", { body: { phone } }); assert.equal(again.status, 429); assert.equal(again.json.error.code, "OTP_COOLDOWN");
});
test("بازنشانی رمز: رمز قدیم باطل و رمز جدید معتبر می‌شود (فقط با ALLOW_PASSWORD_RESET)", async () => {
  const phone = "09123333333";
  const off = await call("/api/auth/reset", { body: { phone, otpToken: "x", password: "New-Str0ng-pass" } }); assert.equal(off.status, 403);
  curEnv = { ...env, ALLOW_PASSWORD_RESET: "true" }; clearOtpCooldown(phone);
  await call("/api/auth/otp/send", { body: { phone } });
  const v = await call("/api/auth/otp/verify", { body: { phone, code: otps[phone] } }); assert.equal(v.json.data.resetAllowed, true);
  const rs = await call("/api/auth/reset", { body: { phone, otpToken: v.json.data.otpToken, password: "New-Str0ng-pass-1" } });
  assert.equal(rs.status, 200); assert.ok(rs.json.data.token);
  clearOtpCooldown(phone); await call("/api/auth/otp/send", { body: { phone } });
  const v2 = await call("/api/auth/otp/verify", { body: { phone, code: otps[phone] } });
  assert.equal((await call("/api/auth/login", { body: { phone, otpToken: v2.json.data.otpToken, password: "Str0ng-pass-" + phone } })).status, 401);
  assert.equal((await call("/api/auth/login", { body: { phone, otpToken: v2.json.data.otpToken, password: "New-Str0ng-pass-1" } })).status, 200);
  curEnv = env;
});
test("معاملات: به‌طور پیش‌فرض غیرفعال‌اند و هیچ سفارشی به والکس نمی‌رسد", async () => {
  const cfg = (await call("/api/trade/config", { token: A })).json.data; assert.equal(cfg.tradingEnabled, false);
  const pv = (await call("/api/trade/preview", { token: A, body: { order: { coinId: "btc", side: "buy", execution: "market", amount: 1 } } })).json.data;
  assert.equal(pv.tradingEnabled, false); assert.ok(pv.disabledReasons.includes("TRADING_DISABLED")); assert.equal(pv.confirmToken, undefined);
  const sub = await call("/api/trade/submit", { token: A, body: { order: { coinId: "btc", side: "buy", execution: "market", amount: 1 }, clientOrderId: "dabcdefgh1234", confirmToken: "1.x" } });
  assert.equal(sub.status, 403); assert.equal(sub.json.error.code, "TRADING_DISABLED"); assert.equal(sent.orders, 0);
});
test("معاملات (شبیه‌سازی‌شده): سقف مبلغ، تأیید دوگانه، جلوگیری از سفارش تکراری و جداسازی کاربران", async () => {
  curEnv = { ...env, TRADING_ENABLED: "true", MAX_ORDER_VALUE_IRT: "1000" };
  assert.equal((await call("/api/connect", { token: B, body: { apiKey: KEY_B } })).status, 200);
  const order = { coinId: "btc", side: "buy", execution: "market", amount: 1 };
  const over = await call("/api/trade/preview", { token: A, body: { order: { ...order, amount: 100000 } } }); assert.equal(over.status, 400); assert.equal(over.json.error.code, "ORDER_OVER_CAP");
  const pv = (await call("/api/trade/preview", { token: A, body: { order } })).json.data; assert.ok(pv.confirmToken);
  // توکن تأییدِ کاربر A روی کاربر B کار نمی‌کند
  const steal = await call("/api/trade/submit", { token: B, body: { order: pv.order, clientOrderId: pv.clientOrderId, confirmToken: pv.confirmToken } });
  assert.equal(steal.status, 400); assert.equal(steal.json.error.code, "CONFIRM_INVALID"); assert.equal(sent.orders, 0);
  const ok1 = await call("/api/trade/submit", { token: A, body: { order: pv.order, clientOrderId: pv.clientOrderId, confirmToken: pv.confirmToken } });
  assert.equal(ok1.status, 200); assert.equal(sent.orders, 1);
  const dup = await call("/api/trade/submit", { token: A, body: { order: pv.order, clientOrderId: pv.clientOrderId, confirmToken: pv.confirmToken } });
  assert.equal(dup.status, 409); assert.equal(dup.json.error.code, "DUPLICATE_ORDER"); assert.equal(sent.orders, 1); // سفارش دوباره ارسال نشد
  curEnv = env;
});
test("موتور خودکار: بدون AUTO_TRADING_ENABLED حالت live قفل است و تیک سفارشی نمی‌فرستد", async () => {
  const before = sent.orders;
  await worker.engineTick({}, env, ctx); await wait();
  assert.equal(sent.orders, before);
  assert.deepEqual([...sent.hosts].filter((h) => h !== "api.wallex.ir"), []); // هیچ میزبان بیرونی
});
