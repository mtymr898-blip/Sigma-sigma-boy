// تست انتها‌به‌انتها: سرور واقعی (server.js) + ربات واقعی (rubika-bot) + سرور جعلی Rubika Bot API
// اجرا (از ریشه‌ی پروژه):  node tests/e2e/rubika-e2e.mjs      (حدود ۴۰ ثانیه؛ cooldown کد ورود ۳۰ ثانیه است)
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TOKEN = "E2E-BOT-TOKEN-123456", SECRET = "e".repeat(48), SESSION = "S".repeat(48);
const free = () => new Promise((r) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = async (req) => { const c = []; for await (const x of req) c.push(x); try { return JSON.parse(Buffer.concat(c).toString() || "{}"); } catch { return {}; } };
const send = (res, o, st = 200) => { res.writeHead(st, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
let failures = 0; const step = (name) => console.log("▶", name); const pass = (m) => console.log("  ✓", m);

// ---- Rubika جعلی ----
const rb = { sent: [], queue: [], failChats: new Set(), seq: 0 };
const rubikaSrv = http.createServer(async (req, res) => {
  const m = req.url.match(/^\/v3\/([^/]+)\/(\w+)$/); const b = await readJson(req);
  if (req.url === "/__push") { rb.queue.push(b); return send(res, { ok: true }); }
  if (!m || m[1] !== TOKEN) return send(res, { status: "INVALID_ACCESS" }, 403);
  if (m[2] === "getMe") return send(res, { status: "OK", data: { bot: { username: "qairo_bot" } } });
  if (m[2] === "setCommands") return send(res, { status: "OK", data: {} });
  if (m[2] === "getChat") return send(res, { status: "OK", data: { chat: { chat_id: b.chat_id, chat_type: "User" } } });
  if (m[2] === "sendMessage") { if (rb.failChats.has(b.chat_id)) return send(res, { status: "INVALID_INPUT", dev_message: "chat not found" }, 400); rb.sent.push(b); return send(res, { status: "OK", data: { message_id: "m" + ++rb.seq } }); }
  if (m[2] === "getUpdates") { const batch = rb.queue.shift(); return send(res, { status: "OK", data: { updates: batch ? batch.updates : [], next_offset_id: batch ? batch.next : b.offset_id || "" } }); }
  send(res, { status: "INVALID_INPUT" }, 400);
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-"));
const procs = []; let siteOut = ""; let botOut = "";
const spawnProc = (cmd, args, env, cwd, onOut) => { const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env } }); p.stdout.on("data", (d) => onOut(String(d))); p.stderr.on("data", (d) => onOut(String(d))); procs.push(p); return p; };
const waitFor = async (fn, ms = 15000, label = "") => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(150); } throw new Error("timeout: " + label); };

const rubikaPort = await free(), sitePort = await free(), botPort = await free();
await new Promise((r) => rubikaSrv.listen(rubikaPort, "127.0.0.1", r));
const SITE = `http://127.0.0.1:${sitePort}`;
spawnProc("node", ["server.js"], { PORT: String(sitePort), HOST: "127.0.0.1", DATA_FILE: path.join(tmp, "store.json"), SESSION_SECRET: SESSION, VAULT_SECRET: "V".repeat(48), REGISTRATION_MODE: "open", SMS_PROVIDER: "console", OTP_RESEND_SEC: "30", PBKDF2_ITER: "2000",
  RUBIKA_ENABLED: "true", RUBIKA_INTERNAL_SECRET: SECRET, RUBIKA_BOT_URL: `http://127.0.0.1:${botPort}`, RUBIKA_BOT_USERNAME: "qairo_bot", ENGINE_TICK_SEC: "3600" }, ROOT, (s) => { siteOut += s; });
spawnProc("node", ["src/index.js"], { RUBIKA_BOT_TOKEN: TOKEN, RUBIKA_INTERNAL_SECRET: SECRET, SITE_BASE_URL: SITE, BOT_HOST: "127.0.0.1", BOT_PORT: String(botPort), RUBIKA_API_BASE: `http://127.0.0.1:${rubikaPort}/v3`, POLL_INTERVAL_MS: "1000", DATA_DIR: path.join(tmp, "botdata"), LOG_LEVEL: "debug" }, path.join(ROOT, "rubika-bot"), (s) => { botOut += s; });

