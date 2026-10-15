// ===================================================================
// src/engine.js — هسته‌ی خالص موتور معاملاتی (بدون شبکه، بدون دیسک)
// -------------------------------------------------------------------
// • اندیکاتورها: EMA / RSI / ATR / میانگین حجم
// • استراتژی پایه‌ی قابل‌توضیح: ema_rsi_atr_v1 (نقطه‌ی شروع فنی؛ سودآوری آن اثبات نشده)
// • دروازه‌ی مدیریت ریسک (۱۲ بررسی) — هیچ سیگنالی نمی‌تواند آن را دور بزند
// • اعتبارسنجی تنظیمات سمت سرور
// • بک‌تست کندل‌به‌کندل با کارمزد و لغزش، بدون نشت اطلاعات آینده
// همه‌ی توابع این فایل خالص‌اند و با تست خودکار پوشش داده می‌شوند.
// ===================================================================

export const TF_MS = { "1h": 3600000, "4h": 14400000 };
export const STRATEGIES = ["ema_rsi_atr_v1"];

export const DEFAULT_SETTINGS = {
  strategy: "ema_rsi_atr_v1",
  coins: ["btc", "eth"],
  timeframe: "1h",
  analysisIntervalSec: 300,       // فاصله‌ی اجرای تحلیل
  monitorIntervalSec: 30,         // فاصله‌ی پایش حد سود/ضرر موقعیت‌های باز
  maxOpenTrades: 2,
  capitalIrt: 2_000_000,          // سرمایه‌ی اختصاص‌یافته به معاملات خودکار (تومان)
  maxOrderIrt: 500_000,           // سقف هر معامله
  maxTotalExposureIrt: 1_000_000, // سقف مجموع موقعیت‌های باز
  stopAtrMult: 1.5,               // حد ضرر = ورود − ضریب × ATR
  takeProfitAtrMult: 3,           // حد سود = ورود + ضریب × ATR
  trailingStop: false,
  trailingAtrMult: 2,
  maxHoldHours: 72,
  maxDailyLossIrt: 100_000,
  maxDrawdownPct: 10,
  minRR: 1.5,
  minScore: 70,
  autoBuy: true,
  autoSell: true,
  feePct: 0.35,                   // فرض کارمزد؛ مقدار واقعی را از پنل والکس چک کنید
  slippagePct: 0.1,
  priceStaleSec: 90,
  onStop: "manage",               // manage: پایش حد سود/ضرر ادامه دارد | freeze: هیچ اقدامی انجام نشود
  params: { emaFast: 20, emaSlow: 50, rsiPeriod: 14, rsiBuyMin: 45, rsiBuyMax: 68, rsiExit: 75, atrPeriod: 14, volPeriod: 20, volMin: 0.8, crossLookback: 3 },
};

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

// ---------- اعتبارسنجی تنظیمات (سمت سرور؛ اعتبارسنجی فرانت کافی نیست) ----------
const NUM_RULES = {
  analysisIntervalSec: [60, 86400, true], monitorIntervalSec: [10, 600, true], maxOpenTrades: [1, 10, true],
  capitalIrt: [100_000, 1e12], maxOrderIrt: [50_000, 1e11], maxTotalExposureIrt: [50_000, 1e12],
  stopAtrMult: [0.5, 10], takeProfitAtrMult: [0.5, 20], trailingAtrMult: [0.5, 10], maxHoldHours: [1, 720],
  maxDailyLossIrt: [1000, 1e12], maxDrawdownPct: [0.5, 50], minRR: [0.5, 10], minScore: [0, 100],
  feePct: [0, 2], slippagePct: [0, 2], priceStaleSec: [15, 600, true],
};
const PARAM_RULES = {
  emaFast: [2, 200, true], emaSlow: [5, 400, true], rsiPeriod: [2, 50, true], rsiBuyMin: [10, 90], rsiBuyMax: [10, 95],
  rsiExit: [50, 99], atrPeriod: [2, 50, true], volPeriod: [2, 100, true], volMin: [0, 5], crossLookback: [1, 10, true],
};
const BOOL_KEYS = ["trailingStop", "autoBuy", "autoSell"];

