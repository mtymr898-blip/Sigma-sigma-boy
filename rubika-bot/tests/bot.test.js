// تست‌های ربات: فرایند Start/اتصال، ارسال OTP، خطاها، offset، لاگ بدون کد
// اجرا: node --test tests/*.test.js   (سرور جعلی روبیکا و سایت روی پورت‌های تصادفی لوکال)
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRubikaApi, RubikaApiError, classifySendError } from "../src/rubikaApi.js";
import { createSiteClient } from "../src/siteClient.js";
import { createHandlers, looksLikeCode } from "../src/handlers.js";
import { createLimiter } from "../src/limiter.js";
import { createLogger } from "../src/logger.js";
import { createInternalServer } from "../src/internalServer.js";
import { createPoller } from "../src/poller.js";
import { createState } from "../src/state.js";
import { loadConfig, ConfigError } from "../src/config.js";

const TOKEN = "TESTTOKEN12345", SECRET = "x".repeat(40), CODE = "ABCD2345EFGH";
const servers = new Set();
const listen = (handler) => new Promise((res) => { const s = http.createServer(handler); servers.add(s); s.listen(0, "127.0.0.1", () => res({ s, url: `http://127.0.0.1:${s.address().port}` })); });
const closeAll = () => { for (const s of servers) { s.closeAllConnections?.(); s.close(); } servers.clear(); };
test.after(closeAll);
const readJson = async (req) => { const c = []; for await (const x of req) c.push(x); try { return JSON.parse(Buffer.concat(c).toString() || "{}"); } catch { return {}; } };
const json = (res, o, st = 200) => { res.writeHead(st, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
const logSink = () => { const lines = []; return { lines, stream: { write: (x) => lines.push(x) } }; };

// ---- سرور جعلی Rubika Bot API v3 ----
async function fakeRubika() {
  const st = { sent: [], updatesQueue: [], getUpdatesCalls: [], chatTypes: {}, failSend: null, calls: 0 };
  const { s, url } = await listen(async (req, res) => {
    const m = req.url.match(/^\/v3\/([^/]+)\/(\w+)$/); const b = await readJson(req); st.calls++;
    if (!m || m[1] !== TOKEN) return json(res, { status: "INVALID_ACCESS" }, 403);
    switch (m[2]) {
      case "getMe": return json(res, { status: "OK", data: { bot: { username: "qairo_bot" } } });
      case "setCommands": return json(res, { status: "OK", data: {} });
      case "getChat": return json(res, { status: "OK", data: { chat: { chat_id: b.chat_id, chat_type: st.chatTypes[b.chat_id] || "User" } } });
      case "sendMessage": {
        if (st.failSend) { const f = typeof st.failSend === "function" ? st.failSend(b) : st.failSend; if (f) return json(res, f.body, f.http || 200); }
        st.sent.push(b); return json(res, { status: "OK", data: { message_id: "m" + st.sent.length } });
      }
      case "getUpdates": { st.getUpdatesCalls.push(b); const batch = st.updatesQueue.shift(); return json(res, { status: "OK", data: { updates: batch ? batch.updates : [], next_offset_id: batch ? batch.next : (b.offset_id || "") } }); }
      default: return json(res, { status: "INVALID_INPUT", dev_message: "unknown" }, 400);
    }
  });
  return { st, url: url + "/v3", close: () => s.close() };
}
// ---- سایت جعلی (مدل ساده‌ی rubika.js) ----
async function fakeSite() {
  const st = { codes: new Map(), chats: new Map(), calls: [], down: false };
  const { s, url } = await listen(async (req, res) => {
    if (st.down) return res.destroy();
    const b = await readJson(req); st.calls.push({ path: req.url, auth: req.headers.authorization, body: b });
    if (req.headers.authorization !== "Bearer " + SECRET) return json(res, { ok: false, error: { code: "INTERNAL_UNAUTHORIZED" } }, 401);
    if (req.url.endsWith("/consume")) {
      const norm = String(b.code).toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (!st.codes.has(norm)) return json(res, { ok: false, error: { code: "BAD_CODE" } }, 400);
      st.codes.delete(norm); st.chats.set(b.chatId, true); return json(res, { ok: true, data: { linked: true } });
    }
    if (req.url.endsWith("/verify-chat")) return json(res, { ok: true, data: { connected: st.chats.get(b.chatId) === true } });
    if (req.url.endsWith("/chat-stopped")) { const had = st.chats.delete(b.chatId); return json(res, { ok: true, data: { unlinked: had } }); }
    json(res, { ok: false, error: { code: "NOT_FOUND" } }, 404);
  });
  return { st, url, close: () => s.close() };
}

async function rig({ otpPerChat = 6, otpGlobalPerMin = 120 } = {}) {
  const r = await fakeRubika(), site = await fakeSite(); const sink = logSink();
  const log = createLogger({ level: "debug", secrets: [TOKEN, SECRET], stream: sink.stream });
  const api = createRubikaApi({ token: TOKEN, baseUrl: r.url, timeoutMs: 2000 });
  const siteClient = createSiteClient({ baseUrl: site.url, secret: SECRET, timeoutMs: 2000 });
  const limiter = createLimiter(); const health = { ok: true };
  const handlers = createHandlers({ api, site: siteClient, log, limiter });
  const internal = createInternalServer({ config: { secret: SECRET, otpPerChat, otpGlobalPerMin }, api, site: siteClient, limiter, log, health, sleep: async () => {} });
  const ts = await listen((q, s) => internal.emit("request", q, s));
  const post = (p, body, auth = "Bearer " + SECRET) => fetch(ts.url + p, { method: "POST", headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) }, body: JSON.stringify(body) }).then(async (x) => ({ status: x.status, body: await x.json() }));
  return { r, site, sink, api, handlers, health, post, close: () => { r.close(); site.close(); ts.s.close(); } };
}
const newMsg = (chat, text, extra = {}) => ({ type: "NewMessage", chat_id: chat, new_message: { message_id: extra.id || String(Math.random()), text, sender_type: "User", sender_id: "u1", ...extra.m } });

