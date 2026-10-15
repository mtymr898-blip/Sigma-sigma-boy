// تست‌های موتور با صرافی «جعلی» در حافظه. هیچ شبکه‌ای و هیچ سفارش واقعی‌ای در کار نیست.
import test from "node:test";
import assert from "node:assert/strict";
import { createTrading, LIVE_CONFIRM_PHRASE, hashId } from "../src/trading.js";
import { analyzeCandles, DEFAULT_SETTINGS } from "../src/engine.js";
import { walk } from "./helpers.js";

const H = 3600000;
class HttpError extends Error { constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; this.extra = extra; } }
const COINS = [{ id: "btc", name: "بیت‌کوین" }, { id: "eth", name: "اتریوم" }, { id: "usdt", name: "تتر" }];
const num = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));
const decimalStr = (n, dp = 8) => { let s = Number(n).toFixed(dp); if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, ""); return s; };
const priceOf = (m) => { const st = m && m.stats; if (!st) return null; const l = num(st.lastPrice); if (l > 0) return { price: l, source: "last" }; return null; };

// داده‌ی ثابت: یک گام تصادفی با بذر مشخص و ایندکسی که در آن سیگنال خرید داریم
const series = walk(1500, 0.0006, 0.012, 42);
function findBuy() { for (let k = 100; k < series.length; k++) { const p = series.slice(0, k); const r = analyzeCandles(p, { hasOhlc: true, hasVolume: true }, DEFAULT_SETTINGS, { nowMs: p[k - 1].t + H }); if (r.signal === "buy") return k; } throw new Error("no buy"); }
const BUY_K = findBuy();

function setup({ envExtra = {}, k = BUY_K, liveBehavior } = {}) {
  const kvMap = new Map();
  const st = { k, now: series[k - 1].t + H, price: series[k - 1].c, stale: false, calls: [], balances: { tmn: 5_000_000, btc: 0, eth: 0 }, liveBehavior: liveBehavior || "ok" };
  const env = { TRADING_ENABLED: "false", AUTO_TRADING_ENABLED: "false", MAX_ORDER_VALUE_IRT: "1000000", WALLEX_API_KEY: "", ...envExtra };
  const tradingState = () => { const reasons = []; if (env.TRADING_ENABLED !== "true") reasons.push("DISABLED"); const cap = Number(env.MAX_ORDER_VALUE_IRT); if (!(cap > 0)) reasons.push("NO_CAP"); if (!env.WALLEX_API_KEY) reasons.push("NO_TOKEN"); return { enabled: reasons.length === 0, reasons, cap: cap > 0 ? cap : null }; };
  const sym = () => ({ BTCTMN: { stats: { lastPrice: st.price, bidPrice: st.price * 0.9995, askPrice: st.price * 1.0005 }, stepSize: 6, tickSize: 0, minQty: 0.00001, minNotional: 10000 },
    ETHTMN: { stats: { lastPrice: st.price, bidPrice: st.price * 0.9995, askPrice: st.price * 1.0005 }, stepSize: 6, tickSize: 0, minQty: 0.00001, minNotional: 10000 } });
  const deps = {
    env, HttpError, hasStore: true, coins: COINS, tmnSymbol: (id) => `${id.toUpperCase()}TMN`, priceOf, num, decimalStr, tradingState, now: () => st.now,
    kv: { get: async (k2) => (kvMap.has(k2) ? structuredClone(kvMap.get(k2)) : null), put: async (k2, v) => { kvMap.set(k2, structuredClone(v)); } },
    getMarkets: async () => ({ sym: sym(), stale: st.stale, t: st.now }),
    fetchOhlc: async () => ({ candles: series.slice(0, st.k), meta: { hasOhlc: true, hasVolume: true } }),
    getBalances: async () => Object.entries(st.balances).map(([cur, v]) => ({ cur, total: v, locked: 0, available: v })),
    placeLiveOrder: async (o) => {
      st.calls.push(o);
      if (st.liveBehavior === "unknown") throw new HttpError(504, "UNKNOWN_OUTCOME", "نامشخص");
      if (st.liveBehavior === "rejected") throw new HttpError(422, "ORDER_REJECTED", "رد شد");
      if (st.liveBehavior === "unverified") return { accepted: true, orderId: "X1", clientOrderId: o.id, verified: false, fill: null };
      const px = st.price * (o.side === "buy" ? 1.0005 : 0.9995); const q = Number(o.amount);
      return { accepted: true, orderId: "W" + st.calls.length, clientOrderId: o.id, verified: true, fill: { status: "FILLED", active: false, matched: q, amount: q, execPrice: px, execSum: px * q } };
    },
  };
  kvMap.set("eng:settings", { ...DEFAULT_SETTINGS, coins: ["btc"] }); // یک ارز، تا شمارش معاملات در تست‌ها ساده بماند
  const tr = createTrading(deps);
  const api = (method, sub, body = {}, q = new URLSearchParams()) => tr.handle(method, sub, q, body);
  return { tr, api, st, env, kvMap };
}
const LIVE_ENV = { TRADING_ENABLED: "true", AUTO_TRADING_ENABLED: "true", WALLEX_API_KEY: "test-key" };
async function goLive(S) { await S.api("POST", "/mode", { mode: "live", confirm: LIVE_CONFIRM_PHRASE, ack: true }); return S.api("POST", "/start"); }

