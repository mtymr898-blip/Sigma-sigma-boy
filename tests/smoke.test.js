// تست یکپارچه: worker.js واقعی + DashboardStore واقعی، با والکس «جعلی» (fetch جایگزین شده).
// هیچ درخواستی به شبکه‌ی واقعی نمی‌رود و هیچ سفارش واقعی‌ای ثبت نمی‌شود.
import test from "node:test";
import assert from "node:assert/strict";
import worker, { DashboardStore } from "../src/worker.js";
import { analyzeCandles, DEFAULT_SETTINGS } from "../src/engine.js";
import { walk } from "./helpers.js";

const H = 3600000;
const series = walk(1500, 0.0006, 0.012, 42);
let K = 0;
for (let k = 100; k < series.length; k++) { const p = series.slice(0, k); if (analyzeCandles(p, { hasOhlc: true, hasVolume: true }, DEFAULT_SETTINGS, { nowMs: p[k - 1].t + H }).signal === "buy") { K = k; break; } }
assert.ok(K > 0);

// ساعت مجازی: memo/زمان‌بندی worker از Date.now استفاده می‌کنند
const realNow = Date.now;
let vnow = Math.floor(realNow() / H) * H + 5 * 60000; // ۵ دقیقه بعد از ابتدای یک ساعت
Date.now = () => vnow;
const advance = (ms) => { vnow += ms; };

// ---------- والکس جعلی ----------
const mock = { price: series[K - 1].c, posts: [], orders: new Map(), balances: { TMN: 5_000_000, BTC: 1000 }, failOrders: false };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url)); if (u.hostname !== "api.wallex.ir") throw new Error("شبکه‌ی واقعی در تست مجاز نیست: " + u.hostname);
  const p = u.pathname; const method = (init.method || "GET").toUpperCase();
  if (p === "/v1/markets") return json({ success: true, result: { symbols: { BTCTMN: { stats: { lastPrice: String(mock.price), bidPrice: String(mock.price * 0.9995), askPrice: String(mock.price * 1.0005), "24h_ch": 1, "24h_volume": 5 }, stepSize: 6, tickSize: 0, minQty: 0.00001, minNotional: 10000 } } } });
  if (p === "/v1/udf/history") {
    const base = Math.floor(vnow / H) * H - H; // آخرین کندل بسته‌شده
    const part = series.slice(0, K); const off = base - part[part.length - 1].t;
    return json({ s: "ok", t: part.map((c) => Math.floor((c.t + off) / 1000)), o: part.map((c) => c.o), h: part.map((c) => c.h), l: part.map((c) => c.l), c: part.map((c) => c.c), v: part.map((c) => c.v) });
  }
  if (p === "/v1/account/balances") return json({ success: true, result: { balances: Object.fromEntries(Object.entries(mock.balances).map(([k, v]) => [k, { asset: k, value: String(v), locked: "0" }])) } });
  if (p === "/v1/account/orders" && method === "POST") {
    const b = JSON.parse(init.body); mock.posts.push(b);
    if (mock.failOrders) return json({ success: false, message: "rejected by test" }, 400);
    const id = "W" + mock.posts.length; mock.orders.set(id, b);
    return json({ success: true, result: { clientOrderId: id } });
  }
  const m = p.match(/^\/v1\/account\/orders\/(W\d+)$/);
  if (m) { const b = mock.orders.get(m[1]); const q = b.quantity; return json({ success: true, result: { symbol: b.symbol, type: b.type, side: b.side, status: "FILLED", active: false, clientOrderId: m[1], origQty: q, executedQty: q, executedPrice: String(mock.price * (b.side === "BUY" ? 1.0005 : 0.9995)) } }); }
  return json({ success: false, message: "not mocked: " + p }, 404);
};

