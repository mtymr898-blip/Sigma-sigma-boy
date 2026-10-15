// ===================================================================
// server.js — اجرای worker.js (بدون هیچ تغییری) روی Node.js / VPS
// -------------------------------------------------------------------
// • بدون وابستگی (npm install لازم نیست) — فقط Node.js نسخه 20 یا بالاتر
// • Durable Object  →  فایل JSON روی دیسک (data/store.json) با صف سریالی
//   (همان رفتار «یک‌نخی» Durable Object؛ جلوی ثبت دوباره‌ی سفارش را می‌گیرد)
// • env.ASSETS      →  سرو فایل‌های پوشه‌ی public/
// • cron            →  setInterval هر ۳۰ دقیقه (نمونه‌ی پرتفو) + تیک موتور معاملاتی هر ۱۵ ثانیه
// • CF-Connecting-IP → IP واقعی کلاینت از X-Forwarded-For (پشت Caddy/Nginx)
// ===================================================================
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker, { DashboardStore } from "./src/worker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1"; // فقط لوکال؛ دسترسی بیرونی از طریق Caddy
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data", "store.json");
const TRUST_PROXY = process.env.TRUST_PROXY !== "false"; // پشت reverse proxy محلی هستیم
const MAX_BODY = 1_000_000;

// ---------- ذخیره‌سازی فایل‌محور (جایگزین state.storage در Durable Object) ----------
class FileStorage {
  constructor(file) {
    this.file = file;
    this.map = new Map();
    try {
      for (const [k, v] of JSON.parse(fs.readFileSync(file, "utf8"))) this.map.set(k, v);
    } catch (e) {
      if (e.code !== "ENOENT") throw new Error(`فایل ذخیره‌سازی (${file}) خراب است؛ برای جلوگیری از ثبت دوباره‌ی سفارش، اجرا متوقف شد: ${e.message}`);
    }
  }
  async get(k) { const v = this.map.get(k); return v === undefined ? undefined : structuredClone(v); }
  async put(k, v) { this.map.set(k, structuredClone(v)); this.#flush(); }
  async delete(k) { const had = this.map.delete(k); this.#flush(); return had; }
  #flush() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify([...this.map]), { mode: 0o600 });
    fs.renameSync(tmp, this.file); // نوشتن اتمیک
  }
}

const durable = new DashboardStore({ storage: new FileStorage(DATA_FILE) });
let chain = Promise.resolve(); // صف: هر درخواست به store فقط بعد از تمام‌شدن قبلی اجرا می‌شود
const STORE = {
  idFromName: (name) => name,
  get: () => ({
    fetch: (url, init) => {
      const p = chain.then(() => durable.fetch(new Request(url, init)));
      chain = p.catch(() => {});
      return p;
    },
  }),
};

// ---------- سرو فایل‌های استاتیک (جایگزین env.ASSETS) ----------
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json",
};
async function serveStatic(request) {
  let rel;
  try { rel = decodeURIComponent(new URL(request.url).pathname); } catch { return new Response("Bad request", { status: 400 }); }
  if (rel.includes("\0")) return new Response("Bad request", { status: 400 });
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return new Response("Forbidden", { status: 403 });
  try {
    const st = await fs.promises.stat(file);
    if (!st.isFile()) throw new Error("not a file");
    const ext = path.extname(file).toLowerCase();
    return new Response(await fs.promises.readFile(file), {
      status: 200,
      headers: {
        "Content-Type": MIME[ext] || "application/octet-stream",
        "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch { return new Response("Not found", { status: 404 }); }
}

// ---------- محیط (جایگزین env در Worker) ----------
const env = { ...process.env, STORE, ASSETS: { fetch: serveStatic } };
const ctx = { waitUntil: (p) => Promise.resolve(p).catch(() => {}) };

if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) console.warn("⚠ SESSION_SECRET تنظیم نشده یا کوتاه‌تر از ۳۲ کاراکتر است.");
if (!env.DASHBOARD_PASSCODE) console.warn("⚠ DASHBOARD_PASSCODE تنظیم نشده است.");
if (!env.WALLEX_API_KEY) console.warn("⚠ WALLEX_API_KEY تنظیم نشده؛ فقط بخش‌های عمومی بازار کار می‌کنند.");

// ---------- پل Node ⇄ Fetch API ----------
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/healthz") { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end("ok"); }

    const chunks = []; let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) { res.writeHead(413).end(); req.destroy(); return; }
      chunks.push(c);
    }
    const body = Buffer.concat(chunks);

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) v.forEach((x) => headers.append(k, x)); else if (v !== undefined) headers.set(k, v);
    }
    for (const h of ["cf-connecting-ip", "content-length", "transfer-encoding", "connection"]) headers.delete(h);
    const fwd = TRUST_PROXY ? String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() : "";
    headers.set("CF-Connecting-IP", fwd || req.socket.remoteAddress || "unknown"); // برای محدودیت تلاش ورود

    const hasBody = req.method !== "GET" && req.method !== "HEAD" && body.length > 0;
    const request = new Request(`http://${req.headers.host || "localhost"}${req.url}`, { method: req.method, headers, body: hasBody ? body : undefined });
    const response = await worker.fetch(request, env, ctx);

    const out = {}; response.headers.forEach((v, k) => { out[k] = v; });
    res.writeHead(response.status, out);
    if (req.method === "HEAD") return res.end();
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    console.error("request error:", e && e.message);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: { code: "INTERNAL", message: "خطای داخلی سرور." } }));
  }
});

server.listen(PORT, HOST, () => console.log(`dashboard listening on http://${HOST}:${PORT}`));

// ---------- جایگزین cron: نمونه‌برداری از ارزش پرتفو ----------
const tick = () => worker.scheduled({}, env, ctx);
setTimeout(tick, 30_000);
setInterval(tick, 30 * 60_000);

// ---------- موتور معاملاتی: تحلیل، پایش حد سود/ضرر، Paper/Live ----------
// خود موتور فواصل تحلیل/پایش را از تنظیمات می‌خواند؛ این تایمر فقط «بیدار»ش می‌کند.
// اگر هیچ چیزی برای انجام نباشد (حالت پیشنهاد متوقف و بدون موقعیت باز) تیک بدون هزینه برمی‌گردد.
const ENGINE_TICK_MS = Math.max(5, Number(process.env.ENGINE_TICK_SEC || 15)) * 1000;
const engineTick = () => worker.engineTick({}, env, ctx);
setTimeout(engineTick, 10_000);
setInterval(engineTick, ENGINE_TICK_MS);

process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e && e.message));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => server.close(() => process.exit(0)));
