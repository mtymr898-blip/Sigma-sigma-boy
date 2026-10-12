// ===================================================================
// Cloudflare Worker — واسط امن بین داشبورد و API نوبیتکس
// -------------------------------------------------------------------
// • توکن نوبیتکس (NOBITEX_TOKEN) فقط اینجا و فقط از Secrets خوانده می‌شود
//   و هرگز در پاسخ، لاگ یا مرورگر ظاهر نمی‌شود.
// • مرورگر فقط با «توکن نشست» کوتاه‌مدت (امضاشده با SESSION_SECRET) کار می‌کند
//   که پس از وارد کردن رمز دسترسی (DASHBOARD_PASSCODE) صادر می‌شود.
// • فقط endpointهای فهرست‌شده در این فایل به نوبیتکس می‌رسند (allowlist).
//   endpoint برداشت وجه اصلاً وجود ندارد.
//
// ⚠ UNVERIFIED: در محیط ساخت این پروژه به apidocs.nobitex.ir دسترسی نبود.
//   نام endpointها از فهرست خود کاربر آمده؛ نام فیلدهای JSON و پارامترها
//   از اطلاعات پیشین ساخته شده‌اند و باید با مستندات رسمی تطبیق داده شوند.
//   همه این فرض‌ها فقط در توابع normalize*/بدنه‌ی درخواست‌ها جمع شده‌اند و
//   اگر ساختار پاسخ با انتظار نخواند، خطای UNEXPECTED_RESPONSE برمی‌گردد
//   (به‌جای نمایش داده‌ی غلط یا ساختگی).
// ===================================================================

const NOBITEX_BASE = "https://api.nobitex.ir";
const UA = "nobitex-personal-dashboard/1.0";
const SESSION_TTL_SEC = 12 * 3600;
const CONFIRM_TTL_SEC = 120;

// فهرست ارزهای نمایش‌داده‌شده در بازار (فقط نام‌های فارسی نمایشی؛ قیمت‌ها همه از API می‌آیند)
const COINS = [
  { id: "btc", name: "بیت‌کوین" }, { id: "eth", name: "اتریوم" }, { id: "usdt", name: "تتر" },
  { id: "bnb", name: "بایننس کوین" }, { id: "sol", name: "سولانا" }, { id: "xrp", name: "ریپل" },
  { id: "doge", name: "دوج‌کوین" }, { id: "ada", name: "کاردانو" }, { id: "trx", name: "ترون" },
  { id: "ton", name: "تون‌کوین" },
];
const coinById = (id) => COINS.find((c) => c.id === id);

class HttpError extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; this.extra = extra; }
}
const unexpected = (what) => new HttpError(502, "UNEXPECTED_RESPONSE", `ساختار پاسخ نوبیتکس (${what}) با انتظار نمی‌خواند؛ لازم است با مستندات رسمی تطبیق داده شود.`);