test("پیش‌فرض: حالت پیشنهاد؛ سیگنال ثبت می‌شود ولی هیچ سفارش/معامله‌ای ساخته نمی‌شود", async () => {
  const S = setup(); const status = await S.api("GET", "/status");
  assert.equal(status.mode, "suggest"); assert.equal(status.live.serverUnlocked, false);
  await S.tr.tick({ forceAnalysis: true });
  const sig = await S.api("GET", "/signals"); const buy = sig.items.find((x) => x.signal === "buy");
  assert.ok(buy, "سیگنال خرید ثبت شود"); assert.equal(buy.status, "suggested");
  assert.ok(buy.stop < buy.entry && buy.takeProfit > buy.entry && buy.reasons.length && buy.scoreNote);
  assert.equal((await S.api("GET", "/trades")).total, 0); assert.equal(S.st.calls.length, 0);
});

test("حالت واقعی: بدون تنظیمات سرور و بدون تأیید صریح قفل است", async () => {
  const S = setup();
  await assert.rejects(S.api("POST", "/mode", { mode: "live", confirm: LIVE_CONFIRM_PHRASE, ack: true }), (e) => e.code === "LIVE_LOCKED_BY_SERVER");
  const S2 = setup({ envExtra: LIVE_ENV });
  await assert.rejects(S2.api("POST", "/mode", { mode: "live" }), (e) => e.code === "CONFIRM_REQUIRED");
  await assert.rejects(S2.api("POST", "/mode", { mode: "live", confirm: "yes", ack: true }), (e) => e.code === "CONFIRM_REQUIRED");
  await assert.rejects(S2.api("POST", "/mode", { mode: "live", confirm: LIVE_CONFIRM_PHRASE }), (e) => e.code === "CONFIRM_REQUIRED");
  assert.equal(S2.st.calls.length, 0);
  // فقط یکی از دو کلید سرور کافی نیست
  const S3 = setup({ envExtra: { ...LIVE_ENV, AUTO_TRADING_ENABLED: "false" } });
  await assert.rejects(S3.api("POST", "/mode", { mode: "live", confirm: LIVE_CONFIRM_PHRASE, ack: true }), (e) => e.code === "LIVE_LOCKED_BY_SERVER");
});

test("Paper: ورود → حد سود با سود خالص مثبت (پس از کارمزد و لغزش)", async () => {
  const S = setup(); await S.api("POST", "/mode", { mode: "paper" }); await S.api("POST", "/start");
  await S.tr.tick({ forceAnalysis: true });
  const t0 = (await S.api("GET", "/trades")).items; assert.equal(t0.length, 1);
  const tr = t0[0]; assert.equal(tr.mode, "paper"); assert.equal(tr.status, "open"); assert.equal(tr.entry.priceSource, "simulated_from_real_quote"); assert.equal(S.st.calls.length, 0);
  assert.ok(tr.stop < tr.entry.price && tr.takeProfit > tr.entry.price);
  S.st.price = tr.takeProfit * 1.01; S.st.now += 60_000; await S.tr.tick();
  const done = (await S.api("GET", "/trades")).items[0];
  assert.equal(done.status, "closed"); assert.equal(done.exitReason, "take_profit"); assert.ok(done.pnlIrt > 0); assert.ok(done.exit.feeIrt > 0);
  const perf = await S.api("GET", "/performance"); assert.equal(perf.paper.closedTrades, 1); assert.equal(perf.live.closedTrades, 0);
});

