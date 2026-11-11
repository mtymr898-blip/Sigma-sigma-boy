// ===================================================================
// internalServer.js — API داخلی ارسال OTP (فقط لوکال + راز مشترک)
//   POST /internal/send-otp   { chatId, code, ttlSec }   ← فقط سایت صدا می‌زند
//   GET  /healthz             ← وضعیت (بدون اطلاعات حساس)
// حفاظت‌ها: bind روی loopback، Bearer secret با مقایسه‌ی ثابت‌زمان، اعتبارسنجی ورودی، محدودیت نرخ هر چت و کل،
// تأیید اتصال chat_id از خود سایت پیش از ارسال (به کاربر غیرمتصل هرگز پیام نمی‌رود)، و بدون لاگ‌کردن کد.
// ===================================================================
import http from "node:http";
import crypto from "node:crypto";
import { maskId } from "./logger.js";
import { buildOtpMessage } from "./texts.js";
import { classifySendError } from "./rubikaApi.js";

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
const CHAT_ID_RE = /^[A-Za-z0-9_-]{4,80}$/;

export function createInternalServer({ config, api, site, limiter, log, health, poller, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const secretDigest = sha(config.secret);
  const authorized = (req) => { const m = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i); return !!m && crypto.timingSafeEqual(sha(m[1].trim()), secretDigest); };
  const send = (res, status, obj) => { const b = JSON.stringify(obj); res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(b) }); res.end(b); };
  const fail = (res, status, code, extra = {}) => send(res, status, { ok: false, error: { code, retryable: false, permanent: false, ...extra } });

  async function readBody(req, max = 4096) {
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > max) throw Object.assign(new Error("too large"), { status: 413 }); chunks.push(c); }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (_) { throw Object.assign(new Error("bad json"), { status: 400 }); }
  }

  async function sendWithRetry(chatId, text) {
    let last;
    for (let i = 0; i < 2; i++) { // حداکثر دو تلاش؛ فقط برای خطاهای گذرا
      try { return await api.sendMessage(chatId, text); }
      catch (e) { last = e; if (!classifySendError(e, { apiHealthy: health.ok }).retryable) break; await sleep(400 * (i + 1)); }
    }
    throw last;
  }

  async function sendOtp(req, res) {
    let b; try { b = await readBody(req); } catch (e) { return fail(res, e.status || 400, e.status === 413 ? "TOO_LARGE" : "BAD_JSON"); }
    const chatId = b && b.chatId, code = b && String(b.code === undefined ? "" : b.code), ttl = b && b.ttlSec === undefined ? 120 : Number(b && b.ttlSec);
    if (typeof chatId !== "string" || !CHAT_ID_RE.test(chatId) || !/^\d{4,10}$/.test(code) || !Number.isInteger(ttl) || ttl < 30 || ttl > 900) return fail(res, 400, "BAD_INPUT");
    if (!limiter.hit("otp-global", config.otpGlobalPerMin, 60000).allowed) return fail(res, 429, "RATE_LIMITED", { retryable: true });
    if (!limiter.hit(`otp-chat:${chatId}`, config.otpPerChat, 10 * 60000).allowed) return fail(res, 429, "RATE_LIMITED", { retryable: false });
    const v = await site.verifyChat(chatId); // منبع حقیقت: دیتابیس سایت
    if (!v.ok) return fail(res, 503, "SITE_UNREACHABLE", { retryable: true });
    if (!v.data || v.data.connected !== true) { log.warn("otp refused: chat not connected", { chat: maskId(chatId) }); return fail(res, 409, "NOT_CONNECTED"); }
    try {
      const r = await sendWithRetry(chatId, buildOtpMessage(code, ttl));
      log.info("otp sent", { chat: maskId(chatId) }); // عمداً بدون کد
      return send(res, 200, { ok: true, messageId: (r && r.message_id) || null });
    } catch (e) {
      const c = classifySendError(e, { apiHealthy: health.ok });
      log.warn("otp send failed", { chat: maskId(chatId), reason: c.code, status: e && e.status, httpStatus: e && e.httpStatus, dev: e && e.devMessage });
      return send(res, 502, { ok: false, error: { code: c.code, retryable: c.retryable, permanent: c.permanent } });
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const path = (req.url || "").split("?")[0];
      if (req.method === "GET" && path === "/healthz") return send(res, 200, { ok: true, apiHealthy: health.ok, lastPollAt: poller ? poller.lastPollAt || null : null });
      if (req.method === "POST" && path === "/internal/send-otp") { if (!authorized(req)) return fail(res, 401, "UNAUTHORIZED"); return await sendOtp(req, res); }
      return fail(res, 404, "NOT_FOUND");
    } catch (e) { log.error("internal server error", { err: e }); if (!res.headersSent) fail(res, 500, "INTERNAL"); else res.end(); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  return server;
}
