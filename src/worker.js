// ===================================================================
// Cloudflare Worker — واسط امن بین داشبورد و API والکس (Wallex)
// -------------------------------------------------------------------
// • کلید API والکس (WALLEX_API_KEY) فقط اینجا و فقط از Secrets خوانده می‌شود
//   و هرگز در پاسخ، لاگ یا مرورگر ظاهر نمی‌شود.
// • مرورگر فقط با «توکن نشست» کوتاه‌مدت (امضاشده با SESSION_SECRET) کار می‌کند
//   که پس از وارد کردن رمز دسترسی (DASHBOARD_PASSCODE) صادر می‌شود.
// • فقط endpointهای فهرست‌شده در این فایل به نوبیتکس می‌رسند (allowlist).
//   endpoint برداشت وجه اصلاً وجود ندارد.
//
// ⚠ UNVERIFIED: در محیط ساخت این پروژه به مستندات والکس دسترسی نبود. endpointها و
//   نمونه‌های JSON از متن‌هایی است که کاربر از مستندات رسمی (api-docs.wallex.ir و
//   developers.wallex.ir) برای من آورد. آنچه در آن متن‌ها «نامشخص» بود با برچسب UNVERIFIED
//   مشخص شده و باید در محیط واقعی بررسی شود.
//   همه این فرض‌ها فقط در توابع normalize*/بدنه‌ی درخواست‌ها جمع شده‌اند و
//   اگر ساختار پاسخ با انتظار نخواند، خطای UNEXPECTED_RESPONSE برمی‌گردد
//   (به‌جای نمایش داده‌ی غلط یا ساختگی).
// ===================================================================

const WALLEX_BASE = "https://api.wallex.ir";
const UA = "wallex-personal-dashboard/1.0";
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
function ok(data, meta, fetchedAtMs) {
  return new Response(JSON.stringify({ ok: true, data, meta: meta || null, fetchedAt: new Date(fetchedAtMs || Date.now()).toISOString() }), {
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

// ---------- ارتباط با والکس ----------
// فاصله‌ی حداقلی بین درخواست‌های ارسالی به والکس (جلوگیری از موج درخواست که ممکن است قاعده‌ی مسدودسازی را فعال کند)
let nextSlot = 0;
async function throttle(env) {
  const gap = env.UPSTREAM_GAP_MS === undefined ? 200 : Number(env.UPSTREAM_GAP_MS);
  if (!(gap > 0)) return;
  const now = Date.now(); const at = Math.max(now, nextSlot); nextSlot = at + gap;
  if (at > now) await sleep(at - now);
}
async function wallexRaw(env, path, { method = "GET", query, body, auth = false, timeoutMs = 8000, attempts } = {}) {
  const url = new URL(WALLEX_BASE + path);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  const headers = { Accept: "application/json", "User-Agent": UA };
  if (auth) {
    if (!env.WALLEX_API_KEY || !String(env.WALLEX_API_KEY).trim()) throw new HttpError(503, "TOKEN_NOT_CONFIGURED", "کلید API والکس (WALLEX_API_KEY) در Secrets تنظیم نشده است.");
    headers["X-API-Key"] = String(env.WALLEX_API_KEY).trim(); // فاصله/خط جدید اضافی هنگام paste رایج است
  }
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const maxAttempts = attempts || (method === "GET" ? 2 : 1); // POST/DELETE هرگز خودکار تکرار نمی‌شوند
  let lastErr;
  for (let i = 1; i <= maxAttempts; i++) {
    await throttle(env);
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: ctl.signal });
      clearTimeout(timer);
      if (res.status >= 500 && i < maxAttempts) { await sleep(300); continue; }
      const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch (_) { /* غیر JSON */ }
      const snippet = json ? "" : text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
      const hdr = []; // فقط سربرگ‌های بی‌خطر و مفید برای شناسایی لایه‌ی مسدودکننده
      for (const k of ["server", "via", "cf-ray", "x-request-id", "x-cache", "x-served-by", "content-type"]) { const v = res.headers.get(k); if (v) hdr.push(`${k}=${String(v).slice(0, 60)}`); }
      return { httpStatus: res.status, json, retryAfter: res.headers.get("Retry-After"), snippet, hdr: hdr.join("; ") };
    } catch (e) {
      clearTimeout(timer);
      lastErr = new HttpError(504, e && e.name === "AbortError" ? "UPSTREAM_TIMEOUT" : "UPSTREAM_NETWORK", "ارتباط با والکس برقرار نشد یا زمان آن تمام شد.");
      if (i < maxAttempts) await sleep(300);
    }
  }
  throw lastErr;
}
// plain: پاسخ‌هایی مثل udf/history که فیلد success ندارند
async function wallex(env, path, opts = {}) {
  const { httpStatus, json, retryAfter, snippet, hdr } = await wallexRaw(env, path, opts);
  if (httpStatus === 429) throw new HttpError(429, "RATE_LIMITED", "محدودیت تعداد درخواست والکس اعمال شد؛ کمی بعد دوباره تلاش کنید.", { retryAfter: Number(retryAfter) || 5 });
  if (httpStatus === 401 || httpStatus === 403) {
    const detail = (json && json.message ? String(json.message) : snippet || "").slice(0, 120);
    throw new HttpError(502, opts.auth ? "UPSTREAM_AUTH" : "UPSTREAM_BLOCKED",
      (opts.auth ? "والکس درخواست خصوصی را رد کرد" : "والکس درخواست عمومی بازار را رد کرد (بدون کلید)") + ` (HTTP ${httpStatus})` + (detail ? ` — ${detail}` : "") + (hdr ? ` [${hdr}]` : "") +
      (opts.auth ? ". کلید نامعتبر/منقضی، مجوز ناکافی یا IP غیرمجاز ممکن است." : ". احتمالاً مسدودسازی بر اساس IP/شبکه."));
  }
  if (json && json.success === false) throw new HttpError(502, "UPSTREAM_FAILED", String(json.message || "درخواست توسط والکس ناموفق اعلام شد.").slice(0, 200));
  if (httpStatus < 200 || httpStatus >= 300 || !json) throw new HttpError(502, "UPSTREAM_ERROR", `پاسخ نامعتبر از والکس (HTTP ${httpStatus})${snippet ? " — " + snippet : ""}`);
  if (!opts.plain && json.success !== true) throw unexpected(path);
  return json;
}