test("Paper: حد ضرر اجرا می‌شود و ضرر ثبت می‌شود", async () => {
  const S = setup(); await S.api("POST", "/mode", { mode: "paper" }); await S.api("POST", "/start"); await S.tr.tick({ forceAnalysis: true });
  const tr = (await S.api("GET", "/trades")).items[0];
  S.st.price = tr.stop * 0.98; S.st.now += 60_000; await S.tr.tick();
  const done = (await S.api("GET", "/trades")).items[0]; assert.equal(done.exitReason, "stop"); assert.ok(done.pnlIrt < 0);
});

test("یک سیگنال (یک کندل) فقط یک‌بار معامله می‌سازد؛ تیک تکراری سفارش دوم نمی‌سازد", async () => {
  const S = setup(); await S.api("POST", "/mode", { mode: "paper" }); await S.api("POST", "/start");
  await S.tr.tick({ forceAnalysis: true }); S.st.now += 60_000; await S.tr.tick({ forceAnalysis: true }); await S.tr.tick({ forceAnalysis: true });
  assert.equal((await S.api("GET", "/trades")).total, 1);
});

test("Live: پس از تأیید صریح سفارش بازار با شناسه‌ی یکتا ارسال و پس از تأیید اجرا ثبت می‌شود؛ تکرار ممنوع", async () => {
  const S = setup({ envExtra: LIVE_ENV }); await goLive(S);
  await S.tr.tick({ forceAnalysis: true });
  assert.equal(S.st.calls.length, 1); const c = S.st.calls[0];
  assert.equal(c.side, "buy"); assert.match(c.id, /^ae[a-z0-9]{14}$/); assert.equal(c.isExit, false);
  const tr = (await S.api("GET", "/trades")).items[0]; assert.equal(tr.mode, "live"); assert.equal(tr.status, "open"); assert.equal(tr.entry.verified, true); assert.equal(tr.entry.priceSource, "exchange");
  S.st.now += 60_000; await S.tr.tick({ forceAnalysis: true }); await S.tr.tick({ forceAnalysis: true });
  assert.equal(S.st.calls.length, 1, "سفارش دوم نباید ارسال شود");
});

test("Live: خروج (حد ضرر) با isExit=true و بدون وابستگی به سقف مبلغ سفارش انجام می‌شود", async () => {
  const S = setup({ envExtra: LIVE_ENV }); await goLive(S); await S.tr.tick({ forceAnalysis: true });
  const tr = (await S.api("GET", "/trades")).items[0]; S.st.balances.btc = Number(tr.entry.qty);
  S.st.price = tr.stop * 0.97; S.st.now += 60_000; await S.tr.tick();
  const sell = S.st.calls.find((x) => x.side === "sell"); assert.ok(sell); assert.equal(sell.isExit, true); assert.match(sell.id, /^ax/);
  const done = (await S.api("GET", "/trades")).items[0]; assert.equal(done.status, "closed"); assert.ok(done.pnlIrt < 0);
});

test("Live: نتیجه‌ی نامشخص → معامله «نیازمند بررسی»، موتور متوقف، هیچ سفارش بعدی و تغییر حالتی ممکن نیست", async () => {
  const S = setup({ envExtra: LIVE_ENV, liveBehavior: "unknown" }); await goLive(S); await S.tr.tick({ forceAnalysis: true });
  const tr = (await S.api("GET", "/trades")).items[0]; assert.equal(tr.status, "needs_review");
  const status = await S.api("GET", "/status"); assert.equal(status.running, false); assert.equal(status.counts.needsReview, 1);
  S.st.now += 3 * H; S.st.k += 1; await S.tr.tick({ forceAnalysis: true }); assert.equal(S.st.calls.length, 1);
  await assert.rejects(S.api("POST", "/mode", { mode: "paper" }), (e) => e.code === "OPEN_POSITIONS_OTHER_MODE");
  await assert.rejects(S.api("POST", "/trades", { coinId: "btc", amountIrt: 100000, stop: 1, requestId: "abcdefgh1" }));
});