// ---------- ابزارهای کوچک ----------
const enc = new TextEncoder();
const num = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));
const scale = (x, f) => (Number.isFinite(x) ? x * f : null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function b64u(bytes) {
  let s = ""; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function hmacB64u(secret, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data))));
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function decimalStr(n, maxDp = 8) {
  let s = Number(n).toFixed(maxDp);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
}
function toIso(v) {
  if (!v) return null;
  const s = String(v).replace(/(\.\d{3})\d+/, "$1");
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function maskEmail(e) {
  if (!e || typeof e !== "string" || !e.includes("@")) return null;
  const [u, d] = e.split("@"); return `${u.slice(0, 2)}***@${d}`;
}
function maskPhone(p) {
  if (!p) return null;
  const d = String(p).replace(/\D/g, ""); if (d.length < 6) return null;
  return `${d.slice(0, 4)}***${d.slice(-3)}`;
}

// ---------- پاسخ‌ها و CORS ----------
function ok(data, meta) {
  return new Response(JSON.stringify({ ok: true, data, meta: meta || null, fetchedAt: new Date().toISOString() }), {
    status: 200, headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
function errorResponse(e) {
  if (e instanceof HttpError) {
    const headers = { "Content-Type": "application/json; charset=utf-8" };
    if (e.extra.retryAfter) headers["Retry-After"] = String(e.extra.retryAfter);
    const error = { code: e.code, message: e.message };
    if (e.extra.public) Object.assign(error, e.extra.public);
    return new Response(JSON.stringify({ ok: false, error }), { status: e.status, headers });
  }
  return new Response(JSON.stringify({ ok: false, error: { code: "INTERNAL", message: "خطای داخلی سرور." } }),
    { status: 500, headers: { "Content-Type": "application/json; charset=utf-8" } });
}
function withHeaders(res, extra) {
  const h = new Headers(res.headers);
  h.set("Cache-Control", "no-store"); h.set("X-Content-Type-Options", "nosniff");
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return new Response(res.body, { status: res.status, headers: h });
}
function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const h = { Vary: "Origin" };
  if (origin && allowed.includes(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Headers"] = "Authorization, Content-Type";
    h["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    h["Access-Control-Max-Age"] = "600";
  }
  return h;
}

// ---------- حافظه موقت درون‌ایزوله (برای کم‌کردن فشار روی نوبیتکس) ----------
const memoStore = new Map();
function memo(key, ttlMs, fn) {
  const now = Date.now(); const hit = memoStore.get(key);
  if (hit && hit.exp > now) return hit.p;
  const p = fn().catch((e) => { memoStore.delete(key); throw e; });
  memoStore.set(key, { exp: now + ttlMs, p });
  if (memoStore.size > 200) for (const [k, v] of memoStore) if (v.exp <= now) memoStore.delete(k);
  return p;
}
function memoClear(prefix) { for (const k of [...memoStore.keys()]) if (k.startsWith(prefix)) memoStore.delete(k); }

// ---------- Durable Object: ذخیره‌ی اتمیک (سفارش‌ها، تاریخچه پرتفو، محدودیت ورود) ----------
export class DashboardStore {
  constructor(state) { this.state = state; }
  async fetch(req) {
    const url = new URL(req.url); const s = this.state.storage;
    const body = req.method === "POST" ? await req.json() : {};
    const out = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
    switch (url.pathname) {
      case "/order/claim": {
        const k = "order:" + body.id; const ex = await s.get(k);
        if (ex) return out({ claimed: false, record: ex });
        const rec = { state: "sending", at: Date.now(), order: body.order };
        await s.put(k, rec); return out({ claimed: true, record: rec });
      }
      case "/order/update": {
        const k = "order:" + body.id; const ex = await s.get(k);
        if (!ex) return out({ ok: false }, 404);
        const rec = { ...ex, ...body.patch, updatedAt: Date.now() }; await s.put(k, rec); return out({ ok: true, record: rec });
      }
      case "/snap/add": {
        let arr = (await s.get("snaps")) || []; const last = arr[arr.length - 1];
        if (last && body.t - last.t < body.minGapMs) return out({ added: false });
        arr.push({ t: body.t, v: body.v }); if (arr.length > 2500) arr = arr.slice(-2500);
        await s.put("snaps", arr); return out({ added: true });
      }
      case "/snap/list": return out({ snaps: (await s.get("snaps")) || [] });
      case "/rl/check": {
        const a = (await s.get("rl:" + body.key)) || []; const now = Date.now();
        const recent = a.filter((t) => now - t < body.windowMs);
        if (recent.length >= body.max) return out({ blocked: true, retryAfterSec: Math.ceil((recent[0] + body.windowMs - now) / 1000) });
        return out({ blocked: false });
      }
      case "/rl/fail": {
        const a = ((await s.get("rl:" + body.key)) || []).filter((t) => Date.now() - t < body.windowMs);
        a.push(Date.now()); await s.put("rl:" + body.key, a); return out({ ok: true });
      }
      case "/rl/clear": await s.delete("rl:" + body.key); return out({ ok: true });
      default: return out({ error: "not_found" }, 404);
    }
  }
}
async function store(env, path, body) {
  if (!env.STORE) throw new HttpError(503, "NO_STORE", "فضای ذخیره‌سازی (Durable Object) تنظیم نشده است.");
  const stub = env.STORE.get(env.STORE.idFromName("main"));
  const res = await stub.fetch("https://store.internal" + path, { method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : undefined });
  return res.json();
}

// ---------- احراز هویت نشست ----------
function requireConfig(env) {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32 || !env.DASHBOARD_PASSCODE)
    throw new HttpError(503, "NOT_CONFIGURED", "Secretهای SESSION_SECRET (حداقل ۳۲ کاراکتر) و DASHBOARD_PASSCODE تنظیم نشده‌اند.");
}
async function issueSession(env) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC;
  const nonce = b64u(crypto.getRandomValues(new Uint8Array(12)));
  const sig = await hmacB64u(env.SESSION_SECRET, `s.${exp}.${nonce}`);
  return { token: `${exp}.${nonce}.${sig}`, expiresAt: exp * 1000 };
}
async function requireSession(request, env) {
  requireConfig(env);
  const m = (request.headers.get("Authorization") || "").match(/^Bearer\s+(.+)$/);
  const parts = m ? m[1].split(".") : [];
  if (parts.length === 3 && Number(parts[0]) > Date.now() / 1000) {
    const want = await hmacB64u(env.SESSION_SECRET, `s.${parts[0]}.${parts[1]}`);
    if (safeEqual(want, parts[2])) return;
  }
  throw new HttpError(401, "SESSION_INVALID", "نشست معتبر نیست یا منقضی شده؛ دوباره وارد شوید.");
}

// ---------- ارتباط با نوبیتکس ----------
async function nobitexRaw(env, path, { method = "GET", query, body, auth = false, timeoutMs = 12000, attempts } = {}) {
  const url = new URL(NOBITEX_BASE + path);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  const headers = { Accept: "application/json", "User-Agent": UA };
  if (auth) {
    if (!env.NOBITEX_TOKEN) throw new HttpError(503, "TOKEN_NOT_CONFIGURED", "توکن نوبیتکس (NOBITEX_TOKEN) در Secrets تنظیم نشده است.");
    headers.Authorization = "Token " + env.NOBITEX_TOKEN;
  }
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const maxAttempts = attempts || (method === "GET" ? 2 : 1); // POST هرگز خودکار تکرار نمی‌شود
  let lastErr;
  for (let i = 1; i <= maxAttempts; i++) {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: ctl.signal });
      clearTimeout(timer);
      if (res.status >= 500 && i < maxAttempts) { await sleep(300); continue; }
      let json = null; try { json = JSON.parse(await res.text()); } catch (_) { /* غیر JSON */ }
      return { httpStatus: res.status, json, retryAfter: res.headers.get("Retry-After") };
    } catch (e) {
      clearTimeout(timer);
      lastErr = new HttpError(504, e && e.name === "AbortError" ? "UPSTREAM_TIMEOUT" : "UPSTREAM_NETWORK", "ارتباط با نوبیتکس برقرار نشد یا زمان آن تمام شد.");
      if (i < maxAttempts) await sleep(300);
    }
  }
  throw lastErr;
}
async function nobitex(env, path, opts = {}) {
  const { httpStatus, json, retryAfter } = await nobitexRaw(env, path, opts);
  if (httpStatus === 429) throw new HttpError(429, "RATE_LIMITED", "محدودیت تعداد درخواست نوبیتکس اعمال شد؛ کمی بعد دوباره تلاش کنید.", { retryAfter: Number(retryAfter) || 30 });
  if (httpStatus === 401 || httpStatus === 403) throw new HttpError(502, "UPSTREAM_AUTH", "نوبیتکس دسترسی را رد کرد: توکن نامعتبر است یا مجوز لازم را ندارد.");
  if (json && json.status === "failed") throw new HttpError(502, "UPSTREAM_FAILED", String(json.message || json.code || "درخواست توسط نوبیتکس ناموفق اعلام شد.").slice(0, 200), { public: { upstreamCode: json.code ? String(json.code).slice(0, 60) : undefined } });
  if (httpStatus < 200 || httpStatus >= 300 || !json) throw new HttpError(502, "UPSTREAM_ERROR", `پاسخ نامعتبر از نوبیتکس (HTTP ${httpStatus}).`);
  return json;
}

