// ===================================================================
// logger.js — لاگ JSON خط‌به‌خط (برای journalctl) با حذف خودکار اطلاعات حساس
// • کلیدهایی مثل code/otp/token/secret/text/authorization هرگز چاپ نمی‌شوند.
// • اگر مقدار توکن/راز در هر رشته‌ای ببیند، با [REDACTED] جایگزین می‌شود.
// • شناسه‌ی چت‌ها فقط به‌صورت ماسک‌شده لاگ می‌شوند.
// ===================================================================
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSITIVE_KEY = /code|otp|token|secret|authorization|password|text|body|start_?id/i;

export const maskId = (id) => { const s = String(id || ""); return s.length <= 8 ? "***" : `${s.slice(0, 4)}…${s.slice(-3)}`; };

export function createLogger({ level = "info", secrets = [], stream = process.stdout } = {}) {
  const min = LEVELS[level] || LEVELS.info;
  const secs = secrets.filter((s) => typeof s === "string" && s.length >= 6);
  const scrub = (v, depth = 0) => {
    if (typeof v === "string") { let o = v; for (const s of secs) if (o.includes(s)) o = o.split(s).join("[REDACTED]"); return o.length > 300 ? o.slice(0, 300) + "…" : o; }
    if (v instanceof Error) return scrub(`${v.name}: ${v.message}`);
    if (v && typeof v === "object" && depth < 3) {
      const out = Array.isArray(v) ? [] : {};
      for (const [k, x] of Object.entries(v)) out[k] = SENSITIVE_KEY.test(k) ? "[REDACTED]" : scrub(x, depth + 1);
      return out;
    }
    return v;
  };
  const emit = (lvl, msg, fields) => {
    if (LEVELS[lvl] < min) return;
    const line = { t: new Date().toISOString(), level: lvl, msg: scrub(String(msg)), ...(fields ? scrub(fields) : {}) };
    stream.write(JSON.stringify(line) + "\n");
  };
  return { debug: (m, f) => emit("debug", m, f), info: (m, f) => emit("info", m, f), warn: (m, f) => emit("warn", m, f), error: (m, f) => emit("error", m, f) };
}