test("Live: اجرای تأییدنشده هم «نیازمند بررسی» است و به‌عنوان موفقیت ثبت نمی‌شود", async () => {
  const S = setup({ envExtra: LIVE_ENV, liveBehavior: "unverified" }); await goLive(S); await S.tr.tick({ forceAnalysis: true });
  const tr = (await S.api("GET", "/trades")).items[0]; assert.equal(tr.status, "needs_review"); assert.equal(tr.entry.verified, false);
});

test("Live: رد قطعی سفارش → هیچ معامله‌ی باز نمی‌ماند و سیگنال blocked می‌شود", async () => {
  const S = setup({ envExtra: LIVE_ENV, liveBehavior: "rejected" }); await goLive(S); await S.tr.tick({ forceAnalysis: true });
  assert.equal((await S.api("GET", "/trades")).total, 0);
  const sg = (await S.api("GET", "/signals")).items.find((x) => x.signal === "buy"); assert.equal(sg.status, "blocked");
});

test("توقف اضطراری: ورود جدید متوقف؛ حالت واقعی غیرمسلح؛ موقعیت باز ناگهانی بسته نمی‌شود؛ حد ضرر (سیاست manage) ادامه دارد", async () => {
  const S = setup({ envExtra: LIVE_ENV }); await goLive(S); await S.tr.tick({ forceAnalysis: true });
  const tr = (await S.api("GET", "/trades")).items[0]; S.st.balances.btc = Number(tr.entry.qty);
  const r = await S.api("POST", "/emergency-stop", { reason: "تست" });
  assert.equal(r.killed, true); assert.equal(r.openPositions.length, 1); assert.equal((await S.api("GET", "/trades")).items[0].status, "open");
  const s1 = await S.api("GET", "/status"); assert.equal(s1.killed, true); assert.equal(s1.running, false); assert.equal(s1.live.confirmed, false);
  await assert.rejects(S.api("POST", "/start"), (e) => e.code === "KILL_SWITCH_ACTIVE");
  S.st.now += 60_000; await S.tr.tick({ forceAnalysis: true }); assert.equal(S.st.calls.length, 1, "ورود جدید نباید باشد");
  S.st.price = tr.stop * 0.97; S.st.now += 60_000; await S.tr.tick(); // پایش حد ضرر طبق سیاست manage
  assert.equal((await S.api("GET", "/trades")).items[0].status, "closed");
  await S.api("POST", "/emergency-stop/clear", { confirm: true });
  await assert.rejects(S.api("POST", "/start"), (e) => e.code === "LIVE_NOT_CONFIRMED"); // حالت واقعی باید دوباره تأیید شود
});

test("توقف اضطراری با سیاست freeze: هیچ اقدامی روی موقعیت باز انجام نمی‌شود", async () => {
  const S = setup(); await S.api("PUT", "/settings", { onStop: "freeze" }); await S.api("POST", "/mode", { mode: "paper" }); await S.api("POST", "/start"); await S.tr.tick({ forceAnalysis: true });
  const tr = (await S.api("GET", "/trades")).items[0]; await S.api("POST", "/emergency-stop", {});
  S.st.price = tr.stop * 0.9; S.st.now += 60_000; await S.tr.tick(); assert.equal((await S.api("GET", "/trades")).items[0].status, "open");
});

test("ریسک: سقف زیان روزانه ورود جدید را مسدود می‌کند", async () => {
  const S = setup(); await S.api("PUT", "/settings", { maxDailyLossIrt: 1000 }); await S.api("POST", "/mode", { mode: "paper" }); await S.api("POST", "/start"); await S.tr.tick({ forceAnalysis: true });
  const tr = (await S.api("GET", "/trades")).items[0]; S.st.price = tr.stop * 0.98; S.st.now += 60_000; await S.tr.tick(); // ضرر > ۱۰۰۰ تومان
  const kv = S.kvMap.get("eng:trades"); assert.equal(kv[0].status, "closed");
  const r = await S.api("POST", "/trades", { coinId: "eth", amountIrt: 100000, stop: S.st.price * 0.9, requestId: "req00001" }).catch((e) => e);
  assert.equal(r.code, "RISK_BLOCKED"); assert.match(r.message, /زیان روزانه/);
});