test("۱: کاربر جدید /start می‌زند → پیام خوش‌آمد؛ هیچ تماسی با سایت نیست", async () => {
  const t = await rig(); await t.handlers.handleUpdate(newMsg("b0chatAAA", "/start"));
  assert.equal(t.r.st.sent.length, 1); assert.match(t.r.st.sent[0].text, /اتصال حساب روبیکا/); assert.equal(t.site.st.calls.length, 0); t.close();
});
test("۲: اتصال با start_id لینک (deep link)", async () => {
  const t = await rig(); t.site.st.codes.set(CODE, true);
  await t.handlers.handleUpdate(newMsg("b0chatAAA", "", { m: { aux_data: { start_id: CODE, button_id: null } } }));
  assert.equal(t.site.st.calls[0].body.chatId, "b0chatAAA"); assert.match(t.r.st.sent[0].text, /اتصال انجام شد/); t.close();
});
test("اتصال با «/start کد» و با ارسال دستی کد (مسیر جایگزین)", async () => {
  const t = await rig(); t.site.st.codes.set(CODE, true); t.site.st.codes.set("ZZZZ2222YYYY", true);
  await t.handlers.handleUpdate(newMsg("b0chatAAA", "/start " + CODE));
  await t.handlers.handleUpdate(newMsg("b0chatBBB", "zzzz-2222-yyyy"));
  assert.ok(t.r.st.sent.every((m) => /اتصال انجام شد/.test(m.text)) && t.r.st.sent.length === 2); t.close();
});
test("کد نامعتبر/استفاده‌شده → پیام خطا؛ متن عادی → راهنما و بدون تماس با سایت", async () => {
  const t = await rig(); await t.handlers.handleUpdate(newMsg("b0chatAAA", CODE));
  assert.match(t.r.st.sent[0].text, /نامعتبر/);
  const n = t.site.st.calls.length; await t.handlers.handleUpdate(newMsg("b0chatAAA", "سلام چطوری")); assert.equal(t.site.st.calls.length, n); assert.match(t.r.st.sent[1].text, /راهنما/); t.close();
});
test("اتصال از گروه/کانال رد می‌شود", async () => {
  const t = await rig(); t.r.st.chatTypes["g0grp"] = "Group"; t.site.st.codes.set(CODE, true);
  await t.handlers.handleUpdate(newMsg("g0grp", CODE)); assert.equal(t.site.st.calls.length, 0); assert.match(t.r.st.sent[0].text, /چت خصوصی/); t.close();
});
test("تحویل تکراری یک پیام و Start تکراری دوباره پردازش نمی‌شود", async () => {
  const t = await rig(); t.site.st.codes.set(CODE, true); const u = newMsg("b0chatAAA", CODE, { id: "same" });
  await t.handlers.handleUpdate(u); await t.handlers.handleUpdate(u);
  await t.handlers.handleUpdate({ type: "StartedBot", chat_id: "b0chatAAA", aux_data: { start_id: CODE } });
  assert.equal(t.site.st.calls.length, 1); assert.equal(t.r.st.sent.length, 1); t.close();
});
test("پیام فرستنده‌ی غیرکاربر، پیام ویرایش‌شده و نوع‌های ناشناخته نادیده گرفته می‌شوند", async () => {
  const t = await rig();
  await t.handlers.handleUpdate(newMsg("b0chatAAA", "/start", { m: { sender_type: "Bot" } }));
  await t.handlers.handleUpdate(newMsg("b0chatAAA", "/start", { m: { is_edited: true } }));
  await t.handlers.handleUpdate({ type: "RemovedMessage", chat_id: "b0chatAAA" }); await t.handlers.handleUpdate(null);
  assert.equal(t.r.st.sent.length, 0); t.close();
});
test("/unlink و StoppedBot اتصال را در سایت قطع می‌کنند", async () => {
  const t = await rig(); t.site.st.chats.set("b0chatAAA", true); t.site.st.chats.set("b0chatBBB", true);
  await t.handlers.handleUpdate(newMsg("b0chatAAA", "/unlink")); assert.match(t.r.st.sent[0].text, /اتصال قطع شد/); assert.equal(t.site.st.chats.has("b0chatAAA"), false);
  await t.handlers.handleUpdate({ type: "StoppedBot", chat_id: "b0chatBBB" }); assert.equal(t.site.st.chats.has("b0chatBBB"), false); assert.equal(t.r.st.sent.length, 1); t.close();
});
test("سایت در دسترس نیست → پیام مناسب به کاربر (بدون کرش)", async () => {
  const t = await rig(); t.site.st.down = true; await t.handlers.handleUpdate(newMsg("b0chatAAA", CODE)); assert.match(t.r.st.sent[0].text, /نمی‌توانم به سرویس وصل شوم/); t.close();
});