// ---------- بازار (عمومی) ----------
// نمونه‌ی مستند: GET /v1/markets → {success, result:{symbols:{BTCTMN:{stats:{bidPrice,askPrice,"24h_ch","24h_volume",
//   lastPrice?, "24h_highPrice"?, "24h_lowPrice"?}, stepSize, tickSize, minQty, minNotional}}}}
// UNVERIFIED: دو نمونه‌ی مستندات یکسان نیستند؛ lastPrice/high/low ممکن است نباشند.
let lastGoodMarkets = null; // آخرین پاسخ موفق (فقط برای نمایش لیست بازار با برچسب «قدیمی»)
function getMarkets(env) {
  return memo("markets", 15000, async () => {
    const j = await wallex(env, "/v1/markets");
    const sym = j.result && j.result.symbols;
    if (!sym || typeof sym !== "object") throw unexpected("v1/markets");
    lastGoodMarkets = { t: Date.now(), sym };
    return sym;
  });
}
async function getMarketsForDisplay(env) {
  try { return { sym: await getMarkets(env), stale: false, t: Date.now() }; }
  catch (e) {
    const soft = ["UPSTREAM_BLOCKED", "UPSTREAM_NETWORK", "UPSTREAM_TIMEOUT", "UPSTREAM_ERROR", "RATE_LIMITED"].includes(e.code);
    if (soft && lastGoodMarkets && Date.now() - lastGoodMarkets.t < 30 * 60000) return { sym: lastGoodMarkets.sym, stale: true, t: lastGoodMarkets.t, reason: e.code };
    throw e;
  }
}
function priceOf(m) {
  const st = m && m.stats; if (!st) return null;
  const last = num(st.lastPrice); if (last > 0) return { price: last, source: "last" };
  const bid = num(st.bidPrice), ask = num(st.askPrice);
  if (bid > 0 && ask > 0) return { price: (bid + ask) / 2, source: "mid" }; // میانگین خرید/فروش، نه آخرین معامله
  return null;
}
function normMarket(m) {
  const p = priceOf(m); if (!p) return null; const st = m.stats;
  const ch = num(st["24h_ch"]); const baseVol = num(st["24h_volume"]);
  return { price: p.price, source: p.source, change: Number.isFinite(ch) ? ch : null,
    high: scale(num(st["24h_highPrice"]), 1), low: scale(num(st["24h_lowPrice"]), 1),
    bestBuy: scale(num(st.bidPrice), 1), bestSell: scale(num(st.askPrice), 1),
    volume: Number.isFinite(baseVol) ? baseVol * p.price : null /* تخمینی: حجم پایه × قیمت */ };
}
const tmnSymbol = (id) => `${id.toUpperCase()}TMN`;
async function getMarketCoins(env) {
  const { sym, stale, t, reason } = await getMarketsForDisplay(env); const sources = new Set();
  const data = [];
  for (const c of COINS) {
    const n = normMarket(sym[tmnSymbol(c.id)]); if (!n) continue; sources.add(n.source);
    data.push({ id: c.id, name: c.name, symbol: `${c.id.toUpperCase()}/IRT`, price: n.price, change24h: n.change, high24h: n.high, low24h: n.low, volume24h: n.volume, bestBuy: n.bestBuy, bestSell: n.bestSell });
  }
  if (!data.length) throw unexpected("v1/markets (هیچ جفت‌ارز تومانی معتبر نبود)");
  return { data, stale, t, reason, missing: COINS.filter((c) => !data.find((d) => d.id === c.id)).map((c) => c.id),
    priceSources: [...sources], note: "حجم ۲۴ساعته = حجم پایه × قیمت (تخمینی). اگر منبع قیمت mid باشد، قیمت میانگین خرید و فروش است." };
}
const RANGE_DAYS = { "24h": 1, "7d": 7, "30d": 30, "90d": 90 };
let dailyResolutionOk = null; // UNVERIFIED: آیا resolution=D پذیرفته می‌شود؟
function downsampleDaily(pts) {
  const byDay = new Map(); for (const p of pts) byDay.set(p.t.slice(0, 10), p); return [...byDay.values()];
}
// نمونه‌ی مستند: GET /v1/udf/history?symbol=BTCTMN&resolution=60&from&to → {s:"ok", t:[...], c:[...]}
async function fetchCandles(env, symbol, resolution, from, to) {
  const j = await wallex(env, "/v1/udf/history", { query: { symbol, resolution, from, to }, plain: true });
  if (j.s === "no_data") return [];
  if (j.s !== "ok" || !Array.isArray(j.t) || !Array.isArray(j.c) || j.t.length !== j.c.length) throw unexpected("v1/udf/history");
  return j.t.map((t, i) => ({ t: new Date(t * 1000).toISOString(), v: Number(num(j.c[i]).toFixed(2)) })).filter((p) => Number.isFinite(p.v));
}
function getHistory(env, id, days) {
  if (!coinById(id)) throw new HttpError(404, "UNKNOWN_COIN", "ارز ناشناخته است.");
  return memo(`hist:${id}:${days}`, 10 * 60000, async () => {
    const to = Math.floor(Date.now() / 1000), from = to - days * 86400, symbol = tmnSymbol(id);
    if (days <= 7) return fetchCandles(env, symbol, "60", from, to);
    if (dailyResolutionOk !== false) {
      try { const r = await fetchCandles(env, symbol, "D", from, to); if (r.length) { dailyResolutionOk = true; return r; } dailyResolutionOk = false; }
      catch (e) { if (e.code === "RATE_LIMITED") throw e; dailyResolutionOk = false; }
    }
    return downsampleDaily(await fetchCandles(env, symbol, "60", from, to)); // مستند: resolution=60
  });
}
// نمونه‌ی مستند: GET /v1/depth?symbol=BTCUSDT → {result:{ask:[{price,quantity}], bid:[...]}}
async function getOrderbook(env, id) {
  if (!coinById(id)) throw new HttpError(404, "UNKNOWN_COIN", "ارز ناشناخته است.");
  return memo(`ob:${id}`, 3000, async () => {
    const j = await wallex(env, "/v1/depth", { query: { symbol: tmnSymbol(id) } });
    const side = (a) => {
      if (!Array.isArray(a)) throw unexpected("v1/depth");
      return a.slice(0, 8).map((r) => ({ price: num(r.price), amount: num(r.quantity) })).filter((r) => Number.isFinite(r.price) && Number.isFinite(r.amount));
    };
    return { bids: side(j.result && j.result.bid), asks: side(j.result && j.result.ask) };
  });
}