// ---------- بازار (عمومی) ----------
// UNVERIFIED: ساختار {stats:{"btc-rls":{latest,dayOpen,dayHigh,dayLow,bestBuy,bestSell,volumeDst,...}}}
function normStat(r, dst) {
  if (!r || typeof r !== "object") return null;
  const f = dst === "rls" ? 0.1 : 1; // ریال → تومان
  const latest = num(r.latest); if (!(latest > 0)) return null;
  const open = num(r.dayOpen);
  let change = open > 0 ? ((latest - open) / open) * 100 : num(r.dayChange);
  if (!Number.isFinite(change)) change = null;
  return { price: latest * f, change, high: scale(num(r.dayHigh), f), low: scale(num(r.dayLow), f),
    bestBuy: scale(num(r.bestBuy), f), bestSell: scale(num(r.bestSell), f), volume: scale(num(r.volumeDst), f) };
}
function getStats(env, srcs, dst) {
  return memo(`stats:${dst}:${srcs.join(",")}`, 8000, async () => {
    const out = {};
    const json = await nobitex(env, "/market/stats", { query: { srcCurrency: srcs.join(","), dstCurrency: dst } });
    if (!json.stats || typeof json.stats !== "object") throw unexpected("market/stats");
    for (const s of srcs) { const n = normStat(json.stats[`${s}-${dst}`], dst); if (n) out[s] = n; }
    // اگر ارسال چندارزی پشتیبانی نشده باشد، برای موارد جاافتاده تک‌تک می‌پرسیم (سقف ۱۵)
    for (const s of srcs.filter((x) => !out[x]).slice(0, 15)) {
      try {
        const j = await nobitex(env, "/market/stats", { query: { srcCurrency: s, dstCurrency: dst } });
        const n = normStat(j.stats && j.stats[`${s}-${dst}`], dst); if (n) out[s] = n;
      } catch (e) { if (e.code === "RATE_LIMITED") throw e; }
    }
    return out;
  });
}
async function getMarketCoins(env) {
  const st = await getStats(env, COINS.map((c) => c.id), "rls");
  const data = COINS.filter((c) => st[c.id]).map((c) => {
    const s = st[c.id];
    return { id: c.id, name: c.name, symbol: `${c.id.toUpperCase()}/IRT`, price: s.price, change24h: s.change, high24h: s.high, low24h: s.low, volume24h: s.volume, bestBuy: s.bestBuy, bestSell: s.bestSell };
  });
  if (!data.length) throw unexpected("market/stats (هیچ جفت‌ارزی معتبر نبود)");
  return { data, missing: COINS.filter((c) => !st[c.id]).map((c) => c.id) };
}
const RANGE_DAYS = { "24h": 1, "7d": 7, "30d": 30, "90d": 90 };
// UNVERIFIED: ساختار UDF {s:"ok", t:[...unix], c:[...]}
function getHistory(env, id, days) {
  if (!coinById(id)) throw new HttpError(404, "UNKNOWN_COIN", "ارز ناشناخته است.");
  return memo(`hist:${id}:${days}`, 10 * 60000, async () => {
    const to = Math.floor(Date.now() / 1000);
    const j = await nobitex(env, "/market/udf/history", { query: { symbol: `${id.toUpperCase()}IRT`, resolution: "D", from: to - days * 86400, to } });
    if (j.s === "no_data") return [];
    if (j.s === "error") throw new HttpError(502, "UPSTREAM_FAILED", String(j.errmsg || "خطا در دریافت تاریخچه").slice(0, 200));
    if (j.s !== "ok" || !Array.isArray(j.t) || !Array.isArray(j.c) || j.t.length !== j.c.length) throw unexpected("market/udf/history");
    return j.t.map((t, i) => ({ t: new Date(t * 1000).toISOString(), v: Number((num(j.c[i]) * 0.1).toFixed(2)) })).filter((p) => Number.isFinite(p.v));
  });
}
// UNVERIFIED: ساختار {bids:[[price,amount]...], asks:[...]}
async function getOrderbook(env, id) {
  if (!coinById(id)) throw new HttpError(404, "UNKNOWN_COIN", "ارز ناشناخته است.");
  return memo(`ob:${id}`, 3000, async () => {
    const j = await nobitex(env, `/v3/orderbook/${id.toUpperCase()}IRT`);
    const side = (a) => {
      if (!Array.isArray(a)) throw unexpected("v3/orderbook");
      return a.slice(0, 8).map((r) => ({ price: scale(num(r[0]), 0.1), amount: num(r[1]) })).filter((r) => r.price !== null && Number.isFinite(r.amount));
    };
    return { bids: side(j.bids), asks: side(j.asks) };
  });
}

