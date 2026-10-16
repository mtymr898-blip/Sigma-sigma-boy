// ===================================================================
// src/trading.js — هماهنگ‌کننده‌ی موتور معاملاتی
// -------------------------------------------------------------------
// سه حالت مستقل:
//   suggest = تحلیل و پیشنهاد (پیش‌فرض؛ هیچ سفارشی ارسال/شبیه‌سازی نمی‌شود)
//   paper   = معامله‌ی آزمایشی (معاملات فرضی روی قیمت‌های واقعی بازار؛ بدون ارسال سفارش)
//   live    = معامله‌ی واقعی (به‌صورت پیش‌فرض قفل؛ نیازمند تنظیم سرور + تأیید صریح کاربر)
// هر ورود به معامله از دروازه‌ی evaluateRisk (engine.js) می‌گذرد. حد سود/ضرر نرم‌افزاری است
// (سرور قیمت را پایش می‌کند؛ سفارش شرطی روی صرافی ثبت نمی‌شود) — محدودیت‌ها در docs/TRADING.md آمده است.
// ===================================================================
import { DEFAULT_SETTINGS, TF_MS, validateSettings, analyzeCandles, evaluateSignalOutcome, evaluateRisk, backtest } from "./engine.js";

export const LIVE_CONFIRM_PHRASE = "ACTIVATE LIVE TRADING";
const K = { settings: "eng:settings", ctl: "eng:ctl", state: "eng:state", signals: "eng:signals", trades: "eng:trades", events: "eng:events", dca: "eng:dca" };
const CAP = { signals: 500, trades: 1000, events: 500 };
const LIVE_OPEN = ["open", "holding", "closing", "pending_entry", "needs_review"];
const DEFAULT_CTL = { mode: "suggest", running: true, killed: false, killReason: null, killedAt: null, liveConfirmedAt: null, updatedAt: null };
const TEHRAN_OFFSET_MS = 3.5 * 3600000; // ایران ساعت تابستانی ندارد

const dayKey = (t) => new Date(t + TEHRAN_OFFSET_MS).toISOString().slice(0, 10);
const iso = (t) => new Date(t).toISOString();
const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
const round = (n) => Math.round(n);
function fnv(str, seed) { let h = seed >>> 0; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; }
export const hashId = (str) => fnv(str, 2166136261).toString(36).padStart(7, "0") + fnv(str, 0x9e3779b1).toString(36).padStart(7, "0");

