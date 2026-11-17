// حذف حالت آزمایشی (Paper): مهاجرت داده‌ی قدیمی و رد کردن حالت paper
import test from "node:test";
import assert from "node:assert/strict";
import { createTrading } from "../src/trading.js";

class HttpError extends Error { constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; this.extra = extra; } }
function mk(seed = {}) {
  const m = new Map(Object.entries(seed));
  const kv = { get: async (k) => (m.has(k) ? structuredClone(m.get(k)) : null), put: async (k, v) => { m.set(k, structuredClone(v)); } };
  const coins = [{ id: "btc", name: "بیت‌کوین" }, { id: "eth", name: "اتریوم" }, { id: "usdt", name: "تتر" }];
  const t = createTrading({ env: { AUTO_TRADING_ENABLED: "true", TRADING_ENABLED: "true" }, HttpError, kv, coins, tmnSymbol: (id) => id.toUpperCase() + "TMN",
    priceOf: () => ({ price: 1000, source: "last" }), num: Number, decimalStr: (n, d) => Number(n).toFixed(d), tradingState: () => ({ enabled: true, reasons: [], cap: 1000000 }),
    getMarkets: async () => ({ sym: {}, stale: false, t: Date.now() }), fetchOhlc: async () => { throw new Error("n/a"); }, getBalances: async () => [{ cur: "tmn", available: 5e6 }], placeLiveOrder: async () => { throw new Error("n/a"); }, hasApiKey: () => true });
  return { t, m };
}
const paperTrade = { id: "tpaper1", mode: "paper", status: "open", coinId: "btc", symbol: "BTC/IRT", entry: { qty: "0.1", costIrt: 1000, feeIrt: 2 }, openedAt: new Date().toISOString() };
const liveClosed = { id: "tlive1", mode: "live", status: "closed", coinId: "eth", symbol: "ETH/IRT", entry: { qty: "1", costIrt: 1000, feeIrt: 2 }, exit: { feeIrt: 2 }, pnlIrt: 50, pnlPct: 5, closedAt: new Date().toISOString(), exitReason: "take_profit", openedAt: new Date().toISOString() };

test("داده‌ی قدیمی paper پاک می‌شود، حالت به «تحلیل و پیشنهاد» برمی‌گردد و معاملات واقعی حفظ می‌شوند", async () => {
  const { t, m } = mk({ "eng:ctl": { mode: "paper", running: true, killed: false, liveConfirmedAt: null }, "eng:trades": [paperTrade, liveClosed], "eng:signals": [{ id: "s1", mode: "paper", coinId: "btc" }, { id: "s2", mode: "suggest", coinId: "btc" }] });
  const st = await t.handle("GET", "/status", new URLSearchParams(), null);
  assert.equal(st.mode, "suggest"); assert.equal(st.running, true);
  assert.deepEqual(m.get("eng:trades").map((x) => x.id), ["tlive1"]); assert.deepEqual(m.get("eng:signals").map((x) => x.id), ["s2"]);
  assert.ok(m.get("eng:events").some((e) => e.type === "paper_removed"));
  assert.ok(!("paperCashIrt" in st.pnl));
});

test("حالت paper رد می‌شود؛ فقط suggest و live معتبرند؛ live بدون تأیید صریح رد می‌شود", async () => {
  const { t } = mk();
  await assert.rejects(() => t.handle("POST", "/mode", new URLSearchParams(), { mode: "paper" }), (e) => e.code === "INVALID_MODE");
  await assert.rejects(() => t.handle("POST", "/mode", new URLSearchParams(), { mode: "live" }), (e) => e.code === "CONFIRM_REQUIRED");
  const ok = await t.handle("POST", "/mode", new URLSearchParams(), { mode: "live", confirm: t.LIVE_CONFIRM_PHRASE, ack: true }); assert.equal(ok.mode, "live");
});

test("گزارش عملکرد فقط واقعی است و فید پس از مهاجرت خطا نمی‌دهد", async () => {
  const { t } = mk({ "eng:trades": [liveClosed] });
  const perf = await t.handle("GET", "/performance", new URLSearchParams(), null); assert.deepEqual(Object.keys(perf), ["live"]); assert.equal(perf.live.closedTrades, 1);
  assert.ok((await t.handle("GET", "/feed", new URLSearchParams(), null)).messages);
});
