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

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url)); const key = (init.headers || {})["X-API-Key"];
  const json = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { "Content-Type": "application/json" } });
  if (u.pathname === "/v1/markets") return json({ success: true, result: MARKETS });
  if (u.pathname === "/v1/account/balances") return BAL[key] ? json({ success: true, result: { balances: BAL[key] } }) : json({ success: false, message: "bad key" }, 401);
  if (u.pathname === "/v1/account/openOrders") return BAL[key] ? json({ success: true, result: { orders: [] } }) : json({}, 401);
  return json({ success: false }, 404);
};

const map = new Map();
const storage = { get: async (k) => (map.has(k) ? structuredClone(map.get(k)) : undefined), put: async (k, v) => { map.set(k, structuredClone(v)); }, delete: async (k) => map.delete(k) };
const durable = new DashboardStore({ storage });
let chain = Promise.resolve();
const STORE = { idFromName: (n) => n, get: () => ({ fetch: (url, init) => { const p = chain.then(() => durable.fetch(new Request(url, init))); chain = p.catch(() => {}); return p; } }) };
const env = { SESSION_SECRET: "s".repeat(40), VAULT_SECRET: "v".repeat(40), SMS_PROVIDER: "console", PBKDF2_ITER: "1000", UPSTREAM_GAP_MS: "0", STORE, ASSETS: { fetch: () => new Response("x") } };
const ctx = { waitUntil: () => {} };

let ipN = 0;
async function call(path, { token, body, method } = {}) {
  const headers = { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0." + (ipN++ % 200) };
  if (token) headers.Authorization = "Bearer " + token;
  const res = await worker.fetch(new Request("http://x" + path, { method: method || (body ? "POST" : "GET"), headers, body: body ? JSON.stringify(body) : undefined }), env, ctx);
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
  assert.equal((await call("/api/session", { body: { passcode: "x" } })).status, 401);
});
test("فهرست کاربران دارای کلید برای موتور پس‌زمینه درست نگه داشته می‌شود", async () => {
  const ids = (await durable.fetch(new Request("https://s/idx/list", { method: "POST", body: JSON.stringify({ name: "keyed" }) })).then((r) => r.json())).ids;
  assert.equal(ids.length, 1);
  await worker.engineTick({}, env, ctx); await worker.scheduled({}, env, ctx);
});