export function validateSettings(input, { current = DEFAULT_SETTINGS, allowedCoins = [], envCapIrt = null } = {}) {
  const errors = [];
  const src = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const s = structuredClone(current);
  s.params = { ...DEFAULT_SETTINGS.params, ...(current.params || {}) };
  const known = new Set([...Object.keys(NUM_RULES), ...BOOL_KEYS, "coins", "timeframe", "onStop", "strategy", "params"]);
  for (const k of Object.keys(src)) if (!known.has(k)) errors.push(`کلید ناشناخته: ${k}`);

  for (const [k, [min, max, int]] of Object.entries(NUM_RULES)) {
    if (!(k in src)) continue;
    const v = typeof src[k] === "string" && src[k].trim() === "" ? NaN : Number(src[k]);
    if (!Number.isFinite(v) || v < min || v > max || (int && !Number.isInteger(v))) errors.push(`${k}: باید ${int ? "عدد صحیح" : "عدد"} بین ${min} و ${max} باشد.`);
    else s[k] = v;
  }
  for (const k of BOOL_KEYS) if (k in src) { if (typeof src[k] !== "boolean") errors.push(`${k}: باید true یا false باشد.`); else s[k] = src[k]; }
  if ("timeframe" in src) { if (!TF_MS[src.timeframe]) errors.push(`timeframe: فقط ${Object.keys(TF_MS).join(" / ")} مجاز است.`); else s.timeframe = src.timeframe; }
  if ("onStop" in src) { if (!["manage", "freeze"].includes(src.onStop)) errors.push("onStop: فقط manage یا freeze مجاز است."); else s.onStop = src.onStop; }
  if ("strategy" in src) { if (!STRATEGIES.includes(src.strategy)) errors.push("strategy: استراتژی ناشناخته است."); else s.strategy = src.strategy; }
  if ("coins" in src) {
    const list = Array.isArray(src.coins) ? [...new Set(src.coins.map((c) => String(c).toLowerCase()))] : null;
    if (!list || !list.length || list.length > 10) errors.push("coins: فهرست ۱ تا ۱۰ ارز لازم است.");
    else if (list.some((c) => !allowedCoins.includes(c))) errors.push(`coins: ارز غیرمجاز در فهرست (مجاز: ${allowedCoins.join(", ")}).`);
    else s.coins = list;
  }
  if ("params" in src) {
    if (!src.params || typeof src.params !== "object" || Array.isArray(src.params)) errors.push("params: باید شیء باشد.");
    else for (const [k, v0] of Object.entries(src.params)) {
      const r = PARAM_RULES[k]; if (!r) { errors.push(`params.${k}: ناشناخته است.`); continue; }
      const v = Number(v0); if (!Number.isFinite(v) || v < r[0] || v > r[1] || (r[2] && !Number.isInteger(v))) errors.push(`params.${k}: باید بین ${r[0]} و ${r[1]} باشد.`); else s.params[k] = v;
    }
  }
  if (!errors.length) {
    const P = s.params;
    if (P.emaFast >= P.emaSlow) errors.push("params: emaFast باید کوچک‌تر از emaSlow باشد.");
    if (P.rsiBuyMin >= P.rsiBuyMax) errors.push("params: rsiBuyMin باید کوچک‌تر از rsiBuyMax باشد.");
    if (s.maxOrderIrt > s.capitalIrt) errors.push("maxOrderIrt نباید از capitalIrt بیشتر باشد.");
    if (s.maxTotalExposureIrt > s.capitalIrt) errors.push("maxTotalExposureIrt نباید از capitalIrt بیشتر باشد.");
    if (s.maxOrderIrt > s.maxTotalExposureIrt) errors.push("maxOrderIrt نباید از maxTotalExposureIrt بیشتر باشد.");
    if (envCapIrt && s.maxOrderIrt > envCapIrt) errors.push(`maxOrderIrt از سقف سرور (MAX_ORDER_VALUE_IRT=${envCapIrt}) بیشتر است.`);
    if (s.takeProfitAtrMult / s.stopAtrMult < s.minRR) errors.push("نسبت حد سود به حد ضرر (ضرایب ATR) از minRR کمتر است؛ هیچ ورودی هرگز مجاز نمی‌شود.");
  }
  return { ok: errors.length === 0, settings: s, errors };
}