// ---------- محیط ----------
class MemStorage { constructor() { this.m = new Map(); } async get(k) { const v = this.m.get(k); return v === undefined ? undefined : structuredClone(v); } async put(k, v) { this.m.set(k, structuredClone(v)); } async delete(k) { return this.m.delete(k); } }
const durable = new DashboardStore({ storage: new MemStorage() }); let chain = Promise.resolve();
const STORE = { idFromName: (n) => n, get: () => ({ fetch: (url, init) => { const p = chain.then(() => durable.fetch(new Request(url, init))); chain = p.catch(() => {}); return p; } }) };
const env = { STORE, SESSION_SECRET: "x".repeat(40), DASHBOARD_PASSCODE: "pass-123", ALLOW_PASSCODE_LOGIN: "true", WALLEX_API_KEY: "test-key", TRADING_ENABLED: "true", AUTO_TRADING_ENABLED: "true", MAX_ORDER_VALUE_IRT: "1000000", UPSTREAM_GAP_MS: "0" };
const ctx = { waitUntil() {} };
let token = null;
async function call(method, path, body, { auth = true } = {}) {
  const headers = { Accept: "application/json" }; if (body !== undefined) headers["Content-Type"] = "application/json"; if (auth && token) headers.Authorization = "Bearer " + token;
  const res = await worker.fetch(new Request("https://dash.test" + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }), env, ctx);
  return { status: res.status, body: await res.json() };
}
test.after(() => { Date.now = realNow; globalThis.fetch = realFetch; });

test("سلامت عمومی بدون نشست؛ مسیر معامله‌گری بدون نشست ۴۰۱", async () => {
  const h = await call("GET", "/api/health", undefined, { auth: false }); assert.equal(h.status, 200); assert.equal(h.body.data.status, "ok");
  const s = await call("GET", "/api/trading/status", undefined, { auth: false }); assert.equal(s.status, 401);
  const login = await call("POST", "/api/session", { passcode: "pass-123" }, { auth: false }); assert.equal(login.status, 200); token = login.body.data.token;
});

test("حالت پیشنهاد: تحلیل با داده‌ی (جعلی) والکس؛ سیگنال کامل و بدون هیچ سفارش", async () => {
  assert.equal((await call("PUT", "/api/trading/settings", { coins: ["btc"] })).status, 200);
  mock.balances.BTC = 0; // در حالت پیشنهاد «نگه‌داری» از موجودی کیف پول تشخیص داده می‌شود؛ بدون موجودی سیگنال خرید داریم
  const st = await call("GET", "/api/trading/status"); assert.equal(st.body.data.mode, "suggest"); assert.equal(st.body.data.live.serverUnlocked, true); assert.equal(st.body.data.live.confirmed, false);
  const r = await call("POST", "/api/trading/analyze", {}); assert.equal(r.status, 200);
  const sig = await call("GET", "/api/trading/signals"); const buy = sig.body.data.items.find((x) => x.signal === "buy");
  assert.ok(buy); assert.equal(buy.status, "suggested"); assert.equal(buy.dataQuality.ok, true);
  assert.equal(mock.posts.length, 0);
  const a = (await call("GET", "/api/trading/status")).body.data.analysis.btc; assert.equal(a.dataQuality.hasOhlc, true); assert.ok(a.indicators.atr > 0);
});