// ---- ارسال OTP ----
test("۳-۴: ارسال موفق OTP به کاربر متصل؛ متن شامل کد؛ لاگ بدون کد", async () => {
  const t = await rig(); t.site.st.chats.set("b0chatAAA", true);
  const r = await t.post("/internal/send-otp", { chatId: "b0chatAAA", code: "482913", ttlSec: 120 });
  assert.equal(r.status, 200); assert.equal(r.body.ok, true);
  assert.equal(t.r.st.sent[0].chat_id, "b0chatAAA"); assert.ok(t.r.st.sent[0].text.includes("482913"));
  assert.ok(!t.sink.lines.join("").includes("482913"), "کد نباید در لاگ باشد"); t.close();
});
test("۵: کاربر غیرمتصل → ۴۰۹ و هیچ پیامی به روبیکا نمی‌رود", async () => {
  const t = await rig(); const r = await t.post("/internal/send-otp", { chatId: "b0chatXXX", code: "482913", ttlSec: 120 });
  assert.equal(r.status, 409); assert.equal(r.body.error.code, "NOT_CONNECTED"); assert.equal(t.r.st.sent.length, 0); t.close();
});
test("قطع اتصال از سایت → ارسال بعدی رد می‌شود (۶)", async () => {
  const t = await rig(); t.site.st.chats.set("b0chatAAA", true); assert.equal((await t.post("/internal/send-otp", { chatId: "b0chatAAA", code: "111111", ttlSec: 120 })).status, 200);
  t.site.st.chats.delete("b0chatAAA"); assert.equal((await t.post("/internal/send-otp", { chatId: "b0chatAAA", code: "222222", ttlSec: 120 })).status, 409); t.close();
});
test("احراز: بدون/اشتباه → ۴۰۱؛ ورودی نامعتبر → ۴۰۰؛ مسیر ناشناس → ۴۰۴", async () => {
  const t = await rig(); t.site.st.chats.set("b0chatAAA", true);
  assert.equal((await t.post("/internal/send-otp", { chatId: "b0chatAAA", code: "123456" }, null)).status, 401);
  assert.equal((await t.post("/internal/send-otp", { chatId: "b0chatAAA", code: "123456" }, "Bearer nope")).status, 401);
  assert.equal((await t.post("/internal/send-otp", { chatId: "b0chatAAA", code: "abcdef" })).status, 400);
  assert.equal((await t.post("/internal/send-otp", { chatId: "../x", code: "123456" })).status, 400);
  assert.equal((await t.post("/internal/send-otp", { chatId: "b0chatAAA", code: "123456", ttlSec: 99999 })).status, 400);
  assert.equal((await t.post("/other", {})).status, 404); assert.equal(t.r.st.sent.length, 0); t.close();
});
test("۷: chat_id نامعتبر در روبیکا (INVALID_INPUT، API سالم) → permanent:true", async () => {
  const t = await rig(); t.site.st.chats.set("b0dead", true); t.r.st.failSend = { body: { status: "INVALID_INPUT", dev_message: "bad chat" }, http: 400 };
  const r = await t.post("/internal/send-otp", { chatId: "b0dead", code: "123456", ttlSec: 120 });
  assert.equal(r.status, 502); assert.equal(r.body.error.permanent, true); assert.equal(r.body.error.code, "CHAT_REJECTED");
  t.health.ok = false; const r2 = await t.post("/internal/send-otp", { chatId: "b0dead", code: "123456", ttlSec: 120 }); assert.equal(r2.body.error.permanent, false, "اگر API ناسالم باشد دائمی حساب نشود"); t.close();
});
test("۸: خطای گذرا روبیکا (۵xx) یک‌بار retry می‌شود و موفق می‌شود", async () => {
  const t = await rig(); t.site.st.chats.set("b0chatAAA", true); let n = 0; t.r.st.failSend = () => (++n === 1 ? { body: { status: "ERR" }, http: 503 } : null);
  const r = await t.post("/internal/send-otp", { chatId: "b0chatAAA", code: "123456", ttlSec: 120 }); assert.equal(r.status, 200); assert.equal(n, 2); t.close();
});
test("۸: خطای دائمی گذرا (همیشه ۵xx) → ۵۰۲ retryable و بدون نشت کد", async () => {
  const t = await rig(); t.site.st.chats.set("b0chatAAA", true); t.r.st.failSend = { body: { status: "ERR" }, http: 500 };
  const r = await t.post("/internal/send-otp", { chatId: "b0chatAAA", code: "135790", ttlSec: 120 }); assert.equal(r.status, 502); assert.equal(r.body.error.retryable, true);
  assert.ok(!t.sink.lines.join("").includes("135790")); t.close();
});
test("INVALID_ACCESS (توکن بد) → BOT_AUTH و دائمی نیست", async () => {
  const t = await rig(); t.site.st.chats.set("b0chatAAA", true); t.r.st.failSend = { body: { status: "INVALID_ACCESS" }, http: 403 };
  const r = await t.post("/internal/send-otp", { chatId: "b0chatAAA", code: "123456", ttlSec: 120 }); assert.deepEqual([r.body.error.code, r.body.error.permanent], ["BOT_AUTH", false]); t.close();
});
test("۱۰: ۲۰ درخواست هم‌زمان به یک چت → فقط سقف مجاز (۶) به روبیکا می‌رسد", async () => {
  const t = await rig({ otpPerChat: 6 }); t.site.st.chats.set("b0chatAAA", true);
  const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => t.post("/internal/send-otp", { chatId: "b0chatAAA", code: String(100000 + i), ttlSec: 120 })));
  assert.equal(rs.filter((x) => x.status === 200).length, 6); assert.equal(rs.filter((x) => x.status === 429).length, 14); assert.equal(t.r.st.sent.length, 6); t.close();
});
test("سقف کل در دقیقه برای چت‌های مختلف", async () => {
  const t = await rig({ otpGlobalPerMin: 3 }); for (let i = 0; i < 5; i++) t.site.st.chats.set("b0chatC" + i, true);
  const rs = []; for (let i = 0; i < 5; i++) rs.push((await t.post("/internal/send-otp", { chatId: "b0chatC" + i, code: "123456", ttlSec: 120 })).status);
  assert.deepEqual(rs, [200, 200, 200, 429, 429]); t.close();
});
test("سایت خاموش → ۵۰۳ و پیام ارسال نمی‌شود (fail-closed)", async () => {
  const t = await rig(); t.site.st.chats.set("b0chatAAA", true); t.site.st.down = true;
  const r = await t.post("/internal/send-otp", { chatId: "b0chatAAA", code: "123456", ttlSec: 120 }); assert.equal(r.status, 503); assert.equal(t.r.st.sent.length, 0); t.close();
});