// ---------- اندیکاتورها ----------
export function emaSeries(values, n) {
  const out = new Array(values.length).fill(null);
  if (values.length < n) return out;
  let sum = 0; for (let i = 0; i < n; i++) sum += values[i];
  let prev = sum / n; out[n - 1] = prev; const k = 2 / (n + 1);
  for (let i = n; i < values.length; i++) { prev = values[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}
export function smaSeries(values, n) {
  const out = new Array(values.length).fill(null); let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]; if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}
// RSI با هموارسازی Wilder
export function rsiSeries(closes, n) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= n) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) g += d; else l -= d; }
  let ag = g / n, al = l / n;
  const val = () => (ag === 0 && al === 0 ? 50 : al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  out[n] = val();
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (n - 1) + Math.max(d, 0)) / n; al = (al * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = val();
  }
  return out;
}
// ATR با هموارسازی Wilder
export function atrSeries(candles, n) {
  const out = new Array(candles.length).fill(null);
  if (candles.length <= n) return out;
  const tr = candles.map((c, i) => (i === 0 ? c.h - c.l : Math.max(c.h - c.l, Math.abs(c.h - candles[i - 1].c), Math.abs(c.l - candles[i - 1].c))));
  let a = 0; for (let i = 1; i <= n; i++) a += tr[i];
  a /= n; out[n] = a;
  for (let i = n + 1; i < candles.length; i++) { a = (a * (n - 1) + tr[i]) / n; out[i] = a; }
  return out;
}

export function computeSeries(candles, P) {
  const close = candles.map((c) => c.c);
  const vol = candles.map((c) => c.v);
  const hasVolume = vol.every(isNum) && vol.some((v) => v > 0);
  return {
    close, emaF: emaSeries(close, P.emaFast), emaS: emaSeries(close, P.emaSlow), rsi: rsiSeries(close, P.rsiPeriod),
    atr: atrSeries(candles, P.atrPeriod), volSma: hasVolume ? smaSeries(vol, P.volPeriod) : candles.map(() => null), hasVolume,
  };
}

export const warmupBars = (P) => Math.max(P.emaSlow, P.rsiPeriod, P.atrPeriod, P.volPeriod) + P.crossLookback + 2;

// ---------- اعتبار داده ----------
export function assessData(candles, meta, tfMs, nowMs, minBars) {
  const issues = [];
  if (!candles.length) issues.push("هیچ کندلی دریافت نشد.");
  else {
    if (candles.length < minBars) issues.push(`داده ناکافی: ${candles.length} کندل (حداقل ${minBars} لازم است).`);
    const ageMs = nowMs - (candles[candles.length - 1].t + tfMs);
    if (ageMs > 2 * tfMs) issues.push("آخرین کندل قدیمی است (داده تازه نیست).");
    let gaps = 0; const from = Math.max(1, candles.length - minBars);
    for (let i = from; i < candles.length; i++) if (candles[i].t - candles[i - 1].t > 1.5 * tfMs) gaps++;
    if (gaps > 2) issues.push(`${gaps} فاصله‌ی زمانی در داده‌ی اخیر وجود دارد.`);
  }
  const warnings = [];
  if (meta && meta.hasOhlc === false) warnings.push("والکس فقط قیمت بسته‌شدن داد (بدون high/low)؛ ATR و بررسی داخل‌کندلی دقیق نیست.");
  if (meta && meta.hasVolume === false) warnings.push("داده‌ی حجم کندل در پاسخ والکس نبود؛ شرط حجم ارزیابی نشد.");
  return { ok: issues.length === 0, issues, warnings, bars: candles.length, lastCandleAt: candles.length ? new Date(candles[candles.length - 1].t).toISOString() : null,
    hasOhlc: !(meta && meta.hasOhlc === false), hasVolume: !(meta && meta.hasVolume === false) };
}

export const SCORE_NOTE = "امتیاز = نسبت وزنی شرایط برقرارشده‌ی قوانین استراتژی (۰ تا ۱۰۰). این عدد احتمال واقعی موفقیت نیست و از نظر آماری کالیبره نشده است.";