// ---------- حساب (خصوصی) ----------
// UNVERIFIED: ساختار {wallets:[{currency,balance,activeBalance,blockedBalance}]} (یا شیء کلیددار)
function normalizeWallets(json) {
  let list = json && json.wallets;
  if (list && !Array.isArray(list) && typeof list === "object") list = Object.entries(list).map(([cur, w]) => ({ currency: cur, ...w }));
  if (!Array.isArray(list)) throw unexpected("users/wallets/list");
  const out = list.map((w) => {
    const total = num(w.balance); const locked = Number.isFinite(num(w.blockedBalance)) ? num(w.blockedBalance) : 0;
    const available = Number.isFinite(num(w.activeBalance)) ? num(w.activeBalance) : total - locked;
    return { cur: String(w.currency || "").toLowerCase(), total, available, locked };
  }).filter((w) => w.cur && Number.isFinite(w.total));
  if (list.length && !out.length) throw unexpected("users/wallets/list");
  return out;
}
async function getPrices(env, curs) {
  const out = {};
  const st = await getStats(env, curs, "rls");
  for (const c of curs) if (st[c]) out[c] = { priceIrt: st[c].price, change24h: st[c].change };
  const missing = curs.filter((c) => !out[c] && c !== "usdt");
  if (missing.length) { // جفت تومانی ندارد → از جفت تتری × نرخ تتر
    const usdtRls = out.usdt ? out.usdt.priceIrt : ((await getStats(env, ["usdt"], "rls")).usdt || {}).price;
    if (usdtRls) {
      const su = await getStats(env, missing, "usdt");
      for (const c of missing) if (su[c]) out[c] = { priceIrt: su[c].price * usdtRls, change24h: su[c].change };
    }
  }
  return out;
}
async function buildAssets(env) {
  const wallets = normalizeWallets(await memo("wallets", 5000, () => nobitex(env, "/users/wallets/list", { auth: true })));
  const held = wallets.filter((w) => w.total > 0 || w.locked > 0);
  const curs = [...new Set(held.map((w) => w.cur).filter((c) => c !== "rls"))];
  const prices = curs.length ? await getPrices(env, curs) : {};
  const assets = held.map((w) => {
    if (w.cur === "rls") return { coinId: "irt", name: "تومان", symbol: "IRT", total: w.total / 10, available: w.available / 10, locked: w.locked / 10, change24h: null, priceIrt: 1, valueIrt: w.total / 10 };
    const p = prices[w.cur];
    return { coinId: w.cur, name: (coinById(w.cur) || {}).name || w.cur.toUpperCase(), symbol: w.cur.toUpperCase(), total: w.total, available: w.available, locked: w.locked,
      change24h: p ? p.change24h : null, priceIrt: p ? p.priceIrt : null, valueIrt: p ? w.total * p.priceIrt : null };
  });
  assets.sort((a, b) => (b.valueIrt ?? -1) - (a.valueIrt ?? -1));
  return assets;
}
// UNVERIFIED: ساختار {orders:[{id,type,execution,status,srcCurrency,dstCurrency,price,amount,matchedAmount,created_at}]}
function normalizeOrders(json) {
  if (!json || !Array.isArray(json.orders)) throw unexpected("market/orders");
  return json.orders.map((o) => {
    const dst = String(o.dstCurrency || "").toLowerCase(); const f = dst === "rls" ? 0.1 : 1;
    return { id: String(o.id ?? "—"), side: String(o.type || "").toLowerCase(), execution: String(o.execution || ""), status: String(o.status || ""),
      src: String(o.srcCurrency || "").toLowerCase(), dst, price: scale(num(o.price), f), amount: num(o.amount), matched: num(o.matchedAmount),
      createdAt: toIso(o.created_at || o.createdAt) };
  });
}
const isOpen = (o) => ["active", "inactive"].includes(o.status.toLowerCase());
function fetchOrders(env, scope) {
  return memo(`orders:${scope}`, 5000, async () => normalizeOrders(await nobitex(env, "/market/orders/list", { auth: true, query: { status: scope } })));
}
function orderToRow(o) {
  const st = o.status.toLowerCase();
  const status = st === "done" ? "موفق" : isOpen(o) ? "در انتظار" : st === "canceled" ? "لغو شده" : o.status || "—";
  const pair = `${o.src.toUpperCase()}/${o.dst === "rls" ? "IRT" : o.dst.toUpperCase()}`;
  const parts = [`${o.execution || "سفارش"} ${pair}`];
  if (o.price !== null) parts.push(`قیمت ${o.price.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${o.dst === "rls" ? "تومان" : o.dst.toUpperCase()}`);
  if (isOpen(o) && o.matched > 0) parts.push("اجرای جزئی");
  return { id: o.id, date: o.createdAt, type: o.side === "buy" ? "خرید" : o.side === "sell" ? "فروش" : o.side || "—",
    coin: o.src.toUpperCase(), amount: o.matched > 0 && !isOpen(o) ? o.matched : o.amount, status, desc: parts.join(" · "), side: o.side, open: isOpen(o) };
}
// UNVERIFIED: ساختار {profile:{nickname,username,firstName,email,mobile,phone}}
function normalizeProfile(json) {
  const p = json && json.profile; if (!p || typeof p !== "object") throw unexpected("users/profile");
  return { username: p.nickname || p.username || p.firstName || null, accountId: null, phoneMasked: maskPhone(p.mobile || p.phone), emailMasked: maskEmail(p.email) };
}