// ---- polling / offset ----
test("polling: offset_id ذخیره و بعد از restart ادامه می‌یابد؛ خطای یک آپدیت بقیه را نمی‌شکند", async () => {
  const t = await rig(); const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-")); const log = createLogger({ level: "error", stream: t.sink.stream });
  t.site.st.codes.set(CODE, true);
  t.r.st.updatesQueue.push({ next: "OFF1", updates: [{ type: "NewMessage", chat_id: "b0chatAAA", new_message: null }, newMsg("b0chatAAA", CODE, { id: "1" })] }, { next: "OFF2", updates: [] });
  let state = createState(dir); let p = createPoller({ api: t.api, handlers: t.handlers, state, log, intervalMs: 1000 });
  assert.equal(await p.pollOnce(), 2); assert.equal(state.offsetId, "OFF1"); assert.equal(t.r.st.getUpdatesCalls[0].offset_id, undefined);
  await p.pollOnce(); assert.equal(t.r.st.getUpdatesCalls[1].offset_id, "OFF1");
  state = createState(dir); assert.equal(state.offsetId, "OFF2"); p = createPoller({ api: t.api, handlers: t.handlers, state, log }); await p.pollOnce(); assert.equal(t.r.st.getUpdatesCalls[2].offset_id, "OFF2");
  assert.equal(t.site.st.calls.length, 1); t.close();
});