// ---------- ارزیابی سیگنال در یک اندیس مشخص (فقط با داده تا همان اندیس) ----------
export function evaluateAt(S, candles, i, settings, { holding = false, price = null } = {}) {
  const P = settings.params;
  const c = S.close[i], ef = S.emaF[i], es = S.emaS[i], r = S.rsi[i], a = S.atr[i];
  if (![c, ef, es, r, a].every(isNum) || a <= 0 || i < 1 || !isNum(S.emaF[i - 1]) || !isNum(S.emaS[i - 1])) return { ready: false };
  const hasVol = S.hasVolume && isNum(S.volSma[i]) && S.volSma[i] > 0;
  const volRatio = hasVol ? candles[i].v / S.volSma[i] : null;
  const trend = ef > es && c > es ? "up" : ef < es && c < es ? "down" : "sideways";
  let crossedUp = false;
  for (let k = 0; k < P.crossLookback; k++) {
    const j = i - k; if (j < 1 || !isNum(S.emaF[j - 1]) || !isNum(S.emaF[j])) break;
    if (S.close[j - 1] <= S.emaF[j - 1] && S.close[j] > S.emaF[j]) { crossedUp = true; break; }
  }
  const crossedDownSlow = S.close[i - 1] >= S.emaS[i - 1] && c < es;
  const entry = isNum(price) && price > 0 ? price : c;
  const stop = entry - settings.stopAtrMult * a, takeProfit = entry + settings.takeProfitAtrMult * a;
  const rr = stop > 0 && entry > stop ? (takeProfit - entry) / (entry - stop) : 0;
  const conds = [
    { key: "trend", w: 30, required: true, ok: trend === "up", label: `روند صعودی (EMA${P.emaFast} > EMA${P.emaSlow} و قیمت بالای EMA${P.emaSlow})` },
    { key: "trigger", w: 25, required: true, ok: crossedUp && c > ef, label: `عبور قیمت به بالای EMA${P.emaFast} در ${P.crossLookback} کندل اخیر و ماندن بالای آن` },
    { key: "rsi", w: 20, required: true, ok: r >= P.rsiBuyMin && r <= P.rsiBuyMax, label: `RSI(${P.rsiPeriod}) بین ${P.rsiBuyMin} و ${P.rsiBuyMax}` },
    { key: "volume", w: 15, required: false, ok: hasVol ? volRatio >= P.volMin : null, label: `حجم کندل حداقل ${P.volMin} برابر میانگین ${P.volPeriod}کندلی` },
    { key: "rr", w: 10, required: true, ok: rr >= settings.minRR && stop > 0, label: `نسبت سود به زیان حداقل ${settings.minRR}` },
  ];
  const evald = conds.filter((x) => x.ok !== null);
  const score = Math.round((100 * evald.filter((x) => x.ok).reduce((s, x) => s + x.w, 0)) / evald.reduce((s, x) => s + x.w, 0));
  const buyOk = conds.filter((x) => x.required).every((x) => x.ok);
  const exitReasons = [];
  if (trend === "down") exitReasons.push("روند نزولی شد (EMA کوتاه زیر EMA بلند و قیمت زیر آن).");
  if (crossedDownSlow) exitReasons.push(`قیمت از پایین EMA${P.emaSlow} عبور کرد.`);
  if (r >= P.rsiExit) exitReasons.push(`RSI به ${r.toFixed(1)} رسید (بیش‌خرید، آستانه ${P.rsiExit}).`);
  let signal = "none"; const reasons = [];
  if (holding && exitReasons.length) { signal = "sell"; reasons.push(...exitReasons); }
  else if (!holding && buyOk) { signal = "buy"; reasons.push(...conds.filter((x) => x.ok).map((x) => x.label)); }
  else if (holding) reasons.push("موقعیت باز است و شرط خروج استراتژی برقرار نیست.");
  else {
    const failed = conds.filter((x) => x.required && !x.ok).map((x) => x.label);
    reasons.push("عدم معامله؛ شرط‌های ناقص: " + failed.join(" | "));
  }
  return { ready: true, signal, trend, score, scoreNote: SCORE_NOTE, conditions: conds.map(({ key, label, ok, w }) => ({ key, label, ok, weight: w })),
    indicators: { close: c, emaFast: ef, emaSlow: es, rsi: r, atr: a, volRatio }, entry, stop, takeProfit, rr, riskPct: stop > 0 ? ((entry - stop) / entry) * 100 : null, reasons, exitReasons };
}