// ---------- پرتفو ----------
async function buildPortfolio(env, { snapshot } = {}) {
  const assets = await buildAssets(env);
  let openOrders = null; let ordersError = null;
  try { openOrders = (await fetchOrders(env, "open")).filter(isOpen).length; } catch (e) { ordersError = e.code || "ERROR"; }
  const priced = assets.filter((a) => a.valueIrt !== null);
  const total = priced.reduce((s, a) => s + a.valueIrt, 0);
  const available = priced.reduce((s, a) => s + a.available * a.priceIrt, 0);
  let nowSum = 0, openSum = 0;
  for (const a of priced) if (a.change24h !== null) { nowSum += a.valueIrt; openSum += a.valueIrt / (1 + a.change24h / 100); }
  const unpriced = assets.length - priced.length;
  if (snapshot && unpriced === 0 && env.STORE) await store(env, "/snap/add", { t: Date.now(), v: Math.round(total), minGapMs: 20 * 60000 }).catch(() => {});
  return { summary: { totalValueIrt: total, availableValueIrt: available, assetCount: assets.length, openOrders, change24hPercent: openSum > 0 ? ((nowSum - openSum) / openSum) * 100 : null },
    meta: { unpricedAssets: unpriced, ordersError, changeNote: "تغییر ۲۴ساعته بر اساس موجودی فعلی و قیمت‌های امروز محاسبه می‌شود، نه تاریخچه واقعی ارزش پرتفو." } };
}
async function takeSnapshot(env) { if (env.NOBITEX_TOKEN && env.STORE) await buildPortfolio(env, { snapshot: true }); }