// ---------- حساب (خصوصی) ----------
// نمونه‌ی مستند: GET /v1/account/balances → {result:{balances:{TMN:{asset,faName,fiat,value,locked}, USDT:{...}}}}
// UNVERIFIED: معلوم نیست «value» کل موجودی است یا فقط قابل‌استفاده. اینجا value = کل و قابل‌استفاده = value − locked
//   فرض شده؛ این فرض در محیط واقعی باید با یک سفارش باز (که locked را تغییر می‌دهد) بررسی شود.
function normalizeBalances(json) {
  const b = json && json.result && json.result.balances;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw unexpected("v1/account/balances");
  const out = Object.entries(b).map(([k, w]) => {
    const total = num(w.value); const locked = Number.isFinite(num(w.locked)) ? num(w.locked) : 0;
    return { cur: String(w.asset || k).toLowerCase(), fa: w.faName, total, locked, available: Math.max(total - locked, 0) };
  }).filter((w) => w.cur && Number.isFinite(w.total));
  if (Object.keys(b).length && !out.length) throw unexpected("v1/account/balances");
  return out;
}
async function getPrices(env, curs) {
  const sym = await getMarkets(env); const usdt = normMarket(sym.USDTTMN); const out = {};
  for (const c of curs) {
    const C = c.toUpperCase();
    const tmn = normMarket(sym[`${C}TMN`]);
    if (tmn) { out[c] = { priceIrt: tmn.price, change24h: tmn.change }; continue; }
    const u = normMarket(sym[`${C}USDT`]);
    if (u && usdt) out[c] = { priceIrt: u.price * usdt.price, change24h: u.change }; // از جفت تتری × نرخ تتر
  }
  return out;
}
async function buildAssets(env) {
  const bal = normalizeBalances(await memo("balances", 5000, () => wallex(env, "/v1/account/balances", { auth: true })));
  const held = bal.filter((w) => w.total > 0 || w.locked > 0);
  const curs = held.map((w) => w.cur).filter((c) => c !== "tmn");
  const prices = curs.length ? await getPrices(env, curs) : {};
  const assets = held.map((w) => {
    if (w.cur === "tmn") return { coinId: "irt", name: "تومان", symbol: "IRT", total: w.total, available: w.available, locked: w.locked, change24h: null, priceIrt: 1, valueIrt: w.total };
    const p = prices[w.cur];
    return { coinId: w.cur, name: (coinById(w.cur) || {}).name || w.fa || w.cur.toUpperCase(), symbol: w.cur.toUpperCase(), total: w.total, available: w.available, locked: w.locked,
      change24h: p ? p.change24h : null, priceIrt: p ? p.priceIrt : null, valueIrt: p ? w.total * p.priceIrt : null };
  });
  assets.sort((a, b) => (b.valueIrt ?? -1) - (a.valueIrt ?? -1));
  return assets;
}
// نمونه‌ی مستند: {result:{orders:[{symbol,type,side,price,origQty,executedQty,status,active,clientOrderId,created_at}]}}
function normOrder(o) {
  const sym = String(o.symbol || ""); const m = sym.match(/^(.*?)(TMN|USDT)$/);
  const price = num(o.price);
  return { id: String(o.clientOrderId || "—"), side: String(o.side || "").toLowerCase(), execution: String(o.type || ""), status: String(o.status || ""),
    active: o.active === true, src: (m ? m[1] : sym).toLowerCase(), dst: m ? m[2].toLowerCase() : "", price: Number.isFinite(price) ? price : null,
    amount: num(o.origQty), matched: num(o.executedQty), createdAt: toIso(o.created_at) };
}
function normalizeOrders(json) {
  const list = json && json.result && json.result.orders;
  if (!Array.isArray(list)) throw unexpected("v1/account/openOrders");
  return list.map(normOrder);
}
// UNVERIFIED: page/per_page در مستندات مقدار نمونه‌ی 0 دارند و پیش‌فرض‌هایشان نامشخص است؛ بنابراین ارسال نمی‌شوند.
const fetchOpenOrders = (env) => memo("orders:open", 5000, async () => normalizeOrders(await wallex(env, "/v1/account/openOrders", { auth: true })));
function orderToRow(o, forceOpen) {
  const st = o.status.toUpperCase(); const open = forceOpen || o.active;
  const status = open ? "در انتظار" : st.includes("CANCEL") ? "لغو شده" : st.includes("FILL") ? "موفق" : o.status || "—";
  const pair = `${o.src.toUpperCase()}/${o.dst === "tmn" ? "IRT" : o.dst.toUpperCase()}`;
  const parts = [`${o.execution || "سفارش"} ${pair}`];
  if (o.price !== null) parts.push(`قیمت ${o.price.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${o.dst === "tmn" ? "تومان" : o.dst.toUpperCase()}`);
  if (open && o.matched > 0) parts.push("اجرای جزئی");
  return { id: o.id, date: o.createdAt, type: o.side === "buy" ? "خرید" : o.side === "sell" ? "فروش" : o.side || "—",
    coin: o.src.toUpperCase(), amount: o.matched > 0 && !open ? o.matched : o.amount, status, desc: parts.join(" · "), side: o.side, open: !!open };
}
// نمونه‌ی مستند: GET /v1/account/profile → {result:{tracking_id, first_name, mobile_number:"0912****789", email:"as***@g***.com"}}
function normalizeProfile(json) {
  const p = json && json.result; if (!p || typeof p !== "object") throw unexpected("v1/account/profile");
  const masked = (v, fn) => (typeof v === "string" && v ? (v.includes("*") ? v : fn(v)) : null);
  return { username: p.first_name || null, accountId: p.tracking_id !== undefined ? String(p.tracking_id) : null,
    phoneMasked: masked(p.mobile_number, maskPhone), emailMasked: masked(p.email, maskEmail) };
}