export function createTrading(deps) {
  const { env, HttpError, kv, coins, tmnSymbol, priceOf, num, decimalStr, tradingState, getMarkets, fetchOhlc, getBalances, placeLiveOrder } = deps;
  const now = deps.now || (() => Date.now());
  const hasKey = () => (deps.hasApiKey ? deps.hasApiKey() : !!env.WALLEX_API_KEY);
  const allowedCoins = coins.map((c) => c.id).filter((id) => id !== "usdt");
  const bad = (status, code, msg, extra) => new HttpError(status, code, msg, extra);

  // ---------- ذخیره‌سازی و قفل‌ها ----------
  const load = async (k, d) => { const v = await kv.get(k); return v === undefined || v === null ? structuredClone(d) : v; };
  const save = (k, v) => kv.put(k, v);
  let lockChain = Promise.resolve();
  const withLock = (fn) => { const run = lockChain.then(fn); lockChain = run.catch(() => {}); return run; };
  let ctlChain = Promise.resolve(); // کنترل (توقف اضطراری/حالت) هرگز پشت تیک طولانی منتظر نمی‌ماند
  const patchCtl = (fn) => {
    const run = ctlChain.then(async () => { const c = await load(K.ctl, DEFAULT_CTL); const r = fn(c); const n = r === undefined ? c : r; n.updatedAt = iso(now()); await save(K.ctl, n); return n; });
    ctlChain = run.catch(() => {}); return run;
  };
  const getCtl = () => load(K.ctl, DEFAULT_CTL);
  let evChain = Promise.resolve();
  const addEvent = (type, detail, extra = {}) => {
    const run = evChain.then(async () => { const ev = await load(K.events, []); ev.push({ t: iso(now()), type, detail, ...extra }); await save(K.events, ev.slice(-CAP.events)); });
    evChain = run.catch(() => {}); return run.catch(() => {});
  };
  const sensitive = []; // محدودیت نرخ عملیات حساس (حافظه‌ی فرایند)
  function limit(name, max = 8, windowMs = 60000) {
    const t = now(); while (sensitive.length && t - sensitive[0].t > windowMs) sensitive.shift();
    if (sensitive.filter((x) => x.name === name).length >= max) throw bad(429, "TOO_MANY_REQUESTS", "تعداد درخواست‌های حساس زیاد است؛ کمی بعد دوباره تلاش کنید.");
    sensitive.push({ name, t });
  }

  async function getSettings() {
    const s = await load(K.settings, DEFAULT_SETTINGS);
    const m = { ...DEFAULT_SETTINGS, ...s, params: { ...DEFAULT_SETTINGS.params, ...(s.params || {}) } };
    const cap = tradingState().cap; if (cap && m.maxOrderIrt > cap) m.maxOrderIrt = cap; // سقف سرور همیشه مقدم است
    return m;
  }
  function liveGate(ctl) {
    const ts = tradingState(); const reasons = ts.enabled ? [] : [...ts.reasons];
    if (env.AUTO_TRADING_ENABLED !== "true") reasons.push("AUTO_TRADING_DISABLED");
    return { serverUnlocked: reasons.length === 0, reasons, confirmed: !!ctl.liveConfirmedAt };
  }

  // ---------- ابزار بازار ----------
  function marketInfo(mk, coinId) {
    const m = mk.sym[tmnSymbol(coinId)]; const ref = priceOf(m); if (!m || !ref) return null;
    const st = m.stats || {}; const ask = num(st.askPrice), bid = num(st.bidPrice);
    return { price: ref.price, source: ref.source, ask: ask > 0 ? ask : ref.price, bid: bid > 0 ? bid : ref.price, step: num(m.stepSize), minQty: num(m.minQty), minNotional: num(m.minNotional), tick: num(m.tickSize),
      stale: !!mk.stale, ageSec: mk.stale ? 9999 : Math.max(0, (now() - mk.t) / 1000) };
  }
  const feeRate = (s) => s.feePct / 100, slip = (s) => s.slippagePct / 100;
  const floorQty = (q, step) => { const f = 10 ** (Number.isFinite(step) ? step : 8); return Math.floor(q * f + 1e-9) / f; };
  const stepDp = (info) => (Number.isFinite(info.step) ? info.step : 8);
  const cost = (t) => Number(t.entry.costIrt) + Number(t.entry.feeIrt);
  const unrealized = (t, info, s) => Number(t.entry.qty) * info.bid * (1 - slip(s)) * (1 - feeRate(s)) - cost(t);

  function computeRisk(ctx) {
    const { trades, ctl, settings: s, mk, state, t } = ctx; const mode = ctl.mode;
    const mt = trades.filter((x) => x.mode === mode);
    const occupying = mt.filter((x) => LIVE_OPEN.includes(x.status) && x.entry);
    const closed = mt.filter((x) => x.status === "closed" && Number.isFinite(x.pnlIrt));
    const today = dayKey(t);
    const realizedToday = sum(closed.filter((x) => x.closedAt && dayKey(Date.parse(x.closedAt)) === today), (x) => x.pnlIrt);
    const realizedTotal = sum(closed, (x) => x.pnlIrt);
    let unreal = 0;
    for (const x of occupying) if (x.status === "open" || x.status === "holding") { const info = mk ? marketInfo(mk, x.coinId) : null; if (info) unreal += unrealized(x, info, s); }
    const total = realizedTotal + unreal;
    const peak = Math.max(((state.peak || {})[mode]) || 0, total);
    const drawdownPct = s.capitalIrt + peak > 0 ? Math.max(0, ((peak - total) / (s.capitalIrt + peak)) * 100) : 0;
    return { exposure: sum(occupying, (x) => Number(x.entry.costIrt)), openCount: mt.filter((x) => ["open", "closing", "pending_entry"].includes(x.status) && x.kind !== "dca").length,
      dailyLoss: Math.max(0, -realizedToday), realizedToday, realizedTotal, unrealized: unreal, total, peak, drawdownPct,
      paperCash: s.capitalIrt + realizedTotal - sum(occupying, (x) => Number(x.entry.costIrt) + Number(x.entry.feeIrt)),
      hasUnknown: mt.some((x) => x.status === "needs_review" || x.status === "pending_entry") };
  }

  async function pauseForReview(ctx, message) {
    ctx.ctl.running = false;
    await patchCtl((c) => { c.running = false; });
    ctx.state.lastError = { at: iso(now()), message }; ctx.state.lastErrorAt = iso(now());
    await addEvent("needs_review", message);
  }
  const liveError = (e) => (e && e.code === "UNKNOWN_OUTCOME" ? "unknown" : "definitive");
  const errMsg = (e) => (e && (e.message || e.code)) || "خطای نامشخص";

  // ---------- باز کردن موقعیت (Paper یا Live) ----------
  async function openPosition(a, ctx) {
    const { mk, settings: s, ctl, trades } = ctx; const mode = ctl.mode;
    const fail = (failures) => ({ ok: false, failures });
    const info = marketInfo(mk, a.coinId);
    if (!info) return fail([{ code: "NO_PRICE", message: "قیمت بازار برای این ارز در دسترس نیست." }]);
    const unit = info.ask * (1 + slip(s)); const dp = stepDp(info);
    const qtyNum = floorQty(a.amountIrt / (unit * (1 + feeRate(s))), info.step); const qtyStr = decimalStr(qtyNum, dp);
    const estimate = Number(qtyStr) * unit;
    const tradeId = "t" + hashId([mode, a.kind, a.coinId, a.seed].join("|"));
    const rc = computeRisk(ctx);
    let balance;
    if (mode === "paper") balance = { availableIrt: rc.paperCash };
    else {
      try { const w = (await getBalances()).find((x) => x.cur === "tmn"); balance = { availableIrt: w ? w.available : 0 }; }
      catch (e) { return fail([{ code: "NO_ACCOUNT", message: "دریافت موجودی حساب ممکن نشد: " + errMsg(e) }]); }
    }
    const gate = liveGate(ctl);
    const risk = evaluateRisk({ kind: "entry", mode, settings: s, coinId: a.coinId, liveUnlocked: gate.serverUnlocked && gate.confirmed, keyConfigured: hasKey(),
      killed: ctl.killed, running: a.ignoreRunning ? true : ctl.running, price: { value: info.price, stale: info.stale, ageSec: info.ageSec },
      order: { qty: qtyStr, qtyStr, estimateIrt: estimate, step: info.step, minQty: info.minQty, minNotional: info.minNotional }, balance,
      openTrades: rc.openCount, exposureIrt: rc.exposure, dailyLossIrt: rc.dailyLoss, drawdownPct: rc.drawdownPct,
      duplicate: { exists: trades.some((x) => x.id === tradeId), unknownState: rc.hasUnknown } });
    if (!risk.ok) return fail(risk.failures);
    if ((await getCtl()).killed) return fail([{ code: "KILL_SWITCH", message: "توقف اضطراری فعال شد؛ سفارش ارسال نشد." }]);

    let stop = a.stop ?? null, takeProfit = a.takeProfit ?? null;
    if (a.kind === "strategy" && a.atr > 0) { stop = unit - s.stopAtrMult * a.atr; takeProfit = unit + s.takeProfitAtrMult * a.atr; }
    if (stop !== null && !(stop > 0 && stop < unit)) return fail([{ code: "BAD_STOP", message: "حد ضرر باید زیر قیمت ورود و مثبت باشد." }]);
    if (takeProfit !== null && !(takeProfit > unit)) return fail([{ code: "BAD_TP", message: "حد سود باید بالای قیمت ورود باشد." }]);
    const at = iso(now());
    const trade = { id: tradeId, mode, kind: a.kind, coinId: a.coinId, symbol: `${a.coinId.toUpperCase()}/IRT`, side: "long", status: a.kind === "dca" ? "holding" : "open", openedAt: at,
      signalId: a.signalId || null, reasonIn: a.reason || "", stop, takeProfit, atr: a.atr ?? null, trailing: !!a.trailing, trailingPct: a.trailingPct ?? null, highWater: unit,
      entry: null, exit: null, pnlIrt: null, pnlPct: null, closedAt: null, warnings: [], attempts: 0, exitFailures: 0 };

    if (mode === "paper") {
      const c = Number(qtyStr) * unit;
      trade.entry = { expectedPrice: info.ask, price: unit, qty: qtyStr, costIrt: round(c), feeIrt: round(c * feeRate(s)), orderId: null, clientOrderId: null, verified: true, priceSource: "simulated_from_real_quote", feeSource: "assumed" };
      trades.push(trade); await save(K.trades, trades.slice(-CAP.trades));
      return { ok: true, trade };
    }
    // --- واقعی: اول رکورد pending ذخیره می‌شود تا اگر فرایند وسط ارسال بمیرد، سفارش «نامشخص» دیده شود نه «فراموش‌شده» ---
    const clientId = "ae" + hashId(tradeId + "|entry");
    const c0 = Number(qtyStr) * info.ask;
    trade.status = "pending_entry";
    trade.entry = { expectedPrice: info.ask, price: info.ask, qty: qtyStr, costIrt: round(c0), feeIrt: round(c0 * feeRate(s)), orderId: null, clientOrderId: clientId, verified: false, priceSource: "unverified", feeSource: "assumed" };
    trades.push(trade); await save(K.trades, trades.slice(-CAP.trades));
    let res;
    try { res = await placeLiveOrder({ coinId: a.coinId, side: "buy", amount: qtyStr, id: clientId, isExit: false }); }
    catch (e) {
      if (liveError(e) === "unknown") {
        trade.status = "needs_review"; trade.warnings.push("نتیجه‌ی ارسال سفارش خرید نامشخص است؛ سفارش‌های باز را در والکس بررسی کنید."); await save(K.trades, trades);
        await pauseForReview(ctx, `سفارش خرید ${a.coinId.toUpperCase()} نتیجه‌ی نامشخص دارد (${trade.id}).`);
        return { ok: false, unknown: true, failures: [{ code: "UNKNOWN_OUTCOME", message: errMsg(e) }] };
      }
      const i = trades.indexOf(trade); if (i >= 0) trades.splice(i, 1); await save(K.trades, trades);
      return fail([{ code: e.code || "ORDER_FAILED", message: errMsg(e) }]);
    }
    const f = res.fill;
    if (!res.verified || !f || f.active || !(f.matched > 0)) {
      trade.status = "needs_review"; trade.entry.orderId = res.orderId || null;
      trade.warnings.push("والکس ثبت سفارش را اعلام کرد اما اجرای کامل آن تأیید نشد (وضعیت/مقدار اجراشده نامعلوم)؛ بررسی دستی لازم است.");
      await save(K.trades, trades); await pauseForReview(ctx, `اجرای سفارش خرید ${a.coinId.toUpperCase()} تأیید نشد (${trade.id}).`);
      return { ok: false, unknown: true, failures: [{ code: "UNVERIFIED_FILL", message: "اجرای سفارش تأیید نشد." }] };
    }
    const px = f.execPrice > 0 ? f.execPrice : f.execSum > 0 ? f.execSum / f.matched : info.ask;
    const exact = f.execPrice > 0 || f.execSum > 0; const q = decimalStr(f.matched, dp); const c = Number(q) * px;
    trade.entry = { expectedPrice: info.ask, price: px, qty: q, costIrt: round(c), feeIrt: round(c * feeRate(s)), orderId: res.orderId, clientOrderId: clientId, verified: true,
      priceSource: exact ? "exchange" : "estimated_from_quote", feeSource: "assumed" };
    trade.status = a.kind === "dca" ? "holding" : "open"; trade.highWater = px;
    if (a.kind === "strategy" && a.atr > 0) { trade.stop = px - s.stopAtrMult * a.atr; trade.takeProfit = px + s.takeProfitAtrMult * a.atr; }
    if (!exact) trade.warnings.push("قیمت واقعی اجرا از والکس دریافت نشد؛ قیمت و کارمزد تخمینی‌اند.");
    await save(K.trades, trades);
    return { ok: true, trade };
  }

  function finalize(t, reason, x) {
    const at = iso(now());
    t.exit = { reason, at, ...x }; t.status = "closed"; t.closedAt = at; t.exitReason = reason;
    t.pnlIrt = round(x.proceedsIrt - x.feeIrt - cost(t)); t.pnlPct = cost(t) > 0 ? (t.pnlIrt / cost(t)) * 100 : null;
  }

  // ---------- بستن موقعیت ----------
  async function closePosition(t, reason, ctx) {
    const { mk, settings: s, ctl, trades } = ctx;
    const info = marketInfo(mk, t.coinId);
    if (!info) return { ok: false, failures: [{ code: "NO_PRICE", message: "قیمت بازار در دسترس نیست." }] };
    const qty = Number(t.entry.qty); const dp = stepDp(info);
    if (t.mode === "paper") {
      const px = info.bid * (1 - slip(s)); const pr = qty * px;
      finalize(t, reason, { expectedPrice: info.bid, price: px, proceedsIrt: round(pr), feeIrt: round(pr * feeRate(s)), orderId: null, clientOrderId: null, priceSource: "simulated_from_real_quote", feeSource: "assumed" });
      await save(K.trades, trades); return { ok: true };
    }
    let avail = 0;
    try { const w = (await getBalances()).find((x) => x.cur === t.coinId); avail = w ? w.available : 0; }
    catch (e) { return softExitFail(t, ctx, [{ code: "NO_ACCOUNT", message: "دریافت موجودی ناموفق: " + errMsg(e) }]); }
    const sellQty = floorQty(Math.min(qty, avail), info.step); const qStr = decimalStr(sellQty, dp); const px0 = info.bid * (1 - slip(s));
    const gate = liveGate(ctl);
    // خروج (کاهش ریسک) به تأیید دوباره‌ی کاربر نیاز ندارد؛ مثلاً پس از توقف اضطراری که حالت واقعی را غیرمسلح می‌کند حد ضرر باید کار کند. قفل سرور همچنان لازم است.
    const risk = evaluateRisk({ kind: "exit", mode: "live", settings: s, coinId: t.coinId, liveUnlocked: gate.serverUnlocked, keyConfigured: hasKey(),
      killed: ctl.killed, running: ctl.running, price: { value: info.price, stale: info.stale, ageSec: info.ageSec },
      order: { qty: qStr, qtyStr: qStr, estimateIrt: sellQty * px0, step: info.step, minQty: info.minQty, minNotional: info.minNotional }, balance: { availableCoin: avail }, duplicate: { unknownState: t.status === "needs_review" } });
    if (!risk.ok) return softExitFail(t, ctx, risk.failures);
    const clientId = "ax" + hashId(t.id + "|exit|" + t.attempts);
    t.status = "closing"; t.exitPending = { reason, clientOrderId: clientId, at: iso(now()) }; await save(K.trades, trades);
    let res;
    try { res = await placeLiveOrder({ coinId: t.coinId, side: "sell", amount: qStr, id: clientId, isExit: true }); }
    catch (e) {
      if (liveError(e) === "unknown") {
        t.status = "needs_review"; t.warnings.push("نتیجه‌ی ارسال سفارش فروش نامشخص است؛ در والکس بررسی کنید."); await save(K.trades, trades);
        await pauseForReview(ctx, `سفارش فروش ${t.coinId.toUpperCase()} نتیجه‌ی نامشخص دارد (${t.id}).`);
        return { ok: false, unknown: true, failures: [{ code: "UNKNOWN_OUTCOME", message: errMsg(e) }] };
      }
      t.status = "open"; t.attempts += 1; delete t.exitPending; return softExitFail(t, ctx, [{ code: e.code || "ORDER_FAILED", message: errMsg(e) }]);
    }
    const f = res.fill;
    if (!res.verified || !f || f.active || !(f.matched > 0)) {
      t.status = "needs_review"; t.warnings.push("اجرای سفارش فروش تأیید نشد؛ بررسی دستی لازم است."); await save(K.trades, trades);
      await pauseForReview(ctx, `اجرای سفارش فروش ${t.coinId.toUpperCase()} تأیید نشد (${t.id}).`);
      return { ok: false, unknown: true, failures: [{ code: "UNVERIFIED_FILL", message: "اجرای فروش تأیید نشد." }] };
    }
    const px = f.execPrice > 0 ? f.execPrice : f.execSum > 0 ? f.execSum / f.matched : px0; const exact = f.execPrice > 0 || f.execSum > 0; const pr = f.matched * px;
    if (f.matched < qty * 0.999) t.warnings.push(`فقط ${f.matched} از ${qty} فروخته شد؛ مقدار باقی‌مانده در حساب است و باید دستی بررسی شود.`);
    finalize(t, reason, { expectedPrice: info.bid, price: px, proceedsIrt: round(pr), feeIrt: round(pr * feeRate(s)), orderId: res.orderId, clientOrderId: clientId, priceSource: exact ? "exchange" : "estimated_from_quote", feeSource: "assumed" });
    delete t.exitPending; await save(K.trades, trades); return { ok: true };
  }
  async function softExitFail(t, ctx, failures) {
    t.exitFailures = (t.exitFailures || 0) + 1; t.warnings.push("خروج ناموفق: " + failures.map((f) => f.message).join(" | "));
    t.warnings = t.warnings.slice(-5);
    if (t.exitFailures >= 5) { t.status = "needs_review"; await save(K.trades, ctx.trades); await pauseForReview(ctx, `خروج از موقعیت ${t.coinId.toUpperCase()} پنج بار ناموفق بود (${t.id}).`); }
    else await save(K.trades, ctx.trades);
    return { ok: false, failures };
  }

  // ---------- پایش حد سود/ضرر ----------
  async function monitor(ctx) {
    const { mk, settings: s, ctl, trades, t } = ctx;
    for (const tr of trades.filter((x) => x.mode === ctl.mode && x.status === "open")) {
      const info = marketInfo(mk, tr.coinId); if (!info || info.stale) continue;
      const px = info.bid; let dirty = false;
      if (px > (tr.highWater || 0)) { tr.highWater = px; dirty = true; }
      const ep = Number(tr.entry.price);
      if (tr.highWater > ep) {
        let ns = null;
        if (tr.trailing && tr.atr > 0) ns = tr.highWater - s.trailingAtrMult * tr.atr;
        if (tr.trailingPct > 0) ns = Math.max(ns ?? 0, tr.highWater * (1 - tr.trailingPct / 100));
        if (ns !== null && ns > (tr.stop ?? 0)) { tr.stop = ns; dirty = true; }
      }
      let reason = null;
      if (tr.stop != null && px <= tr.stop) reason = "stop";
      else if (tr.takeProfit != null && px >= tr.takeProfit) reason = "take_profit";
      else if (tr.kind === "strategy" && t - Date.parse(tr.openedAt) >= s.maxHoldHours * 3600000) reason = "timeout";
      if (reason) await closePosition(tr, reason, ctx); else if (dirty) await save(K.trades, trades);
    }
  }

  async function runDca(ctx) {
    const { settings: s, ctl, t } = ctx; if (ctl.mode === "suggest" || !ctl.running || ctl.killed) return;
    const plans = await load(K.dca, []); let changed = false;
    for (const p of plans) {
      if (!p.enabled || t < p.nextRunAt) continue;
      const r = await openPosition({ kind: "dca", coinId: p.coinId, amountIrt: Math.min(p.amountIrt, s.maxOrderIrt), seed: `${p.id}:${p.runs}`, reason: `خرید دوره‌ای (DCA) شماره ${p.runs + 1}` }, ctx);
      if (r.ok) { p.runs += 1; p.lastRunAt = iso(t); p.nextRunAt = t + p.intervalHours * 3600000; p.lastResult = "ok"; }
      else { p.lastResult = r.failures.map((f) => f.message).join(" | ").slice(0, 200); p.nextRunAt = t + Math.min(p.intervalHours * 3600000, 3600000); }
      changed = true;
      if (!ctx.ctl.running) break;
    }
    if (changed) await save(K.dca, plans);
  }

  // ---------- تحلیل بازار و تولید سیگنال ----------
  async function runAnalysis(ctx) {
    const { settings: s, ctl, trades, state, mk, t } = ctx; const tfMs = TF_MS[s.timeframe];
    const signals = await load(K.signals, []); let changed = false; state.analysis = state.analysis || {};
    let balances = null;
    if (ctl.mode === "suggest" && hasKey()) { try { balances = await getBalances(); } catch (_) { /* پیشنهاد بدون موجودی هم کار می‌کند */ } }
    for (const coinId of s.coins) {
      const info = marketInfo(mk, coinId); let ohlc;
      try { ohlc = await fetchOhlc(coinId, s.timeframe, s.timeframe === "4h" ? 40 : 14); }
      catch (e) { state.analysis[coinId] = { coinId, symbol: `${coinId.toUpperCase()}/IRT`, error: errMsg(e), analyzedAt: iso(t), signal: "none", dataQuality: { ok: false, issues: [errMsg(e)], warnings: [] }, reasons: ["دریافت داده‌ی بازار ناموفق بود."] }; continue; }
      let holding = trades.some((x) => x.mode === ctl.mode && x.coinId === coinId && x.status === "open" && x.kind === "strategy");
      if (!holding && balances && info) { const w = balances.find((x) => x.cur === coinId); holding = !!(w && w.available * info.price >= (info.minNotional || 0) && w.available > 0); }
      const a = analyzeCandles(ohlc.candles, ohlc.meta, s, { holding, price: info ? info.ask : null, nowMs: t });
      const sug = ctl.mode === "suggest" ? buildSuggestion(coinId, a, info, s, balances) : null;
      state.analysis[coinId] = { coinId, symbol: `${coinId.toUpperCase()}/IRT`, ...a, marketPrice: info ? info.price : null, priceSource: info ? info.source : null, holding, mode: ctl.mode, suggestion: sug };
      for (const sg of signals) if (sg.coinId === coinId && sg.signal === "buy" && (!sg.outcome || sg.outcome.status === "pending")) {
        const o = evaluateSignalOutcome(sg, ohlc.candles, tfMs, 48); if (o.status !== (sg.outcome || {}).status) { sg.outcome = o; changed = true; }
      }
      if ((a.signal !== "buy" && a.signal !== "sell") || !a.candleT) continue;
      const key = `${coinId}:${a.candleT}:${a.signal}:${ctl.mode}`;
      if (signals.some((x) => x.key === key)) continue;
      const sg = { id: "s" + hashId(key), key, at: iso(t), coinId, symbol: `${coinId.toUpperCase()}/IRT`, signal: a.signal, mode: ctl.mode, candleT: a.candleT, timeframe: s.timeframe, strategy: s.strategy,
        price: info ? info.price : a.price, changePct24h: a.changePct24h, trend: a.trend, indicators: a.indicators, entry: a.entry, stop: a.stop, takeProfit: a.takeProfit, rr: a.rr, riskPct: a.riskPct,
        score: a.score, scoreNote: a.scoreNote, reasons: a.reasons, dataQuality: { ok: a.dataQuality.ok, warnings: a.dataQuality.warnings, bars: a.dataQuality.bars, lastCandleAt: a.dataQuality.lastCandleAt },
        status: "new", statusNote: "", tradeId: null, outcome: a.signal === "buy" ? { status: "pending" } : null, suggestion: sug };
      signals.push(sg); changed = true;
      await actOnSignal(sg, a, ctx);
    }
    if (changed) await save(K.signals, signals.slice(-CAP.signals));
  }

  async function actOnSignal(sg, a, ctx) {
    const { settings: s, ctl, trades } = ctx;
    if (ctl.mode === "suggest") { sg.status = "suggested"; sg.statusNote = "حالت تحلیل و پیشنهاد؛ هیچ سفارشی ارسال نمی‌شود. تصمیم نهایی با شماست."; return; }
    if (!ctl.running || ctl.killed) { sg.status = "not_executed"; sg.statusNote = "موتور متوقف است."; return; }
    if (a.signal === "buy") {
      if (!s.autoBuy) { sg.status = "skipped"; sg.statusNote = "خرید خودکار غیرفعال است."; return; }
      if (a.score < s.minScore) { sg.status = "skipped"; sg.statusNote = `امتیاز ${a.score} کمتر از آستانه‌ی ${s.minScore} است.`; return; }
      const r = await openPosition({ kind: "strategy", coinId: sg.coinId, amountIrt: s.maxOrderIrt, atr: a.indicators.atr, trailing: s.trailingStop, signalId: sg.id, reason: a.reasons.join(" | "), seed: sg.key }, ctx);
      if (r.ok) { sg.status = "executed"; sg.tradeId = r.trade.id; sg.statusNote = ctl.mode === "paper" ? "معامله‌ی آزمایشی باز شد." : "سفارش واقعی ثبت و تأیید شد."; }
      else { sg.status = "blocked"; sg.statusNote = r.failures.map((f) => f.message).join(" | "); await addEvent("risk_block", `${sg.symbol}: ${sg.statusNote}`); }
    } else {
      const tr = trades.find((x) => x.mode === ctl.mode && x.coinId === sg.coinId && x.status === "open" && x.kind === "strategy");
      if (!tr) { sg.status = "skipped"; sg.statusNote = "موقعیت باز مدیریت‌شده‌ای برای فروش وجود ندارد (فقط پیشنهاد)."; return; }
      if (!s.autoSell) { sg.status = "skipped"; sg.statusNote = "فروش خودکار غیرفعال است."; return; }
      const r = await closePosition(tr, "signal", ctx);
      if (r.ok) { sg.status = "executed"; sg.tradeId = tr.id; sg.statusNote = "موقعیت به‌دلیل سیگنال خروج بسته شد."; }
      else { sg.status = "blocked"; sg.statusNote = (r.failures || []).map((f) => f.message).join(" | "); }
    }
  }

  // ---------- تیک موتور ----------
  let booted = false, tickRunning = false, lastTickAt = null;
  async function recoverOnce() {
    if (booted) return; booted = true;
    const trades = await load(K.trades, []); let changed = false;
    for (const t of trades) if (t.status === "pending_entry" || t.status === "closing") {
      t.status = "needs_review"; t.warnings = [...(t.warnings || []), "سرور هنگام ارسال سفارش متوقف شد؛ وضعیت واقعی سفارش نامشخص است."]; changed = true;
    }
    const ctl = await getCtl();
    if (changed) { await save(K.trades, trades); await addEvent("needs_review", "پس از راه‌اندازی مجدد، سفارش‌هایی با وضعیت نامشخص یافت شد؛ موتور متوقف ماند."); }
    if (changed || (ctl.mode !== "suggest" && ctl.running)) {
      await patchCtl((c) => { c.running = false; });
      if (!changed) await addEvent("restart_pause", "پس از راه‌اندازی مجدد سرور، موتور (Paper/Live) متوقف شد؛ برای ادامه باید دستی شروع شود.");
    }
  }
  async function tick(opts = {}) {
    if (tickRunning) return { skipped: "busy" };
    tickRunning = true;
    try { return await withLock(() => tickInner(opts)); } finally { tickRunning = false; }
  }
  async function tickInner({ forceAnalysis = false } = {}) {
    const t = now(); lastTickAt = t; await recoverOnce(); // (در صورت اجرای قبلی از handle، بی‌اثر است)
    const ctl = await getCtl(); const s = await getSettings();
    const state = await load(K.state, {}); const trades = await load(K.trades, []);
    const hasOpen = trades.some((x) => x.mode === ctl.mode && x.status === "open");
    const manage = ctl.mode !== "suggest" && (ctl.running || s.onStop === "manage") && hasOpen;
    if (!ctl.running && !manage) return { idle: true };
    let mk;
    try { mk = await getMarkets(); } catch (e) { state.lastError = { at: iso(t), message: "دریافت قیمت بازار ناموفق: " + errMsg(e) }; state.lastErrorAt = iso(t); await save(K.state, state); return { error: true }; }
    const ctx = { mk, settings: s, ctl, trades, state, t };
    let did = [];
    if (ctl.mode !== "suggest" && t - (state.lastMonitorAt || 0) >= s.monitorIntervalSec * 1000) {
      state.lastMonitorAt = t; did.push("monitor");
      try { await monitor(ctx); if (ctl.running) await runDca(ctx); } catch (e) { state.lastError = { at: iso(t), message: "پایش موقعیت‌ها: " + errMsg(e) }; state.lastErrorAt = iso(t); await addEvent("engine_error", errMsg(e)); }
    }
    if (ctl.running && (forceAnalysis || t - (state.lastAnalysisAt || 0) >= s.analysisIntervalSec * 1000)) {
      state.lastAnalysisAt = t; did.push("analysis");
      try { await runAnalysis(ctx); } catch (e) { state.lastError = { at: iso(t), message: "تحلیل بازار: " + errMsg(e) }; state.lastErrorAt = iso(t); await addEvent("engine_error", errMsg(e)); }
    }
    if (did.length) {
      const rc = computeRisk(ctx); state.peak = { ...(state.peak || {}), [ctl.mode]: rc.peak };
      if (rc.drawdownPct >= s.maxDrawdownPct && !state.drawdownFlag) { state.drawdownFlag = true; await addEvent("risk_halt", `سقف افت سرمایه (${s.maxDrawdownPct}٪) نقض شد؛ ورود جدید مسدود است.`); }
      if (rc.drawdownPct < s.maxDrawdownPct) state.drawdownFlag = false;
      await save(K.state, state);
    }
    return { did };
  }

  // ---------- پیشنهاد قابل‌اجرا (چه ارزی، چقدر، کی بفروشد) ----------
  const nf = (n) => Math.round(Number(n)).toLocaleString("en-US");
  const dpOf = (info) => (Number.isFinite(info.tick) && info.tick >= 0 ? info.tick : 0);
  function buildSuggestion(coinId, a, info, s, balances) {
    if (!info || (a.signal !== "buy" && a.signal !== "sell") || !a.entry) return null;
    const dp = stepDp(info); const price = a.signal === "buy" ? info.ask : info.bid; const notes = [];
    if (a.signal === "buy") {
      let amount = s.maxOrderIrt;
      const tmn = balances ? (balances.find((x) => x.cur === "tmn") || {}).available : undefined;
      if (Number.isFinite(tmn) && tmn * 0.98 < amount) { amount = tmn * 0.98; notes.push("مبلغ به‌اندازه‌ی موجودی تومانی شما (با کمی حاشیه) کاهش یافت."); }
      const qty = floorQty(amount / price, info.step); const cost = qty * price;
      if (!(qty > 0) || (info.minNotional > 0 && cost < info.minNotional)) notes.push("با سقف/موجودی فعلی به حداقل سفارش صرافی نمی‌رسد؛ سقف هر معامله را در تنظیمات بالاتر ببرید یا موجودی را افزایش دهید.");
      const sellPlan = [`حد سود: ${nf(a.takeProfit)} تومان (حدود ${(((a.takeProfit / price) - 1) * 100).toFixed(1)}٪ بالاتر از ورود) — با رسیدن به آن بفروشید.`,
        `حد ضرر: ${nf(a.stop)} تومان (حدود ${(((1 - a.stop / price)) * 100).toFixed(1)}٪ پایین‌تر) — اگر قیمت به آن رسید برای محدود کردن زیان بفروشید.`,
        `اگر روند نزولی شد یا RSI به ${s.params.rsiExit} رسید، همین‌جا سیگنال فروش اعلام می‌شود.`, `سقف زمان نگهداری پیشنهادی: ${s.maxHoldHours} ساعت.`];
      return { side: "buy", coinId, price: decimalStr(price, dpOf(info)), qty: decimalStr(qty, dp), amountIrt: round(cost), stop: a.stop, takeProfit: a.takeProfit, rr: a.rr, sellPlan, notes,
        sizing: `مبلغ = سقف هر معامله در تنظیمات (${nf(s.maxOrderIrt)} تومان)` + (notes.length ? " با اصلاح بالا" : "") + ". حد ضرر و سود باید خودتان پایش کنید (در سفارش دستی خودکار نیست)." };
    }
    const w = balances ? balances.find((x) => x.cur === coinId) : null; const qty = w ? floorQty(w.available, info.step) : null;
    if (qty === null) notes.push("موجودی شما در دسترس نبود؛ مقدار را خودتان وارد کنید.");
    return { side: "sell", coinId, price: decimalStr(price, dpOf(info)), qty: qty !== null ? decimalStr(qty, dp) : "", amountIrt: qty !== null ? round(qty * price) : null, sellPlan: a.exitReasons || [], notes, sizing: "فروش کل موجودی این ارز پیشنهاد شده؛ هر مقدار خواستید تغییر دهید." };
  }

  // ---------- فید گزارش (صفحه‌ی گفتگوی فقط‌خواندنی) ----------
  const SIG_FA = { buy: "خرید", sell: "فروش" };
  const EXIT_FA = { stop: "حد ضرر", take_profit: "حد سود", signal: "سیگنال خروج", timeout: "پایان زمان نگهداری", manual: "بستن دستی", manual_resolved: "رفع دستی" };
  const KIND_FA = { strategy: "خرید خودکار", dca: "خرید دوره‌ای (DCA)", manual: "سفارش هوشمند دستی" };
  const OUT_FA = { pending: "هنوز نتیجه‌ای نشده", take_profit: "به حد سود رسید ✅", stop: "به حد ضرر خورد ❌", expired: "بدون رسیدن به حد سود/ضرر منقضی شد" };
  async function buildFeed() {
    const ctl = await getCtl(); const s = await getSettings(); const state = await load(K.state, {});
    const trades = await load(K.trades, []); const signals = await load(K.signals, []); const events = await load(K.events, []);
    const tfMs = TF_MS[s.timeframe]; const msgs = []; const seen = new Set();
    const push = (m) => { if (seen.has(m.id)) return; seen.add(m.id); msgs.push({ important: false, severity: "info", lines: [], ...m }); };
    const modeFa = ctl.mode === "live" ? "واقعی" : "آزمایشی";
    if (ctl.mode === "suggest") {
      for (const a of Object.values(state.analysis || {})) {
        const sym = a.symbol || `${a.coinId.toUpperCase()}/IRT`;
        if (a.error || (a.dataQuality && !a.dataQuality.ok)) push({ id: `err:${a.coinId}`, t: a.analyzedAt, kind: "analysis", severity: "warn", title: `${sym}: تحلیل معتبر نیست`, lines: (a.dataQuality && a.dataQuality.issues) || [a.error] });
        else if ((a.signal === "buy" || a.signal === "sell") && a.suggestion) {
          const g = a.suggestion; const lines = [...(a.reasons || []).map((r) => "• " + r)];
          lines.push(`قیمت لحظه‌ای: ${nf(a.marketPrice || g.price)} تومان | RSI ${a.indicators.rsi.toFixed(0)} | امتیاز انطباق ${a.score}/100`);
          if (g.side === "buy") lines.push(`چقدر بخرید: ${g.qty} ${a.coinId.toUpperCase()} ≈ ${nf(g.amountIrt)} تومان`, `قیمت ورود پیشنهادی: ${g.price} تومان`);
          else lines.push(g.qty ? `چقدر بفروشید: ${g.qty} ${a.coinId.toUpperCase()} ≈ ${nf(g.amountIrt)} تومان` : "مقدار فروش را خودتان وارد کنید.");
          push({ id: `now:${a.coinId}:${a.candleT}:${a.signal}`, t: iso(a.candleT + tfMs), kind: "suggestion", important: true, severity: g.side === "buy" ? "good" : "warn", title: `پیشنهاد ${SIG_FA[a.signal]} ${sym}`,
            lines, sellPlan: g.sellPlan, notes: [...g.notes, g.sizing, a.scoreNote, ...((a.dataQuality && a.dataQuality.warnings) || [])].filter(Boolean),
            action: { type: "trade", coinId: a.coinId, side: g.side, qty: g.qty, price: g.price, amountIrt: g.amountIrt } });
        } else push({ id: `none:${a.coinId}`, t: a.analyzedAt, kind: "analysis", title: `${sym}: فعلاً ${a.holding ? "فروشی" : "خریدی"} پیشنهاد نمی‌شود`, lines: (a.reasons || []).map((r) => "• " + r) });
      }
      for (const sg of signals.filter((x) => x.mode === "suggest").slice(-20)) {
        if (seen.has(`now:${sg.coinId}:${sg.candleT}:${sg.signal}`)) continue;
        push({ id: `past:${sg.id}`, t: iso(sg.candleT + tfMs), kind: "suggestion_past", title: `پیشنهاد قبلی: ${SIG_FA[sg.signal]} ${sg.symbol}`,
          lines: [`قیمت ورود ${nf(sg.entry)} | حد ضرر ${sg.stop ? nf(sg.stop) : "—"} | حد سود ${sg.takeProfit ? nf(sg.takeProfit) : "—"}`, sg.outcome ? "نتیجه: " + (OUT_FA[sg.outcome.status] || sg.outcome.status) : ""].filter(Boolean) });
      }
    } else {
      for (const t of trades.filter((x) => x.mode === ctl.mode)) {
        if (!t.entry) continue; const sym = t.symbol; const e = t.entry; const warn = (t.warnings || []).slice(-2);
        push({ id: `open:${t.id}`, t: t.openedAt, kind: "trade_open", important: true, severity: "info", title: `${KIND_FA[t.kind] || "خرید"} ${sym} (${modeFa})`,
          lines: [`مقدار: ${e.qty} ${t.coinId.toUpperCase()} | قیمت: ${nf(e.price)} تومان${e.priceSource === "exchange" ? "" : " (تخمینی)"} | مبلغ: ${nf(e.costIrt)} تومان`,
            t.stop ? `حد ضرر: ${nf(t.stop)} | حد سود: ${t.takeProfit ? nf(t.takeProfit) : "—"}` : "بدون حد ضرر/سود خودکار", t.reasonIn ? "دلیل ورود: " + t.reasonIn.split(" | ").join(" • ") : "", ...warn].filter(Boolean) });
        if (t.status === "closed" && t.exit) push({ id: `close:${t.id}`, t: t.closedAt, kind: "trade_close", important: true, severity: t.pnlIrt > 0 ? "good" : t.pnlIrt < 0 ? "bad" : "info", title: `فروش ${sym} — ${EXIT_FA[t.exitReason] || t.exitReason} (${modeFa})`,
          lines: [t.exit.price ? `قیمت فروش: ${nf(t.exit.price)} تومان${t.exit.priceSource === "exchange" ? "" : " (تخمینی)"}` : "", Number.isFinite(t.pnlIrt) ? `سود/زیان خالص: ${nf(t.pnlIrt)} تومان (${t.pnlPct.toFixed(2)}٪) پس از کارمزد` : "سود/زیان ثبت نشد (رفع دستی)", `مدت نگهداری: ${Math.max(1, Math.round((Date.parse(t.closedAt) - Date.parse(t.openedAt)) / 60000))} دقیقه`].filter(Boolean) });
        if (t.status === "needs_review") push({ id: `review:${t.id}`, t: t.openedAt, kind: "alert", important: true, severity: "bad", title: `${sym}: نیازمند بررسی دستی`, lines: warn.length ? warn : ["وضعیت سفارش نامشخص است؛ در والکس بررسی کنید."] });
      }
      for (const sg of signals.filter((x) => x.mode === ctl.mode && (x.status === "blocked" || x.status === "skipped")).slice(-10))
        push({ id: `skip:${sg.id}`, t: sg.at, kind: "alert", severity: "warn", title: `سیگنال ${SIG_FA[sg.signal]} ${sg.symbol} اجرا نشد`, lines: [sg.statusNote] });
    }
    const SYS = { risk_block: "هشدار ریسک", risk_halt: "توقف ریسکی", needs_review: "نیازمند بررسی", kill_switch: "توقف اضطراری", kill_cleared: "لغو توقف اضطراری", mode_changed: "تغییر حالت", start: "شروع موتور", stop: "توقف موتور", pause: "توقف موقت", restart_pause: "توقف پس از ری‌استارت", engine_error: "خطای موتور" };
    for (const ev of events.slice(-25)) if (SYS[ev.type]) push({ id: `ev:${ev.t}:${ev.type}`, t: ev.t, kind: "system", important: ["risk_halt", "needs_review", "kill_switch", "engine_error"].includes(ev.type), severity: ["risk_halt", "needs_review", "kill_switch", "engine_error"].includes(ev.type) ? "bad" : "info", title: SYS[ev.type], lines: [ev.detail] });
    msgs.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
    const out = msgs.slice(-60); const imp = out.filter((m) => m.important).map((m) => Date.parse(m.t));
    return { mode: ctl.mode, running: ctl.running, killed: ctl.killed, messages: out, latestImportantAt: imp.length ? iso(Math.max(...imp)) : null, serverTime: iso(now()),
      emptyHint: ctl.mode === "suggest" ? "هنوز تحلیلی انجام نشده؛ موتور باید در حال اجرا باشد." : "هنوز معامله‌ای انجام نشده است." };
  }

  // ---------- خروجی‌های API ----------
  async function buildStatus() {
    const ctl = await getCtl(); const s = await getSettings(); const state = await load(K.state, {}); const trades = await load(K.trades, []);
    let mk = null, marketError = null; try { mk = await getMarkets(); } catch (e) { marketError = errMsg(e); }
    const rc = computeRisk({ trades, ctl, settings: s, mk, state, t: now() }); const gate = liveGate(ctl);
    const mt = trades.filter((x) => x.mode === ctl.mode);
    return { mode: ctl.mode, running: ctl.running, killed: ctl.killed, killReason: ctl.killReason, killedAt: ctl.killedAt, liveConfirmedAt: ctl.liveConfirmedAt,
      live: { serverUnlocked: gate.serverUnlocked, lockReasons: gate.reasons, confirmed: gate.confirmed, confirmPhrase: LIVE_CONFIRM_PHRASE },
      exchange: { keyConfigured: hasKey(), marketOk: !!mk && !mk.stale, marketStale: !!(mk && mk.stale), marketError },
      engine: { lastTickAt: lastTickAt ? iso(lastTickAt) : null, lastAnalysisAt: state.lastAnalysisAt ? iso(state.lastAnalysisAt) : null, lastError: state.lastError || null, strategy: s.strategy, timeframe: s.timeframe },
      openPositionsPolicy: s.onStop,
      openPositionsPolicyText: s.onStop === "manage" ? "پس از توقف/توقف اضطراری، حد سود و ضرر موقعیت‌های باز همچنان پایش می‌شود (هیچ موقعیتی ناگهانی بسته نمی‌شود)." : "پس از توقف هیچ اقدامی روی موقعیت‌های باز انجام نمی‌شود (حد سود/ضرر هم پایش نمی‌شود).",
      counts: { open: mt.filter((x) => x.status === "open" || x.status === "holding").length, needsReview: trades.filter((x) => x.status === "needs_review").length },
      pnl: { realizedTodayIrt: round(rc.realizedToday), realizedTotalIrt: round(rc.realizedTotal), unrealizedIrt: round(rc.unrealized), totalIrt: round(rc.total), drawdownPct: rc.drawdownPct, dailyLossIrt: round(rc.dailyLoss), exposureIrt: round(rc.exposure), paperCashIrt: ctl.mode === "paper" ? round(rc.paperCash) : null },
      analysis: state.analysis || {}, limits: { maxOrderIrt: s.maxOrderIrt, serverCapIrt: tradingState().cap } };
  }

  function perf(trades, mode) {
    const closed = trades.filter((x) => x.mode === mode && x.status === "closed" && Number.isFinite(x.pnlIrt)).sort((a, b) => Date.parse(a.closedAt) - Date.parse(b.closedAt));
    const wins = closed.filter((x) => x.pnlIrt > 0), losses = closed.filter((x) => x.pnlIrt <= 0);
    let eq = 0, peak = 0, mdd = 0; for (const x of closed) { eq += x.pnlIrt; peak = Math.max(peak, eq); mdd = Math.max(mdd, peak - eq); }
    const gw = sum(wins, (x) => x.pnlIrt), gl = -sum(losses, (x) => x.pnlIrt); const byReason = {};
    for (const x of closed) byReason[x.exitReason] = (byReason[x.exitReason] || 0) + 1;
    return { closedTrades: closed.length, wins: wins.length, losses: losses.length, winRatePct: closed.length ? (wins.length / closed.length) * 100 : null, netPnlIrt: round(sum(closed, (x) => x.pnlIrt)),
      feesIrt: round(sum(closed, (x) => Number(x.entry.feeIrt) + Number(x.exit.feeIrt))), avgWinIrt: wins.length ? round(gw / wins.length) : null, avgLossIrt: losses.length ? round(-gl / losses.length) : null,
      profitFactor: gl > 0 ? gw / gl : null, maxDrawdownIrt: round(mdd), byExitReason: byReason, openPositions: trades.filter((x) => x.mode === mode && (x.status === "open" || x.status === "holding")).length,
      note: "بر پایه‌ی معاملات بسته‌شده؛ در حالت واقعی قیمت/کارمزد اجرا در صورت نبود داده‌ی صرافی تخمینی است (فیلد priceSource هر معامله)." };
  }

  const cleanId = (v) => { const id = String(v || ""); if (!/^[A-Za-z0-9]{6,40}$/.test(id)) throw bad(400, "BAD_ID", "شناسه نامعتبر است."); return id; };
  const posNum = (v, name) => { const n = Number(v); if (!(n > 0) || !Number.isFinite(n)) throw bad(400, "INVALID", `${name} باید عدد مثبت باشد.`); return n; };

  async function makeCtx() {
    const ctl = await getCtl(); const s = await getSettings(); const state = await load(K.state, {}); const trades = await load(K.trades, []);
    const mk = await getMarkets(); return { mk, settings: s, ctl, trades, state, t: now() };
  }

  async function handle(method, sub, query, body) {
    await withLock(recoverOnce); // بازیابی پس از راه‌اندازی، پیش از هر عملیات (حتی قبل از اولین تیک)
    const route = `${method} ${sub.replace(/\/+$/, "") || "/"}`; let m;
    switch (route) {
      case "GET /status": return buildStatus();
      case "GET /feed": return buildFeed();
      case "GET /settings": return { settings: await getSettings(), defaults: DEFAULT_SETTINGS, allowedCoins, serverCapIrt: tradingState().cap };
      case "PUT /settings": return withLock(async () => {
        const cur = await getSettings(); const v = validateSettings(body, { current: cur, allowedCoins, envCapIrt: tradingState().cap });
        if (!v.ok) throw bad(400, "INVALID_SETTINGS", v.errors.join(" "), { public: { errors: v.errors } });
        await save(K.settings, v.settings); await addEvent("settings_changed", "تنظیمات استراتژی/ریسک تغییر کرد: " + Object.keys(body || {}).join(", "));
        return { settings: v.settings };
      });
      case "GET /signals": {
        const limitN = Math.min(200, Math.max(1, Number(query.get("limit")) || 50)); const all = await load(K.signals, []); const items = all.slice().reverse();
        const st = {}; for (const x of all) if (x.outcome) st[x.outcome.status] = (st[x.outcome.status] || 0) + 1;
        return { items: items.slice(0, limitN), total: all.length, outcomes: st, note: "سیگنال معامله نیست؛ تاریخچه‌ی سیگنال‌ها از معاملات جداست." };
      }
      case "GET /trades": {
        const mode = query.get("mode"), status = query.get("status"); const limitN = Math.min(500, Math.max(1, Number(query.get("limit")) || 100));
        let all = (await load(K.trades, [])).slice().reverse();
        if (mode) all = all.filter((x) => x.mode === mode); if (status) all = all.filter((x) => x.status === status);
        return { items: all.slice(0, limitN), total: all.length };
      }
      case "GET /performance": { const trades = await load(K.trades, []); return { paper: perf(trades, "paper"), live: perf(trades, "live") }; }
      case "GET /events": { const ev = await load(K.events, []); return { items: ev.slice(-100).reverse() }; }
      case "POST /analyze": { limit("analyze", 10); return { result: await tick({ forceAnalysis: true }), status: await buildStatus() }; }
      case "POST /mode": return setMode(body);
      case "POST /start": return startEngine();
      case "POST /pause": limit("ctl", 20); await patchCtl((c) => { c.running = false; }); await addEvent("pause", "موتور متوقف موقت شد."); return buildStatus();
      case "POST /stop": return stopEngine();
      case "POST /emergency-stop": return emergencyStop(body);
      case "POST /emergency-stop/clear": {
        if (!body || body.confirm !== true) throw bad(400, "CONFIRM_REQUIRED", "برای لغو توقف اضطراری confirm=true لازم است.");
        await patchCtl((c) => { c.killed = false; c.killReason = null; c.running = false; }); await addEvent("kill_cleared", "توقف اضطراری لغو شد؛ موتور همچنان متوقف است و باید دستی شروع شود."); return buildStatus();
      }
      case "POST /backtest": return runBacktest(body);
      case "GET /dca": return { plans: await load(K.dca, []) };
      case "PUT /dca": return putDca(body);
      case "POST /trades": return openManual(body);
    }
    if ((m = sub.match(/^\/trades\/([A-Za-z0-9]+)\/(close|update|resolve)$/)) && method === "POST") return tradeAction(cleanId(m[1]), m[2], body);
    throw bad(404, "NOT_FOUND", "مسیر یافت نشد.");
  }

  async function setMode(body) {
    limit("ctl", 20);
    const mode = body && body.mode; if (!["suggest", "paper", "live"].includes(mode)) throw bad(400, "INVALID_MODE", "حالت باید suggest، paper یا live باشد.");
    const trades = await load(K.trades, []); const ctl = await getCtl();
    const blocking = trades.filter((x) => x.mode !== mode && LIVE_OPEN.includes(x.status));
    if (blocking.length) throw bad(409, "OPEN_POSITIONS_OTHER_MODE", `${blocking.length} موقعیت باز یا نامشخص در حالت «${blocking[0].mode}» وجود دارد؛ ابتدا آن‌ها را ببندید/بررسی کنید.`);
    if (mode === "live") {
      const gate = liveGate(ctl);
      if (!gate.serverUnlocked) throw bad(403, "LIVE_LOCKED_BY_SERVER", "معامله‌ی واقعی در تنظیمات سرور فعال نیست (TRADING_ENABLED و AUTO_TRADING_ENABLED باید true باشند و کلید API/سقف سفارش تنظیم شده باشد).", { public: { reasons: gate.reasons } });
      if (body.confirm !== LIVE_CONFIRM_PHRASE || body.ack !== true) throw bad(400, "CONFIRM_REQUIRED", `برای فعال‌سازی حالت واقعی باید عبارت دقیق «${LIVE_CONFIRM_PHRASE}» را بفرستید و ack=true بگذارید.`);
      if (ctl.killed) throw bad(409, "KILL_SWITCH_ACTIVE", "ابتدا توقف اضطراری را لغو کنید.");
      try { await getMarkets(); await getBalances(); } catch (e) { throw bad(502, "EXCHANGE_UNREACHABLE", "اتصال به والکس/حساب برقرار نیست؛ حالت واقعی فعال نشد: " + errMsg(e)); }
    }
    await patchCtl((c) => { c.mode = mode; c.running = mode === "suggest"; c.liveConfirmedAt = mode === "live" ? iso(now()) : null; });
    await addEvent("mode_changed", `حالت از «${ctl.mode}» به «${mode}» تغییر کرد.`, { from: ctl.mode, to: mode });
    return buildStatus();
  }
  async function startEngine() {
    limit("ctl", 20); const ctl = await getCtl();
    if (ctl.killed) throw bad(409, "KILL_SWITCH_ACTIVE", "توقف اضطراری فعال است؛ ابتدا آن را لغو کنید.");
    if (ctl.mode === "live") { const g = liveGate(ctl); if (!g.serverUnlocked || !g.confirmed) throw bad(403, "LIVE_NOT_CONFIRMED", "حالت واقعی باید دوباره با تأیید صریح فعال شود."); }
    await patchCtl((c) => { c.running = true; c.startedAt = iso(now()); }); await addEvent("start", `موتور در حالت «${ctl.mode}» شروع شد.`);
    return buildStatus();
  }
  async function stopEngine() {
    limit("ctl", 20); const trades = await load(K.trades, []); const ctl = await getCtl();
    const open = trades.some((x) => x.mode === ctl.mode && LIVE_OPEN.includes(x.status));
    await patchCtl((c) => { c.running = false; if (!open) { c.mode = "suggest"; c.liveConfirmedAt = null; } });
    await addEvent("stop", open ? "موتور متوقف شد؛ موقعیت‌های باز طبق سیاست انتخاب‌شده مدیریت می‌شوند." : "موتور متوقف و به حالت ایمن (پیشنهاد) برگشت.");
    return buildStatus();
  }
  async function emergencyStop(body) {
    const reason = String((body && body.reason) || "توقف اضطراری دستی").slice(0, 200);
    await patchCtl((c) => { c.killed = true; c.killReason = reason; c.killedAt = iso(now()); c.running = false; c.liveConfirmedAt = null; });
    await addEvent("kill_switch", reason);
    const s = await getSettings(); const trades = await load(K.trades, []); const open = trades.filter((x) => LIVE_OPEN.includes(x.status));
    return { killed: true, reason, openPositions: open.map((x) => ({ id: x.id, mode: x.mode, coinId: x.coinId, status: x.status })), policy: s.onStop,
      message: "ایجاد معامله‌ی جدید متوقف شد و حالت واقعی غیرمسلح شد. هیچ موقعیت بازی به‌صورت ناگهانی بسته نشد. " + (s.onStop === "manage" ? "حد سود/ضرر موقعیت‌های باز همچنان پایش می‌شود." : "پایش حد سود/ضرر هم متوقف است (سیاست freeze)."), status: await buildStatus() };
  }

  async function openManual(body) {
    limit("manual", 10);
    return withLock(async () => {
      const ctx = await makeCtx(); const { ctl, settings: s } = ctx;
      if (ctl.mode === "suggest") throw bad(409, "MODE_SUGGEST", "در حالت تحلیل و پیشنهاد سفارشی باز نمی‌شود؛ حالت آزمایشی یا واقعی را فعال کنید.");
      if (ctl.mode === "live" && !ctl.running) throw bad(409, "ENGINE_NOT_RUNNING", "در حالت واقعی ابتدا موتور را شروع کنید.");
      if (!ctl.running && s.onStop !== "manage") throw bad(409, "NOT_MANAGED", "با سیاست freeze و موتور متوقف، حد سود/ضرر پایش نمی‌شود؛ ابتدا موتور را شروع کنید.");
      const coinId = String((body && body.coinId) || "").toLowerCase(); if (!allowedCoins.includes(coinId)) throw bad(400, "INVALID", "ارز نامعتبر است.");
      const amountIrt = posNum(body.amountIrt, "مبلغ"); const stop = posNum(body.stop, "حد ضرر");
      const takeProfit = body.takeProfit === undefined || body.takeProfit === null || body.takeProfit === "" ? null : posNum(body.takeProfit, "حد سود");
      const trailingPct = body.trailingPct ? posNum(body.trailingPct, "درصد تریلینگ") : null; if (trailingPct && (trailingPct < 0.5 || trailingPct > 50)) throw bad(400, "INVALID", "درصد تریلینگ باید بین ۰٫۵ و ۵۰ باشد.");
      const reqId = String((body && body.requestId) || ""); if (!/^[A-Za-z0-9]{8,40}$/.test(reqId)) throw bad(400, "INVALID", "requestId (۸ تا ۴۰ حرف/عدد) برای جلوگیری از ثبت تکراری لازم است.");
      const r = await openPosition({ kind: "manual", coinId, amountIrt, stop, takeProfit, trailingPct, reason: "سفارش هوشمند دستی (ورود + حد ضرر/سود نرم‌افزاری)", seed: reqId, ignoreRunning: true }, ctx);
      if (!r.ok) throw bad(422, "RISK_BLOCKED", r.failures.map((f) => f.message).join(" | "), { public: { failures: r.failures } });
      await addEvent("manual_open", `${r.trade.symbol} ${r.trade.mode}`, { tradeId: r.trade.id });
      return { trade: r.trade };
    });
  }
  async function tradeAction(id, action, body) {
    limit("manual", 20);
    return withLock(async () => {
      const ctx = await makeCtx(); const t = ctx.trades.find((x) => x.id === id); if (!t) throw bad(404, "NOT_FOUND", "معامله یافت نشد.");
      if (action === "resolve") {
        if (t.status !== "needs_review") throw bad(409, "NOT_REVIEW", "فقط معامله‌های «نیازمند بررسی» قابل رفع هستند.");
        const act = body && body.action; const note = String((body && body.note) || "").slice(0, 300);
        if (act === "reopen") { t.status = t.kind === "dca" ? "holding" : "open"; t.exitFailures = 0; delete t.exitPending; t.warnings.push("کاربر موقعیت را بررسی و دوباره باز اعلام کرد. " + note); }
        else if (act === "mark_closed") { t.status = "closed"; t.closedAt = iso(now()); t.exitReason = "manual_resolved"; t.exit = { reason: "manual_resolved", at: t.closedAt, note, price: null, proceedsIrt: null, feeIrt: null }; t.pnlIrt = null; t.pnlPct = null; }
        else throw bad(400, "INVALID", "action باید reopen یا mark_closed باشد.");
        await save(K.trades, ctx.trades); await addEvent("trade_resolved", `${t.id}: ${act}`); return { trade: t };
      }
      if (t.status !== "open" && t.status !== "holding") throw bad(409, "NOT_OPEN", "این معامله باز نیست.");
      if (t.mode !== ctx.ctl.mode) throw bad(409, "OTHER_MODE", `این معامله مربوط به حالت «${t.mode}» است؛ ابتدا همان حالت را فعال کنید.`);
      if (action === "close") {
        const r = await closePosition(t, "manual", ctx);
        if (!r.ok) throw bad(422, "CLOSE_FAILED", (r.failures || []).map((f) => f.message).join(" | ") || "بستن موقعیت ناموفق بود.");
        await addEvent("manual_close", t.id); return { trade: t };
      }
      const info = marketInfo(ctx.mk, t.coinId); if (!info) throw bad(502, "NO_PRICE", "قیمت بازار در دسترس نیست.");
      if (body.stop !== undefined) { const v = body.stop === null ? null : posNum(body.stop, "حد ضرر"); if (v !== null && v >= info.bid) throw bad(400, "INVALID", "حد ضرر باید زیر قیمت فعلی باشد."); t.stop = v; }
      if (body.takeProfit !== undefined) { const v = body.takeProfit === null ? null : posNum(body.takeProfit, "حد سود"); if (v !== null && v <= info.bid) throw bad(400, "INVALID", "حد سود باید بالای قیمت فعلی باشد."); t.takeProfit = v; }
      if (body.trailingPct !== undefined) { const v = body.trailingPct ? posNum(body.trailingPct, "درصد تریلینگ") : null; if (v && (v < 0.5 || v > 50)) throw bad(400, "INVALID", "درصد تریلینگ باید بین ۰٫۵ و ۵۰ باشد."); t.trailingPct = v; }
      if (t.stop === null && t.takeProfit === null && !t.trailingPct) throw bad(400, "INVALID", "حداقل یکی از حد ضرر/سود/تریلینگ باید باقی بماند.");
      await save(K.trades, ctx.trades); await addEvent("trade_updated", t.id); return { trade: t };
    });
  }

  async function putDca(body) {
    return withLock(async () => {
      const s = await getSettings(); const list = body && Array.isArray(body.plans) ? body.plans : null; if (!list || list.length > 10) throw bad(400, "INVALID", "plans باید آرایه‌ای حداکثر ۱۰ عضوی باشد.");
      const old = await load(K.dca, []); const plans = []; const t = now();
      for (const p of list) {
        const coinId = String(p.coinId || "").toLowerCase(); if (!s.coins.includes(coinId)) throw bad(400, "INVALID", `ارز ${coinId} در فهرست مجاز معامله‌ی خودکار نیست.`);
        const amountIrt = posNum(p.amountIrt, "مبلغ"); if (amountIrt > s.maxOrderIrt) throw bad(400, "INVALID", `مبلغ هر خرید دوره‌ای نباید از سقف هر معامله (${s.maxOrderIrt}) بیشتر باشد.`);
        const intervalHours = posNum(p.intervalHours, "فاصله"); if (intervalHours < 1 || intervalHours > 24 * 30) throw bad(400, "INVALID", "فاصله باید بین ۱ ساعت و ۳۰ روز باشد.");
        const prev = old.find((x) => x.id === p.id); const id = prev ? prev.id : "p" + hashId(coinId + "|" + t + "|" + plans.length);
        plans.push({ id, coinId, amountIrt, intervalHours, enabled: p.enabled !== false, runs: prev ? prev.runs : 0, lastRunAt: prev ? prev.lastRunAt : null, lastResult: prev ? prev.lastResult : null,
          nextRunAt: prev && prev.intervalHours === intervalHours ? prev.nextRunAt : t + intervalHours * 3600000 });
      }
      await save(K.dca, plans); await addEvent("dca_changed", `${plans.length} برنامه‌ی خرید دوره‌ای ذخیره شد.`);
      return { plans, note: "خرید دوره‌ای فقط در حالت آزمایشی/واقعی و با موتور در حال اجرا انجام می‌شود و از همان دروازه‌ی ریسک می‌گذرد." };
    });
  }

  async function runBacktest(body) {
    limit("backtest", 5);
    const s0 = await getSettings(); const v = validateSettings(body && body.settings, { current: s0, allowedCoins, envCapIrt: tradingState().cap });
    if (!v.ok) throw bad(400, "INVALID_SETTINGS", v.errors.join(" "));
    const s = v.settings; const coinId = String((body && body.coinId) || s.coins[0]).toLowerCase(); if (!allowedCoins.includes(coinId)) throw bad(400, "INVALID", "ارز نامعتبر است.");
    const tf = (body && body.timeframe) || s.timeframe; if (!TF_MS[tf]) throw bad(400, "INVALID", "تایم‌فریم نامعتبر است."); s.timeframe = tf;
    const days = Number((body && body.days) || 30); if (!Number.isInteger(days) || days < 7 || days > 90) throw bad(400, "INVALID", "days باید عدد صحیح بین ۷ و ۹۰ باشد.");
    const ohlc = await fetchOhlc(coinId, tf, days); const t = now();
    const candles = ohlc.candles.filter((c) => c.t + TF_MS[tf] <= t);
    const r = backtest(candles, ohlc.meta, s);
    return { coinId, timeframe: tf, requestedDays: days, dataSource: "والکس udf/history (کندل ۱ساعته)", disclaimer: "نتیجه‌ی تاریخی است و سودآوری آینده را تضمین نمی‌کند.", ...r };
  }

  return { handle, tick, LIVE_CONFIRM_PHRASE };
}