// ---------- تحلیل یک ارز (آخرین کندل بسته‌شده) ----------
export function analyzeCandles(candles, meta, settings, { holding = false, price = null, nowMs = Date.now() } = {}) {
  const tfMs = TF_MS[settings.timeframe];
  const closed = candles.filter((c) => c.t + tfMs <= nowMs); // کندل در حال تشکیل هرگز استفاده نمی‌شود
  const data = assessData(closed, meta, tfMs, nowMs, warmupBars(settings.params));
  const base = { analyzedAt: new Date(nowMs).toISOString(), timeframe: settings.timeframe, strategy: settings.strategy, dataQuality: data, signal: "none", scoreNote: SCORE_NOTE };
  if (!data.ok) return { ...base, reasons: ["داده برای تحلیل معتبر نیست: " + data.issues.join(" ")] };
  const S = computeSeries(closed, settings.params); const i = closed.length - 1;
  const ev = evaluateAt(S, closed, i, settings, { holding, price });
  if (!ev.ready) return { ...base, reasons: ["اندیکاتورها هنوز آماده نیستند."] };
  const first = Math.max(0, closed.length - 1 - Math.round(86400000 / tfMs));
  const changePct = closed[first].c > 0 ? ((closed[i].c / closed[first].c) - 1) * 100 : null;
  return { ...base, ...ev, candleT: closed[i].t, changePct24h: changePct, entry: ev.entry, price: isNum(price) ? price : closed[i].c };
}

// ---------- ارزیابی نتیجه‌ی بعدی یک سیگنال خرید ----------
export function evaluateSignalOutcome(sig, candles, tfMs, maxBars = 48) {
  if (!sig || sig.signal !== "buy" || !isNum(sig.stop) || !isNum(sig.takeProfit)) return { status: "n/a" };
  const after = candles.filter((c) => c.t > sig.candleT && c.t + tfMs <= Date.now() + 1).slice(0, maxBars);
  for (const c of after) {
    const hitStop = c.l <= sig.stop, hitTp = c.h >= sig.takeProfit;
    if (hitStop) return { status: "stop", pct: ((sig.stop / sig.entry) - 1) * 100, at: new Date(c.t).toISOString() }; // اگر هر دو در یک کندل بود، محافظه‌کارانه حد ضرر
    if (hitTp) return { status: "take_profit", pct: ((sig.takeProfit / sig.entry) - 1) * 100, at: new Date(c.t).toISOString() };
  }
  if (after.length >= maxBars) return { status: "expired", pct: ((after[after.length - 1].c / sig.entry) - 1) * 100, at: new Date(after[after.length - 1].t).toISOString() };
  return { status: "pending" };
}