// ---- واحدها ----
test("لاگر: توکن/راز/کد/متن هرگز چاپ نمی‌شوند", () => {
  const s = logSink(); const log = createLogger({ level: "debug", secrets: [TOKEN, SECRET], stream: s.stream });
  log.info(`url https://x/${TOKEN}/send`, { code: "123456", text: "hi", token: TOKEN, nested: { otp: "999999", ok: 1 }, err: new Error("fail " + SECRET) });
  const out = s.lines.join(""); for (const bad of [TOKEN, SECRET, "123456", "999999", '"hi"']) assert.ok(!out.includes(bad), bad); assert.ok(out.includes('"ok":1'));
});
test("خطاهای API آدرس/توکن را در پیام ندارند و طبقه‌بندی درست است", async () => {
  const api = createRubikaApi({ token: TOKEN, baseUrl: "http://127.0.0.1:1/v3", timeoutMs: 500 });
  const e = await api.sendMessage("b0chatAAA", "x").catch((x) => x); assert.ok(e instanceof RubikaApiError); assert.ok(!e.message.includes(TOKEN)); assert.equal(classifySendError(e).retryable, true);
  assert.equal(classifySendError(new RubikaApiError("x", { kind: "api", status: "TOO_REQUEST", httpStatus: 429 })).code, "RATE_LIMITED");
});
test("پیکربندی: توکن/راز اجباری، راز کوتاه رد، bind غیرلوکال رد", () => {
  assert.throws(() => loadConfig({}), ConfigError);
  assert.throws(() => loadConfig({ RUBIKA_BOT_TOKEN: TOKEN, RUBIKA_INTERNAL_SECRET: "short" }), /۳۲/);
  assert.throws(() => loadConfig({ RUBIKA_BOT_TOKEN: TOKEN, RUBIKA_INTERNAL_SECRET: SECRET, BOT_HOST: "0.0.0.0" }), /BOT_HOST/);
  const c = loadConfig({ RUBIKA_BOT_TOKEN: TOKEN, RUBIKA_INTERNAL_SECRET: SECRET }); assert.equal(c.host, "127.0.0.1"); assert.equal(c.port, 8790);
});
test("looksLikeCode", () => { assert.ok(looksLikeCode("abcd-2345-efgh")); assert.ok(!looksLikeCode("hello world 12")); assert.ok(!looksLikeCode("OOOO00001111")); });