// ---------- سفارش‌گذاری ----------
function tradingState(env) {
  const reasons = [];
  if (env.TRADING_ENABLED !== "true") reasons.push("TRADING_DISABLED");
  if (!env.STORE) reasons.push("NO_STORE");
  if (!env.NOBITEX_TOKEN) reasons.push("NO_TOKEN");
  const cap = Number(env.MAX_ORDER_VALUE_IRT); if (!(cap > 0)) reasons.push("NO_CAP");
  return { enabled: reasons.length === 0, reasons, cap: cap > 0 ? cap : null };
}
function parseOrder(o) {
  const bad = (m) => new HttpError(400, "INVALID_ORDER", m);
  const coin = coinById(String((o && o.coinId) || "").toLowerCase()); if (!coin) throw bad("ارز نامعتبر است.");
  const side = o.side; if (!["buy", "sell"].includes(side)) throw bad("جهت سفارش باید خرید یا فروش باشد.");
  const execution = o.execution; if (!["limit", "market"].includes(execution)) throw bad("نوع سفارش باید محدود یا بازار باشد.");
  const amount = Number(o.amount); if (!(amount > 0) || !Number.isFinite(amount)) throw bad("مقدار نامعتبر است.");
  let price = null;
  if (execution === "limit") {
    const p = Number(o.price); if (!(p > 0) || !Number.isFinite(p)) throw bad("قیمت سفارش محدود نامعتبر است.");
    if (Math.abs(Math.round(p * 10) - p * 10) > 1e-6) throw bad("قیمت باید مضرب ۱۰ ریال (حداکثر یک رقم اعشار تومان) باشد.");
    price = decimalStr(p, 1);
  }
  return { coinId: coin.id, side, execution, amount: decimalStr(amount, 8), price };
}
async function evaluateOrder(env, order) {
  const st = (await getStats(env, [order.coinId], "rls"))[order.coinId];
  if (!st) throw new HttpError(502, "NO_PRICE", "قیمت بازار برای این ارز در دسترس نیست.");
  const warnings = [];
  let unit;
  if (order.execution === "limit") {
    unit = Number(order.price);
    const band = Number(env.PRICE_BAND_PCT || 20);
    const dev = Math.abs(unit - st.price) / st.price * 100;
    if (dev > band) throw new HttpError(400, "PRICE_FAR_FROM_MARKET", `قیمت وارد‌شده ${dev.toFixed(1)}٪ با قیمت بازار فاصله دارد (سقف مجاز ${band}٪).`);
  } else {
    unit = (order.side === "buy" ? st.bestSell : st.bestBuy) || st.price;
    warnings.push("سفارش بازار با بهترین قیمت لحظه‌ای اجرا می‌شود و مبلغ نهایی ممکن است تفاوت کند.");
  }
  const estimate = Number(order.amount) * unit;
  const { cap } = tradingState(env);
  if (cap && estimate > cap) throw new HttpError(400, "ORDER_OVER_CAP", `مبلغ سفارش از سقف تنظیم‌شده‌ی سرور (${cap.toLocaleString("en-US")} تومان) بیشتر است.`);
  return { estimateIrt: estimate, marketPriceIrt: st.price, warnings };
}
const canon = (o) => JSON.stringify([o.coinId, o.side, o.execution, o.amount, o.price]);
async function confirmSig(env, clientOrderId, exp, order) { return hmacB64u(env.SESSION_SECRET, `c.${clientOrderId}.${exp}.${canon(order)}`); }