// ---------- دروازه‌ی مدیریت ریسک ----------
// ورودی c: kind("entry"|"exit"), mode, settings, coinId, liveUnlocked, keyConfigured, killed, running,
//   price{value,stale,ageSec}, order{qty,estimateIrt,step,minQty,minNotional,amountDecimals},
//   balance{availableIrt,availableCoin}, openTrades, exposureIrt, dailyLossIrt, drawdownPct, duplicate{exists,unknownState}
export function evaluateRisk(c) {
  const f = []; const add = (code, message) => f.push({ code, message });
  const s = c.settings; const entry = c.kind === "entry"; const o = c.order || {};
  // ۱ و ۲: حالت واقعی و اتصال حساب
  if (c.mode === "live") {
    if (!c.liveUnlocked) add("LIVE_NOT_ENABLED", "حالت معامله‌ی واقعی صریحاً فعال نشده است (تنظیمات سرور و تأیید کاربر).");
    if (!c.keyConfigured) add("NO_ACCOUNT", "کلید API والکس تنظیم نشده یا حساب متصل نیست.");
  }
  if (entry && c.killed) add("KILL_SWITCH", "توقف اضطراری فعال است؛ معامله‌ی جدید مجاز نیست.");
  if (entry && !c.running) add("ENGINE_NOT_RUNNING", "موتور متوقف است.");
  // ۳: قیمت معتبر و تازه
  const pv = c.price && c.price.value;
  if (!(pv > 0)) add("NO_PRICE", "قیمت معتبر بازار در دسترس نیست.");
  else if (c.price.stale || c.price.ageSec > s.priceStaleSec) add("STALE_PRICE", "قیمت بازار قدیمی است.");
  // ۴: فهرست مجاز (فقط ورود)
  if (entry && !s.coins.includes(c.coinId)) add("SYMBOL_NOT_ALLOWED", "این ارز در فهرست مجاز معامله‌ی خودکار نیست.");
  // ۱۱ و ۱۲: حداقل/حداکثر و دقت صرافی
  const qty = Number(o.qty);
  if (!(qty > 0)) add("BAD_QTY", "مقدار سفارش نامعتبر یا صفر است.");
  else {
    if (o.minQty > 0 && qty < o.minQty) add("BELOW_MIN_QTY", `مقدار سفارش کمتر از حداقل صرافی (${o.minQty}) است.`);
    if (o.minNotional > 0 && o.estimateIrt < o.minNotional) add("BELOW_MIN_NOTIONAL", `ارزش سفارش کمتر از حداقل صرافی (${o.minNotional}) است.`);
    if (Number.isFinite(o.step) && String(o.qtyStr || "").split(".")[1]?.length > o.step) add("BAD_PRECISION", `دقت مقدار سفارش بیش از ${o.step} رقم اعشار است.`);
  }
  // ۶: سقف مبلغ (خروج برای کاهش ریسک مستثنی است)
  if (entry && o.estimateIrt > s.maxOrderIrt) add("ORDER_OVER_CAP", `مبلغ سفارش از سقف هر معامله (${s.maxOrderIrt}) بیشتر است.`);
  // ۵: موجودی
  if (entry) { if (!(c.balance && c.balance.availableIrt >= o.estimateIrt * (1 + s.feePct / 100))) add("INSUFFICIENT_BALANCE", "موجودی تومانی کافی نیست."); }
  else if (!(c.balance && c.balance.availableCoin > 0)) add("INSUFFICIENT_BALANCE", "موجودی ارز برای فروش کافی نیست.");
  if (entry) {
    // ۷ تا ۹: سقف‌های موقعیت، زیان روزانه، افت سرمایه
    if (c.openTrades >= s.maxOpenTrades) add("MAX_OPEN_TRADES", "به سقف تعداد معاملات باز رسیده‌ایم.");
    if (c.exposureIrt + o.estimateIrt > s.maxTotalExposureIrt) add("MAX_EXPOSURE", "مجموع موقعیت‌های باز از سقف مجاز بیشتر می‌شود.");
    if (c.dailyLossIrt >= s.maxDailyLossIrt) add("DAILY_LOSS_LIMIT", "سقف زیان روزانه نقض شده است.");
    if (c.drawdownPct >= s.maxDrawdownPct) add("MAX_DRAWDOWN", "سقف افت سرمایه نقض شده است.");
  }
  // ۱۰: سفارش تکراری یا نتیجه‌ی نامشخص
  if (c.duplicate && c.duplicate.exists) add("DUPLICATE_ORDER", "سفارش مشابه/تکراری قبلاً ثبت شده است.");
  if (c.duplicate && c.duplicate.unknownState) add("UNKNOWN_ORDER_STATE", "سفارشی با نتیجه‌ی نامشخص وجود دارد؛ ابتدا باید بررسی دستی شود.");
  return { ok: f.length === 0, failures: f };
}

// ---------- بک‌تست ----------
function metricsOf(trades) {
  const n = trades.length; const wins = trades.filter((t) => t.retPct > 0);
  const grossW = wins.reduce((s, t) => s + t.retPct, 0), grossL = -trades.filter((t) => t.retPct <= 0).reduce((s, t) => s + t.retPct, 0);
  let eq = 1, peak = 1, mdd = 0;
  for (const t of trades) { eq *= 1 + t.retPct / 100; peak = Math.max(peak, eq); mdd = Math.max(mdd, (peak - eq) / peak * 100); }
  return { trades: n, wins: wins.length, winRatePct: n ? (wins.length / n) * 100 : null, netReturnPct: n ? (eq - 1) * 100 : 0,
    avgTradePct: n ? trades.reduce((s, t) => s + t.retPct, 0) / n : null, profitFactor: grossL > 0 ? grossW / grossL : (grossW > 0 ? null : 0), maxDrawdownPct: mdd,
    note: "افت سرمایه بر پایه‌ی معاملات بسته‌شده محاسبه شده (نه ارزش‌گذاری لحظه‌ای)." };
}

