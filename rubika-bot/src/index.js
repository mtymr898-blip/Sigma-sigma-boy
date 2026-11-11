// ===================================================================
// index.js — راه‌انداز ربات روبیکا (QAIRO OTP bot)
// polling روی getUpdates + API داخلی ارسال کد (فقط لوکال). مستقل از پروسه‌ی سایت اجرا می‌شود.
// ===================================================================
import { loadConfig, ConfigError } from "./config.js";
import { createLogger } from "./logger.js";
import { createRubikaApi, RubikaApiError } from "./rubikaApi.js";
import { createSiteClient } from "./siteClient.js";
import { createLimiter } from "./limiter.js";
import { createState } from "./state.js";
import { createHandlers } from "./handlers.js";
import { createPoller } from "./poller.js";
import { createInternalServer } from "./internalServer.js";

let config;
try { config = loadConfig(); }
catch (e) { if (e instanceof ConfigError) { console.error("پیکربندی نامعتبر:\n" + e.message); process.exit(2); } throw e; }

const log = createLogger({ level: config.logLevel, secrets: [config.token, config.secret] });
const api = createRubikaApi({ token: config.token, baseUrl: config.apiBase });
const site = createSiteClient({ baseUrl: config.siteBase, secret: config.secret });
const limiter = createLimiter();
const state = createState(config.dataDir);
const health = { ok: false, checkedAt: 0 };

async function checkHealth() {
  try { const me = await api.getMe(); health.ok = true; health.checkedAt = Date.now(); return me; }
  catch (e) { health.ok = false; throw e; }
}

const handlers = createHandlers({ api, site, log, limiter });
const poller = createPoller({ api, handlers, state, log, intervalMs: config.pollIntervalMs });
const server = createInternalServer({ config, api, site, limiter, log, health, poller });

async function main() {
  try {
    const me = await checkHealth();
    log.info("rubika bot ready", { bot: me && me.username ? "@" + me.username : "?" });
    api.setCommands([{ command: "start", description: "شروع و اتصال حساب" }, { command: "unlink", description: "قطع اتصال حساب" }, { command: "help", description: "راهنما" }])
      .catch((e) => log.warn("setCommands failed", { kind: e && e.kind, status: e && e.status }));
  } catch (e) {
    if (e instanceof RubikaApiError && e.kind === "api") { log.error("getMe rejected: توکن/نسخه‌ی API را بررسی کنید", { status: e.status, dev: e.devMessage }); process.exit(1); }
    log.warn("getMe failed (network?) — ادامه با تلاش مجدد", { kind: e && e.kind });
  }
  setInterval(() => checkHealth().catch(() => {}), 5 * 60000).unref(); // سلامت API (برای طبقه‌بندی خطای چت نامعتبر)
  server.listen(config.port, config.host, () => log.info("internal API listening", { host: config.host, port: config.port }));
  poller.start();
  log.info("polling started", { everyMs: config.pollIntervalMs, resumeFrom: state.offsetId ? "saved offset" : "start" });
}

let closing = false;
async function shutdown(sig) {
  if (closing) return; closing = true; log.info("shutting down", { signal: sig });
  await poller.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref();
}
for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => shutdown(s));
process.on("unhandledRejection", (e) => log.error("unhandledRejection", { err: e }));
main();