async function tradePreview(env, body) {
  const order = parseOrder(body.order);
  const ev = await evaluateOrder(env, order); const ts = tradingState(env);
  const res = { order, summary: { market: `${order.coinId.toUpperCase()}/IRT`, side: order.side, execution: order.execution, amount: order.amount, price: order.price, estimateIrt: ev.estimateIrt, marketPriceIrt: ev.marketPriceIrt },
    warnings: ev.warnings, tradingEnabled: ts.enabled, disabledReasons: ts.reasons };
  if (ts.enabled) {
    const clientOrderId = "d" + b64u(crypto.getRandomValues(new Uint8Array(12))).replace(/[-_]/g, "x");
    const exp = Math.floor(Date.now() / 1000) + CONFIRM_TTL_SEC;
    res.clientOrderId = clientOrderId; res.expiresAt = exp * 1000; res.confirmToken = `${exp}.${await confirmSig(env, clientOrderId, exp, order)}`;
  }
  return res;
}
async function tradeSubmit(env, body) {
  const ts = tradingState(env);
  if (!ts.enabled) throw new HttpError(403, "TRADING_DISABLED", "ثبت سفارش واقعی در سرور غیرفعال است.", { public: { reasons: ts.reasons } });
  const order = parseOrder(body.order);
  const id = String(body.clientOrderId || ""); const [exp, sig] = String(body.confirmToken || "").split(".");
  if (!/^[A-Za-z0-9]{8,40}$/.test(id) || !exp || !sig || !(Number(exp) > Date.now() / 1000) || !safeEqual(await confirmSig(env, id, exp, order), sig))
    throw new HttpError(400, "CONFIRM_INVALID", "تأیید سفارش نامعتبر یا منقضی است؛ پیش‌نمایش را دوباره بسازید.");
  await evaluateOrder(env, order); // سقف مبلغ و فاصله قیمت یک‌بار دیگر
  const claim = await store(env, "/order/claim", { id, order });
  if (!claim.claimed) throw new HttpError(409, "DUPLICATE_ORDER", "این سفارش قبلاً ارسال شده است و دوباره ارسال نمی‌شود. وضعیت را در تاریخچه بررسی کنید.", { public: { record: { state: claim.record.state, orderId: claim.record.orderId || null } } });
  const reqBody = { type: order.side, srcCurrency: order.coinId, dstCurrency: "rls", amount: order.amount, execution: order.execution, clientOrderId: id };
  if (order.execution === "limit") reqBody.price = String(Math.round(Number(order.price) * 10)); // UNVERIFIED: قالب فیلدها
  let raw;
  try { raw = await nobitexRaw(env, "/market/orders/add", { method: "POST", body: reqBody, auth: true, attempts: 1, timeoutMs: 15000 }); }
  catch (e) {
    await store(env, "/order/update", { id, patch: { state: "unknown" } });
    throw new HttpError(504, "UNKNOWN_OUTCOME", "نتیجه‌ی ارسال سفارش نامشخص است (زمان پاسخ تمام شد یا شبکه قطع شد). سفارش را دوباره ارسال نکنید؛ ابتدا تاریخچه سفارش‌ها را در داشبورد یا پنل نوبیتکس بررسی کنید.", { public: { clientOrderId: id } });
  }
  memoClear("wallets"); memoClear("orders:");
  const j = raw.json;
  if (raw.httpStatus === 429) { await store(env, "/order/update", { id, patch: { state: "rate_limited" } }); throw new HttpError(429, "RATE_LIMITED", "نوبیتکس محدودیت نرخ اعمال کرد؛ سفارش ثبت‌شده تلقی نمی‌شود، اما برای اطمینان تاریخچه را ببینید. برای تلاش دوباره پیش‌نمایش جدید بسازید."); }
  if (j && j.status === "failed") { await store(env, "/order/update", { id, patch: { state: "rejected", code: String(j.code || "") } }); throw new HttpError(422, "ORDER_REJECTED", String(j.message || j.code || "سفارش توسط نوبیتکس رد شد.").slice(0, 200), { public: { upstreamCode: j.code ? String(j.code).slice(0, 60) : undefined } }); }
  if (raw.httpStatus >= 200 && raw.httpStatus < 300 && j && j.status === "ok" && j.order && j.order.id !== undefined) {
    const orderId = String(j.order.id);
    await store(env, "/order/update", { id, patch: { state: "accepted", orderId } });
    let verified = false, final = null;
    try { final = await verifyOrder(env, orderId); verified = true; } catch (_) { /* تأیید وضعیت ممکن نشد */ }
    return { accepted: true, orderId, clientOrderId: id, verified, order: final ? orderToRow(final) : null,
      message: verified ? "سفارش ثبت و وضعیت آن از نوبیتکس تأیید شد." : "نوبیتکس ثبت سفارش را اعلام کرد، اما بررسی وضعیت ممکن نشد؛ تاریخچه را بررسی کنید." };
  }
  await store(env, "/order/update", { id, patch: { state: "unknown", httpStatus: raw.httpStatus } });
  throw new HttpError(502, "UNKNOWN_OUTCOME", "پاسخ نوبیتکس قابل تفسیر نبود و نتیجه‌ی سفارش نامشخص است. دوباره ارسال نکنید و تاریخچه را بررسی کنید.", { public: { clientOrderId: id } });
}
async function verifyOrder(env, orderId) {
  const j = await nobitex(env, "/market/orders/status", { method: "POST", auth: true, body: { id: orderId }, attempts: 1 });
  const list = normalizeOrders({ orders: j.order ? [j.order] : [] });
  if (!list.length) throw unexpected("market/orders/status");
  return list[0];
}

// ---------- مسیریابی ----------
async function readJson(request) { try { return await request.json(); } catch (_) { throw new HttpError(400, "BAD_JSON", "بدنه‌ی درخواست JSON معتبر نیست."); } }