export function backtest(candles, meta, settings, { splitPct = 0.7 } = {}) {
  const P = settings.params; const tfMs = TF_MS[settings.timeframe]; const tfH = tfMs / 3600000;
  const warm = warmupBars(P); const warnings = [];
  if (candles.length < warm + 30) return { ok: false, error: `داده‌ی تاریخی کافی نیست (${candles.length} کندل؛ حداقل ${warm + 30} لازم است).` };
  if (meta && meta.hasOhlc === false) warnings.push("داده‌ی high/low وجود نداشت؛ بررسی حد ضرر/سود داخل کندل‌ها دقیق نیست و نتایج قابل اتکا نیستند.");
  if (meta && meta.hasVolume === false) warnings.push("داده‌ی حجم وجود نداشت؛ شرط حجم در بک‌تست ارزیابی نشد.");
  const S = computeSeries(candles, P); const slip = settings.slippagePct / 100, fee = settings.feePct / 100;
  const trades = []; let pos = null, pendEntry = false, pendExit = null;
  const close = (idx, px, reason, forced = false) => {
    const exitFill = px * (1 - slip); const cost = pos.entry * (1 + fee), proceeds = exitFill * (1 - fee);
    trades.push({ entryIdx: pos.entryIdx, exitIdx: idx, entryAt: new Date(candles[pos.entryIdx].t).toISOString(), exitAt: new Date(candles[idx].t).toISOString(),
      entry: pos.entry, exit: exitFill, reason, forced, retPct: (proceeds / cost - 1) * 100, holdBars: idx - pos.entryIdx });
    pos = null;
  };
  for (let j = warm; j < candles.length; j++) {
    const k = candles[j]; let skipManage = false;
    if (pendEntry && !pos) { // ورود در open کندل بعد از سیگنال (بدون نگاه به آینده)
      const fill = k.o * (1 + slip); const a = pendEntry.atr;
      pos = { entryIdx: j, entry: fill, stop: fill - settings.stopAtrMult * a, tp: fill + settings.takeProfitAtrMult * a, atr: a, high: fill }; pendEntry = false;
    } else if (pendExit && pos) { close(j, k.o, pendExit); pendExit = null; skipManage = true; }
    if (pos && !skipManage) {
      if (settings.trailingStop && pos.high > pos.entry) pos.stop = Math.max(pos.stop, pos.high - settings.trailingAtrMult * pos.atr);
      if (k.o <= pos.stop) close(j, k.o, "stop");
      else if (k.l <= pos.stop) close(j, pos.stop, "stop");
      else if (k.o >= pos.tp) close(j, k.o, "take_profit");
      else if (k.h >= pos.tp) close(j, pos.tp, "take_profit");
      else { pos.high = Math.max(pos.high, k.h); if ((j - pos.entryIdx) * tfH >= settings.maxHoldHours) pendExit = "timeout"; }
    }
    if (j < candles.length - 1) { // سیگنال با بسته‌شدن کندل j
      if (!pos && !pendEntry) { const ev = evaluateAt(S, candles, j, settings, { holding: false }); if (ev.ready && ev.signal === "buy" && ev.score >= settings.minScore) pendEntry = { atr: ev.indicators.atr }; }
      else if (pos && !pendExit) { const ev = evaluateAt(S, candles, j, settings, { holding: true }); if (ev.ready && ev.signal === "sell") pendExit = "signal"; }
    }
  }
  if (pos) close(candles.length - 1, candles[candles.length - 1].c, "end_of_data", true);
  const splitIdx = warm + Math.floor((candles.length - warm) * splitPct);
  const ins = trades.filter((t) => t.entryIdx < splitIdx), oos = trades.filter((t) => t.entryIdx >= splitIdx);
  const bh = (a, b) => (candles[a].c > 0 ? (candles[b].c / candles[a].c - 1) * 100 : null);
  if (trades.length < 30) warnings.push(`تعداد معاملات (${trades.length}) برای نتیجه‌گیری آماری کم است.`);
  return { ok: true, bars: candles.length, from: new Date(candles[0].t).toISOString(), to: new Date(candles[candles.length - 1].t).toISOString(), splitAt: new Date(candles[splitIdx].t).toISOString(),
    all: metricsOf(trades), inSample: metricsOf(ins), outOfSample: metricsOf(oos),
    buyAndHold: { allPct: bh(warm, candles.length - 1), outOfSamplePct: bh(splitIdx, candles.length - 1) },
    assumptions: [`ورود در open کندل بعد از سیگنال با لغزش ${settings.slippagePct}٪ و کارمزد ${settings.feePct}٪ برای هر سمت`, "اگر حد ضرر و حد سود هر دو در یک کندل لمس شوند، حد ضرر فرض می‌شود", "یک موقعیت در هر زمان؛ ۱۰۰٪ سرمایه در هر معامله", "پارامترها بهینه‌سازی نشده‌اند؛ تقسیم زمانی فقط برای بررسی پایداری است"],
    warnings, trades: trades.slice(-100) };
}
