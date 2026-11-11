// ===================================================================
// config.js — خواندن و اعتبارسنجی تنظیمات از متغیرهای محیطی
// توکن ربات و راز مشترک فقط از env خوانده می‌شوند و هرگز لاگ نمی‌شوند.
// ===================================================================
export class ConfigError extends Error {}

const int = (v, min, max, dflt) => { const n = Number(v); return Number.isInteger(n) && n >= min && n <= max ? n : dflt; };
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export function loadConfig(env = process.env) {
  const errors = [];
  const get = (k) => String(env[k] === undefined ? "" : env[k]).trim();
  const token = get("RUBIKA_BOT_TOKEN"); if (!token) errors.push("RUBIKA_BOT_TOKEN تنظیم نشده است.");
  else if (/\s/.test(token) || token.length < 8) errors.push("RUBIKA_BOT_TOKEN نامعتبر به نظر می‌رسد.");
  const secret = get("RUBIKA_INTERNAL_SECRET"); if (!secret) errors.push("RUBIKA_INTERNAL_SECRET تنظیم نشده است.");
  else if (secret.length < 32) errors.push("RUBIKA_INTERNAL_SECRET باید حداقل ۳۲ کاراکتر باشد.");
  const host = get("BOT_HOST") || "127.0.0.1";
  if (!LOOPBACK.has(host) && get("BOT_ALLOW_REMOTE").toLowerCase() !== "true")
    errors.push("BOT_HOST فقط می‌تواند آدرس لوکال باشد (API ارسال کد نباید عمومی شود). در صورت نیاز BOT_ALLOW_REMOTE=true.");
  const siteBase = (get("SITE_BASE_URL") || "http://127.0.0.1:8787").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(siteBase)) errors.push("SITE_BASE_URL نامعتبر است.");
  const apiBase = (get("RUBIKA_API_BASE") || "https://botapi.rubika.ir/v3").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(apiBase)) errors.push("RUBIKA_API_BASE نامعتبر است.");
  if (errors.length) { const e = new ConfigError(errors.join("\n")); e.errors = errors; throw e; }
  return {
    token, secret, host, siteBase, apiBase,
    port: int(get("BOT_PORT"), 1, 65535, 8790),
    pollIntervalMs: int(get("POLL_INTERVAL_MS"), 1000, 60000, 3000),
    dataDir: get("DATA_DIR") || "./data",
    logLevel: ["debug", "info", "warn", "error"].includes(get("LOG_LEVEL")) ? get("LOG_LEVEL") : "info",
    otpPerChat: int(get("OTP_PER_CHAT_LIMIT"), 1, 100, 6),
    otpGlobalPerMin: int(get("OTP_GLOBAL_PER_MIN"), 1, 10000, 120),
  };
}