test("سفارش هوشمند دستی: اعتبارسنجی، شناسه‌ی یکتا (idempotent) و حد ضرر/سود قابل ویرایش", async () => {
  const S = setup(); await S.api("POST", "/mode", { mode: "paper" }); await S.api("POST", "/start");
  const p = S.st.price;
  await assert.rejects(S.api("POST", "/trades", { coinId: "btc", amountIrt: 100000, stop: p * 1.1, requestId: "req00001" }), (e) => /حد ضرر/.test(e.message));
  const a = await S.api("POST", "/trades", { coinId: "btc", amountIrt: 100000, stop: p * 0.95, takeProfit: p * 1.1, requestId: "req00001" });
  assert.equal(a.trade.kind, "manual");
  await assert.rejects(S.api("POST", "/trades", { coinId: "btc", amountIrt: 100000, stop: p * 0.95, requestId: "req00001" }), (e) => e.code === "RISK_BLOCKED"); // ثبت تکراری
  const u = await S.api("POST", `/trades/${a.trade.id}/update`, { stop: p * 0.97 }); assert.ok(Math.abs(u.trade.stop - p * 0.97) < 1e-6);
  const cl = await S.api("POST", `/trades/${a.trade.id}/close`, {}); assert.equal(cl.trade.status, "closed"); assert.equal(cl.trade.exitReason, "manual");
});

test("بازیابی پس از ری‌استارت: سفارش در حال ارسال «نیازمند بررسی» می‌شود و موتور متوقف می‌ماند", async () => {
  const S = setup({ envExtra: LIVE_ENV });
  S.kvMap.set("eng:ctl", { mode: "live", running: true, killed: false, liveConfirmedAt: "2026-10-14T00:00:00.000Z" });
  S.kvMap.set("eng:trades", [{ id: "tX", mode: "live", kind: "strategy", coinId: "btc", status: "pending_entry", warnings: [], entry: { qty: "1", costIrt: 1000, feeIrt: 3 } }]);
  await S.tr.tick(); // اولین تماس پس از «بوت»
  assert.equal(S.kvMap.get("eng:trades")[0].status, "needs_review");
  assert.equal((await S.api("GET", "/status")).running, false); assert.equal(S.st.calls.length, 0);
});

test("بوت: حالت Paper/Live پس از ری‌استارت خودکار ادامه نمی‌یابد", async () => {
  const S = setup(); S.kvMap.set("eng:ctl", { mode: "paper", running: true, killed: false });
  await S.tr.tick(); assert.equal((await S.api("GET", "/status")).running, false);
});

test("قیمت کهنه: ورود مسدود می‌شود", async () => {
  const S = setup(); await S.api("POST", "/mode", { mode: "paper" }); await S.api("POST", "/start"); S.st.stale = true;
  await S.tr.tick({ forceAnalysis: true }); assert.equal((await S.api("GET", "/trades")).total, 0);
});

test("تنظیمات: اعتبارسنجی سمت سرور و سقف سرور", async () => {
  const S = setup();
  await assert.rejects(S.api("PUT", "/settings", { maxDrawdownPct: 500 }), (e) => e.code === "INVALID_SETTINGS");
  await assert.rejects(S.api("PUT", "/settings", { maxOrderIrt: 1_500_000, capitalIrt: 3_000_000, maxTotalExposureIrt: 2_000_000 }), (e) => /سقف سرور/.test(e.message));
  const ok = await S.api("PUT", "/settings", { maxOrderIrt: 300_000 }); assert.equal(ok.settings.maxOrderIrt, 300_000);
});