async function route(request, env, ctx, url) {
  const p = url.pathname.replace(/\/+$/, ""); const m = request.method;

  if (p === "/api/session" && m === "POST") {
    requireConfig(env);
    const ip = request.headers.get("CF-Connecting-IP") || "unknown"; const rl = { key: "login:" + ip, max: 5, windowMs: 15 * 60000 };
    if (env.STORE) { const c = await store(env, "/rl/check", rl); if (c.blocked) throw new HttpError(429, "TOO_MANY_ATTEMPTS", "تعداد تلاش‌های ناموفق زیاد است؛ بعداً دوباره امتحان کنید.", { retryAfter: c.retryAfterSec }); }
    const body = await readJson(request);
    const a = await hmacB64u(env.SESSION_SECRET, "pc:" + String(body.passcode || "")); const b = await hmacB64u(env.SESSION_SECRET, "pc:" + env.DASHBOARD_PASSCODE);
    if (!safeEqual(a, b)) { if (env.STORE) await store(env, "/rl/fail", rl); await sleep(400); throw new HttpError(401, "BAD_PASSCODE", "رمز دسترسی نادرست است."); }
    if (env.STORE) await store(env, "/rl/clear", { key: rl.key });
    return ok(await issueSession(env));
  }

  await requireSession(request, env);

  if (p === "/api/session/check" && m === "GET") return ok({ authenticated: true, nobitexTokenConfigured: !!env.NOBITEX_TOKEN, tradingEnabled: tradingState(env).enabled });
  if (p === "/api/market" && m === "GET") { const r = await getMarketCoins(env); return ok(r.data, { missing: r.missing }); }
  let mt;
  if ((mt = p.match(/^\/api\/history\/([a-z0-9]+)$/)) && m === "GET") {
    const range = url.searchParams.get("range") || "30d"; if (!RANGE_DAYS[range]) throw new HttpError(400, "BAD_RANGE", "بازه نامعتبر است.");
    return ok(await getHistory(env, mt[1], RANGE_DAYS[range]), { range });
  }
  if (p === "/api/sparklines" && m === "GET") {
    const ids = (url.searchParams.get("ids") || "").split(",").filter((x) => coinById(x)).slice(0, 12);
    const rs = await Promise.allSettled(ids.map((id) => getHistory(env, id, 14)));
    const out = {}; rs.forEach((r, i) => { if (r.status === "fulfilled" && r.value.length > 1) out[ids[i]] = r.value.slice(-14); });
    return ok(out);
  }
  if ((mt = p.match(/^\/api\/orderbook\/([a-z0-9]+)$/)) && m === "GET") return ok(await getOrderbook(env, mt[1]));
  if (p === "/api/wallets" && m === "GET") return ok(await buildAssets(env));
  if (p === "/api/portfolio" && m === "GET") { const r = await buildPortfolio(env, { snapshot: true }); return ok(r.summary, r.meta); }
  if (p === "/api/portfolio/history" && m === "GET") {
    const range = url.searchParams.get("range") || "7d"; if (!RANGE_DAYS[range]) throw new HttpError(400, "BAD_RANGE", "بازه نامعتبر است.");
    if (!env.STORE) return ok([], { available: false, note: "ذخیره‌سازی تنظیم نشده است." });
    const { snaps } = await store(env, "/snap/list"); const since = Date.now() - RANGE_DAYS[range] * 86400000;
    return ok(snaps.filter((s) => s.t >= since).map((s) => ({ t: new Date(s.t).toISOString(), v: s.v })),
      { available: true, collectedSince: snaps[0] ? new Date(snaps[0].t).toISOString() : null, note: "نوبیتکس تاریخچه ارزش پرتفو ارائه نمی‌کند؛ این نمودار فقط از نمونه‌هایی ساخته می‌شود که این سرور ذخیره کرده است." });
  }
  if (p === "/api/orders/open" && m === "GET") return ok((await fetchOrders(env, "open")).filter(isOpen).map(orderToRow));
  if (p === "/api/orders/history" && m === "GET") return ok((await fetchOrders(env, "all")).map(orderToRow), { note: "فقط سفارش‌های بازار؛ واریز و برداشت پیاده‌سازی نشده است." });
  if (p === "/api/profile" && m === "GET") return ok(normalizeProfile(await memo("profile", 60000, () => nobitex(env, "/users/profile", { auth: true }))));
  if (p === "/api/trade/config" && m === "GET") { const ts = tradingState(env); return ok({ tradingEnabled: ts.enabled, reasons: ts.reasons, maxOrderValueIrt: ts.cap, markets: COINS.map((c) => ({ id: c.id, name: c.name })) }); }
  if (p === "/api/trade/preview" && m === "POST") return ok(await tradePreview(env, await readJson(request)));
  if (p === "/api/trade/submit" && m === "POST") return ok(await tradeSubmit(env, await readJson(request)));
  if (p === "/api/trade/status" && m === "POST") {
    const b = await readJson(request); if (!/^\d{1,20}$/.test(String(b.id || ""))) throw new HttpError(400, "BAD_ID", "شناسه سفارش نامعتبر است.");
    return ok(orderToRow(await verifyOrder(env, String(b.id))));
  }
  throw new HttpError(404, "NOT_FOUND", "مسیر یافت نشد.");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try { return withHeaders(await route(request, env, ctx, url), cors); }
    catch (e) { return withHeaders(errorResponse(e), cors); }
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(takeSnapshot(env).catch(() => {})); },
};
export const __test = { parseOrder, normStat, normalizeWallets, normalizeOrders, orderToRow, tradingState };