const api = async (p, { method = "POST", body, token, headers = {} } = {}) => { const r = await fetch(SITE + p, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined }); let j = null; try { j = await r.json(); } catch {} return { status: r.status, j, d: j && j.data !== undefined ? j.data : j }; };
const consoleOtp = (phone) => { const m = [...siteOut.matchAll(new RegExp(`\\[OTP\\] ${phone} → (\\d+)`, "g"))]; return m.length ? m[m.length - 1][1] : null; };
const rubikaCodeFor = (chat, since) => { const m = rb.sent.slice(since).filter((x) => x.chat_id === chat).map((x) => (x.text.match(/\n(\d{6})\n/) || [])[1]).filter(Boolean); return m.length ? m[m.length - 1] : null; };
const pushStart = (chat, code, id) => { rb.queue.push({ next: "O" + id, updates: [{ type: "NewMessage", chat_id: chat, new_message: { message_id: "mm" + id, text: "", sender_type: "User", sender_id: "u", aux_data: { start_id: code } } }] }); };

try {
  await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${botPort}/healthz`)).ok; } catch { return false; } }, 15000, "bot up");
  await waitFor(async () => { try { return (await fetch(SITE + "/api/auth/otp/send", { method: "POST" })).status > 0; } catch { return false; } }, 15000, "site up");
  step("راه‌اندازی"); pass("سایت و ربات بالا آمدند");

  const phones = [["09121110001", "b0chatOK0001"], ["09121110002", "b0chatFAIL02"], ["09121110003", "b0chatGONE03"]]; const sessions = {};
  step("ثبت‌نام سه کاربر با پیامک (روش فعلی) و اتصال روبیکا");
  let n = 0;
  for (const [phone, chat] of phones) {
    assert.equal((await api("/api/auth/otp/send", { body: { phone } })).status, 200);
    const code = await waitFor(async () => consoleOtp(phone), 5000, "console otp");
    const v = await api("/api/auth/otp/verify", { body: { phone, code } }); assert.equal(v.status, 200, JSON.stringify(v.j));
    const reg = await api("/api/auth/register", { body: { phone, otpToken: v.d.otpToken, password: "Zx9!kLm-Qw2e" } }); assert.equal(reg.status, 200, JSON.stringify(reg.j));
    sessions[phone] = reg.d.token;
    assert.equal((await api("/api/rubika/status", { method: "GET", token: sessions[phone] })).d.status, "not_connected");
    const st = await api("/api/rubika/link/start", { token: sessions[phone] }); assert.equal(st.status, 200, JSON.stringify(st.j));
    assert.match(st.d.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/); assert.match(st.d.link, /^https:\/\/rubika\.ir\/qairo_bot\?st=/);
    assert.equal((await api("/api/rubika/status", { method: "GET", token: sessions[phone] })).d.status, "pending");
    pushStart(chat, st.d.code.replace(/-/g, ""), ++n);
    await waitFor(() => rb.sent.some((x) => x.chat_id === chat && /اتصال انجام شد/.test(x.text)), 10000, "linked msg " + chat);
    assert.equal((await api("/api/rubika/status", { method: "GET", token: sessions[phone] })).d.status, "connected");
    pass(`${phone} ← ${chat} متصل شد`);
  }

  step("امنیت endpointهای داخلی");
  const hdr = { Authorization: "Bearer " + SECRET };
  const direct = await fetch(SITE + "/api/internal/rubika/verify-chat", { method: "POST", headers: { "Content-Type": "application/json", ...hdr }, body: JSON.stringify({ chatId: "b0chatOK0001" }) });
  assert.equal(direct.status, 200); pass("با راز درست و بدون proxy → ۲۰۰");
  const proxied = await fetch(SITE + "/api/internal/rubika/verify-chat", { method: "POST", headers: { "Content-Type": "application/json", ...hdr, "X-Forwarded-For": "8.8.8.8" }, body: JSON.stringify({ chatId: "b0chatOK0001" }) });
  assert.equal(proxied.status, 404); pass("درخواست از اینترنت (پشت proxy) → ۴۰۴");
  assert.equal((await fetch(SITE + "/api/internal/rubika/consume", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401); pass("بدون راز → ۴۰۱");
  assert.equal((await fetch(`http://127.0.0.1:${botPort}/internal/send-otp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId: "b0chatOK0001", code: "123456" }) })).status, 401); pass("API ارسال OTP ربات بدون راز → ۴۰۱");
  const sentBefore = rb.sent.length;
  assert.equal((await fetch(`http://127.0.0.1:${botPort}/internal/send-otp`, { method: "POST", headers: { "Content-Type": "application/json", ...hdr }, body: JSON.stringify({ chatId: "b0chatNOBODY", code: "123456", ttlSec: 120 }) })).status, 409);
  assert.equal(rb.sent.length, sentBefore); pass("ارسال به chat_id متصل‌نشده → ۴۰۹ و پیامی نرفت");

  step("قطع اتصال کاربر ۳ از سایت و انتظار cooldown ۳۰ ثانیه‌ای کد ورود…");
  assert.equal((await api("/api/rubika/disconnect", { token: sessions["09121110003"] })).d.status, "disconnected");
  rb.failChats.add("b0chatFAIL02"); // روبیکا برای کاربر ۲ خطای chat نامعتبر بدهد
  await sleep(31000);

  step("ورود دوباره: کاربر ۱ (روبیکا)");
  const base = rb.sent.length, logLen = siteOut.length;
  assert.equal((await api("/api/auth/otp/send", { body: { phone: phones[0][0] } })).status, 200);
  const rcode = await waitFor(async () => rubikaCodeFor("b0chatOK0001", base), 8000, "otp via rubika");
  assert.ok(!siteOut.slice(logLen).includes("[OTP] 09121110001"), "کد نباید در لاگ سایت باشد");
  assert.ok(!botOut.includes(rcode), "کد نباید در لاگ ربات باشد");
  const v1 = await api("/api/auth/otp/verify", { body: { phone: phones[0][0], code: rcode } }); assert.equal(v1.status, 200); assert.equal(v1.d.hasAccount, true);
  const lg = await api("/api/auth/login", { body: { phone: phones[0][0], otpToken: v1.d.otpToken, password: "Zx9!kLm-Qw2e" } }); assert.equal(lg.status, 200); assert.ok(lg.d.token);
  pass("کد از روبیکا رسید، با سیستم فعلی تأیید شد و ورود موفق بود؛ هیچ پیامکی چاپ نشد و کد در لاگ‌ها نیست");

  step("کاربر ۲: روبیکا خطا می‌دهد → پیامک جایگزین، ورود همچنان سالم");
  assert.equal((await api("/api/auth/otp/send", { body: { phone: phones[1][0] } })).status, 200);
  const sms2 = await waitFor(async () => consoleOtp(phones[1][0]) !== null && siteOut.lastIndexOf("[OTP] 09121110002") > siteOut.indexOf("[OTP] 09121110002") ? consoleOtp(phones[1][0]) : null, 8000, "fallback sms");
  const v2 = await api("/api/auth/otp/verify", { body: { phone: phones[1][0], code: sms2 } }); assert.equal(v2.status, 200); pass("fallback به پیامک کار کرد");

  step("کاربر ۳: اتصال قطع شده → مستقیم پیامک");
  const base3 = rb.sent.length; assert.equal((await api("/api/auth/otp/send", { body: { phone: phones[2][0] } })).status, 200);
  const sms3 = await waitFor(async () => (siteOut.match(/\[OTP\] 09121110003/g) || []).length >= 2, 8000, "sms3"); assert.ok(sms3);
  assert.equal(rb.sent.slice(base3).filter((x) => x.chat_id === "b0chatGONE03" && /\n\d{6}\n/.test(x.text)).length, 0); pass("بعد از قطع اتصال، به روبیکا چیزی نرفت");

  step("شمارش‌گر: لاگ ربات بدون توکن/راز");
  assert.ok(!botOut.includes(TOKEN) && !botOut.includes(SECRET)); assert.ok(!siteOut.includes(SECRET)); pass("توکن و راز در هیچ لاگی نیست");
  console.log("\n✅ همه‌ی سناریوهای انتها‌به‌انتها موفق بودند");
} catch (e) { failures++; console.error("\n❌ شکست:", e && e.stack || e); console.error("--- site log tail ---\n" + siteOut.slice(-1500)); console.error("--- bot log tail ---\n" + botOut.slice(-1500)); }
finally { for (const p of procs) p.kill("SIGTERM"); rubikaSrv.closeAllConnections?.(); rubikaSrv.close(); await sleep(300); process.exit(failures ? 1 : 0); }