test("خرید دوره‌ای (DCA): فقط در حالت آزمایشی/واقعی اجرا می‌شود و از دروازه‌ی ریسک می‌گذرد", async () => {
  const S = setup(); const t0 = S.st.now;
  await S.api("PUT", "/dca", { plans: [{ coinId: "btc", amountIrt: 100000, intervalHours: 24 }] });
  S.st.now = t0 + 25 * H; await S.tr.tick(); assert.equal((await S.api("GET", "/trades")).total, 0); // حالت پیشنهاد
  await S.api("POST", "/mode", { mode: "paper" }); await S.api("POST", "/start"); S.st.now += 60_000; await S.tr.tick();
  const trades = (await S.api("GET", "/trades")).items; assert.equal(trades.length, 1); assert.equal(trades[0].kind, "dca"); assert.equal(trades[0].status, "holding");
  S.st.now += 60_000; await S.tr.tick(); assert.equal((await S.api("GET", "/trades")).total, 1, "تا موعد بعدی خرید دوم نداریم");
  const dca = await S.api("GET", "/dca"); assert.equal(dca.plans[0].runs, 1);
});

test("hashId: قطعی و مناسب client_id", () => { assert.equal(hashId("a"), hashId("a")); assert.notEqual(hashId("a"), hashId("b")); assert.match("ae" + hashId("x"), /^[A-Za-z0-9]{16}$/); });

test("فید (گفتگوی فقط‌خواندنی) در حالت پیشنهاد: پیشنهاد خرید با مقدار، دلیل، برنامه‌ی فروش و عمل «برو به خرید»", async () => {
  const S = setup(); await S.tr.tick({ forceAnalysis: true });
  const f = await S.api("GET", "/feed"); assert.equal(f.mode, "suggest");
  const m = f.messages.find((x) => x.kind === "suggestion"); assert.ok(m, "پیشنهاد خرید باید در فید باشد");
  assert.equal(m.important, true); assert.match(m.title, /پیشنهاد خرید BTC/);
  assert.equal(m.action.type, "trade"); assert.equal(m.action.side, "buy"); assert.ok(Number(m.action.qty) > 0); assert.ok(Number(m.action.price) > 0);
  assert.ok(m.action.amountIrt <= 500_000, "مبلغ از سقف هر معامله بیشتر نباشد");
  assert.ok(m.sellPlan.length >= 3 && m.sellPlan.some((x) => /حد سود/.test(x)) && m.sellPlan.some((x) => /حد ضرر/.test(x)));
  assert.ok(m.lines.some((x) => /چقدر بخرید/.test(x))); assert.ok(m.notes.some((x) => /احتمال واقعی/.test(x)));
  assert.equal(S.st.calls.length, 0);
  await assert.rejects(S.api("POST", "/feed", {}), (e) => e.code === "NOT_FOUND"); // فید فقط خواندنی است
});

test("فید: مقدار پیشنهادی به موجودی تومانی کاربر محدود می‌شود", async () => {
  const S = setup({ envExtra: { WALLEX_API_KEY: "k" } }); S.st.balances.tmn = 100_000; await S.tr.tick({ forceAnalysis: true });
  const m = (await S.api("GET", "/feed")).messages.find((x) => x.kind === "suggestion");
  assert.ok(m.action.amountIrt <= 100_000 * 0.98 + 1); assert.ok(m.notes.some((x) => /موجودی تومانی/.test(x)));
});

test("فید در حالت خودکار: گزارش خرید و فروش (با سود/زیان) و هشدارها", async () => {
  const S = setup(); await S.api("POST", "/mode", { mode: "paper" }); await S.api("POST", "/start"); await S.tr.tick({ forceAnalysis: true });
  let f = await S.api("GET", "/feed"); const open = f.messages.find((x) => x.kind === "trade_open");
  assert.ok(open); assert.match(open.title, /BTC\/IRT \(آزمایشی\)/); assert.ok(open.lines.some((x) => /حد ضرر/.test(x))); assert.ok(open.lines.some((x) => /دلیل ورود/.test(x)));
  assert.equal(f.messages.some((x) => x.kind === "suggestion"), false);
  const tr = (await S.api("GET", "/trades")).items[0]; S.st.price = tr.takeProfit * 1.01; S.st.now += 60_000; await S.tr.tick();
  f = await S.api("GET", "/feed"); const close = f.messages.find((x) => x.kind === "trade_close");
  assert.ok(close); assert.equal(close.severity, "good"); assert.match(close.title, /حد سود/); assert.ok(close.lines.some((x) => /سود\/زیان خالص/.test(x)));
  assert.ok(Date.parse(f.latestImportantAt) >= Date.parse(close.t));
});