test("واقعی: بدون عبارت تأیید رد؛ با تأیید + شروع، تحلیل یک سفارش بازار با client_id یکتا می‌فرستد و تکرار نمی‌شود", async () => {
  mock.balances.BTC = 1000; // برای فروش بعدی
  const no = await call("POST", "/api/trading/mode", { mode: "live" }); assert.equal(no.status, 400); assert.equal(no.body.error.code, "CONFIRM_REQUIRED");
  const ok = await call("POST", "/api/trading/mode", { mode: "live", confirm: "ACTIVATE LIVE TRADING", ack: true }); assert.equal(ok.status, 200); assert.equal(ok.body.data.mode, "live");
  assert.equal((await call("POST", "/api/trading/start", {})).status, 200);
  advance(10 * 60000); await call("POST", "/api/trading/analyze", {});
  assert.equal(mock.posts.length, 1); const b = mock.posts[0];
  assert.equal(b.symbol, "BTCTMN"); assert.equal(b.type, "MARKET"); assert.equal(b.side, "BUY"); assert.match(b.client_id, /^ae[a-z0-9]{14}$/); assert.equal(b.price, undefined);
  assert.ok(Number(b.quantity) * mock.price <= 500_000 * 1.01, "سقف مبلغ هر معامله رعایت شود");
  const tr = (await call("GET", "/api/trading/trades")).body.data.items[0]; assert.equal(tr.status, "open"); assert.equal(tr.entry.verified, true); assert.equal(tr.entry.priceSource, "exchange");
  advance(10 * 60000); await call("POST", "/api/trading/analyze", {}); await worker.engineTick({}, env, ctx);
  assert.equal(mock.posts.length, 1, "سفارش خرید دوم نباید ارسال شود");
});

test("واقعی: افت قیمت به حد ضرر → engineTick سفارش فروش (isExit) ثبت و معامله با ضرر بسته می‌شود", async () => {
  const tr = (await call("GET", "/api/trading/trades")).body.data.items[0];
  mock.price = tr.stop * 0.97; advance(2 * 60000); await worker.engineTick({}, env, ctx);
  assert.equal(mock.posts.length, 2); assert.equal(mock.posts[1].side, "SELL"); assert.match(mock.posts[1].client_id, /^ax/);
  const done = (await call("GET", "/api/trading/trades")).body.data.items[0]; assert.equal(done.status, "closed"); assert.equal(done.exitReason, "stop"); assert.ok(done.pnlIrt < 0);
  const perf = (await call("GET", "/api/trading/performance")).body.data; assert.equal(perf.live.closedTrades, 1);
});

test("رگرسیون مسیر دستی قدیمی: preview → submit کار می‌کند؛ سقف مبلغ سرور هنوز اعمال می‌شود", async () => {
  mock.price = series[K - 1].c; advance(2 * 60000);
  const body = { order: { coinId: "btc", side: "buy", execution: "market", amount: "20" } };
  const pv = await call("POST", "/api/trade/preview", body); assert.equal(pv.status, 200); assert.ok(pv.body.data.confirmToken);
  const before = mock.posts.length;
  const sub = await call("POST", "/api/trade/submit", { ...body, clientOrderId: pv.body.data.clientOrderId, confirmToken: pv.body.data.confirmToken });
  assert.equal(sub.status, 200); assert.equal(sub.body.data.accepted, true); assert.equal(mock.posts.length, before + 1);
  const dup = await call("POST", "/api/trade/submit", { ...body, clientOrderId: pv.body.data.clientOrderId, confirmToken: pv.body.data.confirmToken });
  assert.equal(dup.status, 409); assert.equal(dup.body.error.code, "DUPLICATE_ORDER"); assert.equal(mock.posts.length, before + 1);
  const big = await call("POST", "/api/trade/preview", { order: { coinId: "btc", side: "buy", execution: "market", amount: "5000" } }); assert.equal(big.status, 400); assert.equal(big.body.error.code, "ORDER_OVER_CAP");
});

test("توقف اضطراری از طریق API", async () => {
  const r = await call("POST", "/api/trading/emergency-stop", { reason: "تست یکپارچه" }); assert.equal(r.status, 200); assert.equal(r.body.data.killed, true);
  const st = (await call("GET", "/api/trading/status")).body.data; assert.equal(st.killed, true); assert.equal(st.running, false); assert.equal(st.live.confirmed, false);
  const ev = (await call("GET", "/api/trading/events")).body.data.items; assert.ok(ev.some((e) => e.type === "kill_switch"));
  const bt = await call("POST", "/api/trading/backtest", { coinId: "btc", days: 30 }); assert.equal(bt.status, 200); assert.equal(bt.body.data.ok, true); assert.ok(bt.body.data.assumptions.length);
});