// ---------- پرتفو ----------
async function buildPortfolio(env, { snapshot } = {}) {
  const assets = await buildAssets(env);
  let openOrders = null; let ordersError = null;
  try { openOrders = (await fetchOpenOrders(env)).length; } catch (e) { ordersError = e.code || "ERROR"; }
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
async function takeSnapshot(env) { if (env.WALLEX_API_KEY && env.STORE) await buildPortfolio(env, { snapshot: true }); }

// ---------- سفارش‌گذاری ----------
function tradingState(env) {
  const reasons = [];
  if (env.TRADING_ENABLED !== "true") reasons.push("TRADING_DISABLED");
  if (!env.STORE) reasons.push("NO_STORE");
  if (!env.WALLEX_API_KEY) reasons.push("NO_TOKEN");
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
    price = decimalStr(p, 8);
  }
  return { coinId: coin.id, side, execution, amount: decimalStr(amount, 8), price };
}
const decimals = (str) => (String(str).split(".")[1] || "").length;
async function evaluateOrder(env, order) {
  const m = (await getMarkets(env))[tmnSymbol(order.coinId)]; const ref = priceOf(m);
  if (!m || !ref) throw new HttpError(502, "NO_PRICE", "قیمت بازار برای این ارز در دسترس نیست.");
  const bad = (msg) => new HttpError(400, "INVALID_ORDER", msg); const warnings = [];
  const step = num(m.stepSize), tick = num(m.tickSize), minQty = num(m.minQty), minNotional = num(m.minNotional);
  if (Number.isFinite(step) && decimals(order.amount) > step) throw bad(`حداکثر ${step} رقم اعشار برای مقدار مجاز است.`);
  if (minQty > 0 && Number(order.amount) < minQty) throw bad(`حداقل مقدار سفارش ${minQty} است.`);
  let unit;
  if (order.execution === "limit") {
    unit = Number(order.price);
    if (Number.isFinite(tick) && decimals(order.price) > tick) throw bad(`حداکثر ${tick} رقم اعشار برای قیمت مجاز است.`);
    const band = Number(env.PRICE_BAND_PCT || 20); const dev = Math.abs(unit - ref.price) / ref.price * 100;
    if (dev > band) throw new HttpError(400, "PRICE_FAR_FROM_MARKET", `قیمت وارد‌شده ${dev.toFixed(1)}٪ با قیمت بازار فاصله دارد (سقف مجاز ${band}٪).`);
  } else {
    const st = m.stats || {}; unit = (order.side === "buy" ? num(st.askPrice) : num(st.bidPrice)); if (!(unit > 0)) unit = ref.price;
    warnings.push("سفارش بازار با بهترین قیمت لحظه‌ای اجرا می‌شود و مبلغ نهایی ممکن است تفاوت کند.");
  }
  if (ref.source === "mid") warnings.push("قیمت مرجع بازار میانگین خرید و فروش است (آخرین قیمت معامله در پاسخ والکس نبود).");
  const estimate = Number(order.amount) * unit;
  if (minNotional > 0 && estimate < minNotional) throw bad(`حداقل ارزش سفارش ${minNotional.toLocaleString("en-US")} تومان است.`);
  const { cap } = tradingState(env);
  if (cap && estimate > cap) throw new HttpError(400, "ORDER_OVER_CAP", `مبلغ سفارش از سقف تنظیم‌شده‌ی سرور (${cap.toLocaleString("en-US")} تومان) بیشتر است.`);
  return { estimateIrt: estimate, marketPriceIrt: ref.price, warnings };
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
  await evaluateOrder(env, order); // سقف مبلغ، دقت و فاصله قیمت یک‌بار دیگر
  const claim = await store(env, "/order/claim", { id, order });
  if (!claim.claimed) throw new HttpError(409, "DUPLICATE_ORDER", "این سفارش قبلاً ارسال شده است و دوباره ارسال نمی‌شود. وضعیت را در تاریخچه بررسی کنید.", { public: { record: { state: claim.record.state, orderId: claim.record.orderId || null } } });
  const reqBody = { symbol: tmnSymbol(order.coinId), type: order.execution.toUpperCase(), side: order.side.toUpperCase(), quantity: order.amount, client_id: id };
  if (order.execution === "limit") reqBody.price = order.price; // سفارش MARKET نباید قیمت داشته باشد (خطای مستند ۱۰۰۳)
  let raw;
  try { raw = await wallexRaw(env, "/v1/account/orders", { method: "POST", body: reqBody, auth: true, attempts: 1, timeoutMs: 15000 }); }
  catch (e) {
    await store(env, "/order/update", { id, patch: { state: "unknown" } });
    throw new HttpError(504, "UNKNOWN_OUTCOME", "نتیجه‌ی ارسال سفارش نامشخص است (زمان پاسخ تمام شد یا شبکه قطع شد). سفارش را دوباره ارسال نکنید؛ ابتدا سفارش‌های باز را در داشبورد یا پنل والکس بررسی کنید.", { public: { clientOrderId: id } });
  }
  memoClear("balances"); memoClear("orders:");
  const j = raw.json;
  if (raw.httpStatus === 429) { await store(env, "/order/update", { id, patch: { state: "rate_limited" } }); throw new HttpError(429, "RATE_LIMITED", "والکس محدودیت نرخ اعمال کرد؛ برای اطمینان سفارش‌های باز را ببینید. برای تلاش دوباره پیش‌نمایش جدید بسازید."); }
  if (j && j.success === false) { await store(env, "/order/update", { id, patch: { state: "rejected" } }); throw new HttpError(422, "ORDER_REJECTED", String(j.message || "سفارش توسط والکس رد شد.").slice(0, 200)); }
  if (raw.httpStatus >= 200 && raw.httpStatus < 300 && j && j.success === true && j.result && j.result.clientOrderId) {
    const orderId = String(j.result.clientOrderId);
    await store(env, "/order/update", { id, patch: { state: "accepted", orderId } });
    let verified = false, final = null;
    try { final = await verifyOrder(env, orderId); verified = true; } catch (_) { /* تأیید وضعیت ممکن نشد */ }
    return { accepted: true, orderId, clientOrderId: id, verified, order: final ? orderToRow(final) : null,
      message: verified ? "سفارش ثبت و وضعیت آن از والکس تأیید شد." : "والکس ثبت سفارش را اعلام کرد، اما بررسی وضعیت ممکن نشد؛ سفارش‌های باز را بررسی کنید." };
  }
  await store(env, "/order/update", { id, patch: { state: "unknown", httpStatus: raw.httpStatus } });
  throw new HttpError(502, "UNKNOWN_OUTCOME", "پاسخ والکس قابل تفسیر نبود و نتیجه‌ی سفارش نامشخص است. دوباره ارسال نکنید و سفارش‌های باز را بررسی کنید.", { public: { clientOrderId: id } });
}
// نمونه‌ی مستند: GET /v1/account/orders/{clientOrderId} → {result:{symbol,type,side,status,active,clientOrderId,...}}
async function verifyOrder(env, clientOrderId) {
  const j = await wallex(env, `/v1/account/orders/${encodeURIComponent(clientOrderId)}`, { auth: true, attempts: 1 });
  if (!j.result || typeof j.result !== "object") throw unexpected("v1/account/orders/{id}");
  return normOrder(j.result);
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

  if (p === "/api/session/check" && m === "GET") return ok({ authenticated: true, exchangeKeyConfigured: !!env.WALLEX_API_KEY, tradingEnabled: tradingState(env).enabled });
  if (p === "/api/market" && m === "GET") { const r = await getMarketCoins(env); return ok(r.data, { missing: r.missing, priceSources: r.priceSources, note: r.note, stale: r.stale, staleReason: r.stale ? r.reason : undefined }, r.t); }
  let mt;
  if ((mt = p.match(/^\/api\/history\/([a-z0-9]+)$/)) && m === "GET") {
    const range = url.searchParams.get("range") || "30d"; if (!RANGE_DAYS[range]) throw new HttpError(400, "BAD_RANGE", "بازه نامعتبر است.");
    return ok(await getHistory(env, mt[1], RANGE_DAYS[range]), { range });
  }
  if (p === "/api/sparklines" && m === "GET") {
    const ids = (url.searchParams.get("ids") || "").split(",").filter((x) => coinById(x)).slice(0, 12);
    const out = await memo(`spark:${ids.join(",")}`, 30 * 60000, async () => {
      const res = {};
      for (const id of ids) { // ترتیبی؛ با اولین خطا متوقف می‌شود تا موج درخواست ساخته نشود
        try { const h = await getHistory(env, id, 14); if (h.length > 1) res[id] = h.slice(-14); } catch (e) { break; }
      }
      return res;
    });
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
  if (p === "/api/orders/open" && m === "GET") return ok((await fetchOpenOrders(env)).map((o) => orderToRow(o, true)));
  if (p === "/api/orders/history" && m === "GET") return ok((await fetchOpenOrders(env)).map((o) => orderToRow(o, true)), { note: "مستندات والکس endpoint تاریخچه‌ی سفارش‌ها را مشخص نکرده؛ فقط سفارش‌های باز نمایش داده می‌شوند." });
  if (p === "/api/profile" && m === "GET") return ok(normalizeProfile(await memo("profile", 60000, () => wallex(env, "/v1/account/profile", { auth: true }))));
  if (p === "/api/trade/config" && m === "GET") { const ts = tradingState(env); return ok({ tradingEnabled: ts.enabled, reasons: ts.reasons, maxOrderValueIrt: ts.cap, markets: COINS.map((c) => ({ id: c.id, name: c.name })) }); }
  if (p === "/api/trade/preview" && m === "POST") return ok(await tradePreview(env, await readJson(request)));
  if (p === "/api/trade/submit" && m === "POST") return ok(await tradeSubmit(env, await readJson(request)));
  if (p === "/api/trade/status" && m === "POST") {
    const b = await readJson(request); if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(b.id || ""))) throw new HttpError(400, "BAD_ID", "شناسه سفارش نامعتبر است.");
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

