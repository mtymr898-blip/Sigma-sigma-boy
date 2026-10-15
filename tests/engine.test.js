// اجرا: node --test tests/      (بدون هیچ وابستگی)
// توجه: داده‌های این فایل ساختگی‌اند و فقط «درستی منطق» را می‌سنجند؛ هیچ ادعایی درباره‌ی سودآوری ندارند.
import test from "node:test";
import assert from "node:assert/strict";
import { walk } from "./helpers.js";
import { emaSeries, rsiSeries, atrSeries, smaSeries, validateSettings, DEFAULT_SETTINGS, evaluateRisk, analyzeCandles, evaluateSignalOutcome, backtest, TF_MS } from "../src/engine.js";

const H = 3600000;
const mk = (n, f, t0 = Date.UTC(2026, 0, 1)) => Array.from({ length: n }, (_, i) => { const c = f(i); return { t: t0 + i * H, o: c, h: c * 1.004, l: c * 0.996, c, v: 100 }; });

test("EMA: مقدار اولیه SMA و هموارسازی درست", () => {
  const e = emaSeries([1, 2, 3, 4, 5], 3);
  assert.deepEqual(e.slice(0, 2), [null, null]);
  assert.equal(e[2], 2);
  assert.equal(e[3], 3); // k=0.5: 4*.5+2*.5
  assert.equal(e[4], 4);
});
test("SMA", () => assert.deepEqual(smaSeries([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5]));
test("RSI: روند کاملاً صعودی = ۱۰۰، کاملاً نزولی = ۰، ثابت = ۵۰", () => {
  const up = rsiSeries(Array.from({ length: 30 }, (_, i) => 100 + i), 14);
  const dn = rsiSeries(Array.from({ length: 30 }, (_, i) => 100 - i), 14);
  const flat = rsiSeries(Array(30).fill(100), 14);
  assert.equal(up[29], 100); assert.equal(dn[29], 0); assert.equal(flat[29], 50);
});
test("ATR: دامنه‌ی ثابت ۲ → ATR=2", () => {
  const c = Array.from({ length: 20 }, () => ({ o: 10, h: 11, l: 9, c: 10, v: 1 }));
  const a = atrSeries(c, 14); assert.ok(Math.abs(a[19] - 2) < 1e-9);
});

test("اعتبارسنجی تنظیمات: مرزها، کلید ناشناخته، سقف سرور، نسبت سود به زیان", () => {
  const ctx = { allowedCoins: ["btc", "eth"], envCapIrt: 500_000 };
  assert.equal(validateSettings({}, ctx).ok, true);
  assert.equal(validateSettings({ maxOrderIrt: 900_000, capitalIrt: 2_000_000 }, ctx).ok, false); // بالاتر از سقف سرور
  assert.equal(validateSettings({ foo: 1 }, ctx).ok, false);
  assert.equal(validateSettings({ coins: ["doge"] }, ctx).ok, false);
  assert.equal(validateSettings({ maxDrawdownPct: 99 }, ctx).ok, false);
  assert.equal(validateSettings({ timeframe: "5m" }, ctx).ok, false);
  assert.equal(validateSettings({ takeProfitAtrMult: 1, stopAtrMult: 2 }, ctx).ok, false); // RR=0.5 < minRR
  assert.equal(validateSettings({ params: { emaFast: 60, emaSlow: 50 } }, ctx).ok, false);
  assert.equal(validateSettings({ maxOrderIrt: "abc" }, ctx).ok, false);
});

const baseRisk = () => ({
  kind: "entry", mode: "paper", settings: { ...DEFAULT_SETTINGS }, coinId: "btc", liveUnlocked: false, keyConfigured: true, killed: false, running: true,
  price: { value: 100, stale: false, ageSec: 1 }, order: { qty: "1", qtyStr: "1", estimateIrt: 100_000, step: 5, minQty: 0.0001, minNotional: 10_000 },
  balance: { availableIrt: 1_000_000, availableCoin: 0 }, openTrades: 0, exposureIrt: 0, dailyLossIrt: 0, drawdownPct: 0, duplicate: { exists: false, unknownState: false },
});
const codes = (r) => r.failures.map((f) => f.code);

test("ریسک: حالت عادی مجاز است", () => assert.equal(evaluateRisk(baseRisk()).ok, true));
test("ریسک: هر یک از ۱۲ بررسی به‌تنهایی سفارش را رد می‌کند", () => {
  const cases = [
    ["LIVE_NOT_ENABLED", (c) => { c.mode = "live"; c.liveUnlocked = false; }],
    ["NO_ACCOUNT", (c) => { c.mode = "live"; c.liveUnlocked = true; c.keyConfigured = false; }],
    ["STALE_PRICE", (c) => { c.price.stale = true; }],
    ["NO_PRICE", (c) => { c.price.value = 0; }],
    ["SYMBOL_NOT_ALLOWED", (c) => { c.coinId = "sol"; }],
    ["INSUFFICIENT_BALANCE", (c) => { c.balance.availableIrt = 10; }],
    ["ORDER_OVER_CAP", (c) => { c.order.estimateIrt = 600_000; c.balance.availableIrt = 9e9; }],
    ["MAX_OPEN_TRADES", (c) => { c.openTrades = 2; }],
    ["MAX_EXPOSURE", (c) => { c.exposureIrt = 950_000; }],
    ["DAILY_LOSS_LIMIT", (c) => { c.dailyLossIrt = 100_000; }],
    ["MAX_DRAWDOWN", (c) => { c.drawdownPct = 10; }],
    ["DUPLICATE_ORDER", (c) => { c.duplicate.exists = true; }],
    ["UNKNOWN_ORDER_STATE", (c) => { c.duplicate.unknownState = true; }],
    ["BELOW_MIN_QTY", (c) => { c.order.qty = "0.00001"; c.order.qtyStr = "0.00001"; }],
    ["BELOW_MIN_NOTIONAL", (c) => { c.order.estimateIrt = 5_000; }],
    ["BAD_PRECISION", (c) => { c.order.qtyStr = "0.1234567"; c.order.qty = "0.1234567"; c.order.step = 5; }],
    ["KILL_SWITCH", (c) => { c.killed = true; }],
    ["ENGINE_NOT_RUNNING", (c) => { c.running = false; }],
  ];
  for (const [code, mutate] of cases) { const c = baseRisk(); mutate(c); const r = evaluateRisk(c); assert.equal(r.ok, false, code); assert.ok(codes(r).includes(code), `${code} ← ${codes(r)}`); }
});
test("ریسک: خروج با وجود توقف اضطراری و سقف مبلغ مجاز است (کاهش ریسک)", () => {
  const c = baseRisk(); c.kind = "exit"; c.killed = true; c.running = false; c.order.estimateIrt = 9_000_000; c.balance = { availableCoin: 1 }; c.dailyLossIrt = 9e9;
  assert.equal(evaluateRisk(c).ok, true);
});

// کندل‌های صعودی با یک اصلاح و بازگشت (باید سیگنال خرید بدهد)
function bullishPullback() {
  const t0 = Date.UTC(2026, 0, 1);
  const closes = [];
  for (let i = 0; i < 120; i++) closes.push(1000 + i * 2 + Math.sin(i / 3) * 3);
  // اصلاح کوتاه زیر EMA کوتاه و بازگشت در چند کندل آخر
  for (let i = 0; i < 4; i++) closes.push(closes[closes.length - 1] - 6);
  for (let i = 0; i < 2; i++) closes.push(closes[closes.length - 1] + 14);
  return closes.map((c, i) => ({ t: t0 + i * H, o: c - 1, h: c + 3, l: c - 3, c, v: 100 }));
}
test("استراتژی: داده‌ی ناکافی یا کهنه → عدم معامله با دلیل", () => {
  const few = mk(20, (i) => 100 + i);
  const r = analyzeCandles(few, { hasOhlc: true, hasVolume: true }, DEFAULT_SETTINGS, { nowMs: few[19].t + 2 * H });
  assert.equal(r.signal, "none"); assert.equal(r.dataQuality.ok, false);
  const old = bullishPullback();
  const r2 = analyzeCandles(old, { hasOhlc: true, hasVolume: true }, DEFAULT_SETTINGS, { nowMs: old[old.length - 1].t + 30 * H });
  assert.equal(r2.dataQuality.ok, false); assert.equal(r2.signal, "none");
});
test("استراتژی: کندل در حال تشکیل هرگز استفاده نمی‌شود", () => {
  const c = bullishPullback(); const last = c[c.length - 1];
  const r = analyzeCandles(c, { hasOhlc: true, hasVolume: true }, DEFAULT_SETTINGS, { nowMs: last.t + 10 * 60000 }); // کندل آخر هنوز بسته نشده
  assert.equal(r.candleT, c[c.length - 2].t);
});
test("استراتژی: روی داده‌ی ساختگی سیگنال خرید کامل و معتبر تولید می‌شود", () => {
  const c = walk(1500, 0.0006, 0.012, 42); let found = null;
  for (let k = 100; k < c.length && !found; k++) { const part = c.slice(0, k); const r = analyzeCandles(part, { hasOhlc: true, hasVolume: true }, DEFAULT_SETTINGS, { nowMs: part[k - 1].t + H }); if (r.signal === "buy") found = r; }
  assert.ok(found, "باید حداقل یک سیگنال خرید پیدا شود");
  assert.ok(found.stop < found.entry && found.takeProfit > found.entry); assert.ok(found.rr >= DEFAULT_SETTINGS.minRR);
  assert.ok(found.reasons.length > 0); assert.ok(found.score >= 0 && found.score <= 100); assert.match(found.scoreNote, /احتمال واقعی/);
  assert.equal(found.dataQuality.ok, true); assert.ok(found.riskPct > 0);
});
test("بک‌تست: روی گام تصادفی معامله می‌سازد و بخش‌های درون/بیرون نمونه دارد", () => {
  const r = backtest(walk(2000, 0, 0.012, 7), { hasOhlc: true, hasVolume: true }, DEFAULT_SETTINGS);
  assert.ok(r.all.trades > 10); assert.equal(r.inSample.trades + r.outOfSample.trades, r.all.trades); assert.ok(Number.isFinite(r.buyAndHold.allPct));
});
test("استراتژی: روند نزولی هرگز سیگنال خرید نمی‌دهد", () => {
  const c = mk(150, (i) => 2000 - i * 3); const r = analyzeCandles(c, { hasOhlc: true, hasVolume: true }, DEFAULT_SETTINGS, { nowMs: c[149].t + H });
  assert.notEqual(r.signal, "buy"); assert.equal(r.trend, "down");
});
test("استراتژی: در موقعیت باز و روند نزولی → سیگنال فروش", () => {
  const c = mk(150, (i) => 2000 - i * 3); const r = analyzeCandles(c, { hasOhlc: true, hasVolume: true }, DEFAULT_SETTINGS, { holding: true, nowMs: c[149].t + H });
  assert.equal(r.signal, "sell");
});
test("نتیجه‌ی سیگنال: اگر حد ضرر و حد سود هم‌زمان لمس شوند، محافظه‌کارانه ضرر", () => {
  const sig = { signal: "buy", candleT: 0, entry: 100, stop: 95, takeProfit: 110 };
  const o = evaluateSignalOutcome(sig, [{ t: H, o: 100, h: 112, l: 94, c: 100, v: 1 }], H, 48);
  assert.equal(o.status, "stop");
});

test("بک‌تست: بدون نگاه به آینده — ورود در open کندل بعد؛ ضرر و سود با کارمزد و لغزش", () => {
  // بازار سینوسی: چند معامله می‌سازد؛ فقط ساختار/ثبات خروجی و اجزای هزینه بررسی می‌شود
  const c = mk(900, (i) => 1000 + Math.sin(i / 25) * 120 + i * 0.3);
  const r = backtest(c, { hasOhlc: true, hasVolume: true }, { ...DEFAULT_SETTINGS });
  assert.equal(r.ok, true);
  for (const t of r.trades) { assert.ok(t.exitIdx >= t.entryIdx); assert.ok(Number.isFinite(t.retPct)); }
  assert.ok(r.assumptions.length >= 3);
  // هزینه همیشه اثر منفی دارد: با کارمزد بالاتر نتیجه بهتر نمی‌شود
  const hi = backtest(c, { hasOhlc: true, hasVolume: true }, { ...DEFAULT_SETTINGS, feePct: 1.5, slippagePct: 1 });
  assert.ok(hi.all.netReturnPct <= r.all.netReturnPct + 1e-9);
});
test("بک‌تست: داده‌ی ناکافی با خطای شفاف", () => {
  const r = backtest(mk(40, (i) => 100 + i), { hasOhlc: true }, DEFAULT_SETTINGS); assert.equal(r.ok, false); assert.match(r.error, /کافی نیست/);
});
test("بک‌تست: نبود OHLC هشدار می‌دهد", () => {
  const r = backtest(mk(400, (i) => 1000 + Math.sin(i / 20) * 100), { hasOhlc: false, hasVolume: false }, DEFAULT_SETTINGS);
  assert.ok(r.warnings.some((w) => /high\/low/.test(w)));
});
test("TF_MS", () => assert.equal(TF_MS["4h"], 4 * H));
