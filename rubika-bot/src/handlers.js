// ===================================================================
// handlers.js — پردازش آپدیت‌های روبیکا (Start، کد اتصال، /unlink)
// • اتصال فقط با «کد اتصال یک‌بارمصرف» انجام می‌شود (از start_id لینک یا پیام کاربر)؛ هرگز با شماره‌ی موبایل.
// • محتوای پیام کاربر لاگ نمی‌شود (ممکن است کد اتصال باشد).
// ===================================================================
import { maskId } from "./logger.js";
import { T } from "./texts.js";

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // باید با src/rubika.js سایت یکی باشد
const stripCode = (s) => String(s || "").toUpperCase().replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0)).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[^A-Z0-9]/g, "");
export const looksLikeCode = (s) => { const c = stripCode(s); return c.length === 12 && [...c].every((ch) => ALPHABET.includes(ch)); };

export function createHandlers({ api, site, log, limiter, now = () => Date.now() }) {
  const seen = new Map();       // کلید پیام → زمان (جلوگیری از پردازش تکراری)
  const linkedRecently = new Map(); // chatId → {raw, at} فقط بعد از اتصال موفق؛ برای نادیده گرفتن تحویل تکراریِ همان Start

  const welcomed = new Map();   // chatId → زمان؛ StartedBot و «/start» ممکن است هر دو برسند، خوش‌آمد دوباره نمی‌دهیم
  const welcome = (chatId) => { const t = now(); if (welcomed.get(chatId) > t - 10000) return; welcomed.set(chatId, t); if (welcomed.size > 2000) welcomed.clear(); return reply(chatId, T.welcome); };
  const dup = (key) => {
    if (seen.has(key)) return true;
    seen.set(key, now()); if (seen.size > 5000) for (const k of [...seen.keys()].slice(0, 1000)) seen.delete(k);
    return false;
  };
  async function reply(chatId, text) {
    if (!limiter.hit(`reply:${chatId}`, 12, 60000).allowed) return; // جلوگیری از اسپم/حلقه
    try { await api.sendMessage(chatId, text); } catch (e) { log.warn("reply failed", { chat: maskId(chatId), kind: e && e.kind, status: e && e.status }); }
  }
  async function isGroupOrChannel(chatId) {
    try { const chat = await api.getChat(chatId); const t = String((chat && chat.chat_type) || "").toLowerCase(); return t === "group" || t === "channel"; }
    catch (_) { return false; } // اگر نتوانستیم بررسی کنیم، اتصال همچنان نیازمند کد یک‌بارمصرف است
  }

  async function linkAttempt(chatId, raw) {
    const rl = linkedRecently.get(chatId);
    if (rl && rl.raw === raw && now() - rl.at < 60000) return; // همان Start که دوبار رسیده
    if (!limiter.hit(`link:${chatId}`, 10, 10 * 60000).allowed) return reply(chatId, T.tooMany);
    if (await isGroupOrChannel(chatId)) return reply(chatId, T.notPrivate);
    const r = await site.consume(raw, chatId);
    if (r.ok) { linkedRecently.set(chatId, { raw, at: now() }); log.info("account linked", { chat: maskId(chatId) }); return reply(chatId, T.linked); }
    log.info("link failed", { chat: maskId(chatId), reason: r.code });
    if (r.code === "BAD_CODE" || r.code === "BAD_CHAT") return reply(chatId, T.badCode);
    if (r.code === "CHAT_IN_USE") return reply(chatId, T.chatInUse);
    if (r.code === "TOO_MANY_ATTEMPTS") return reply(chatId, T.tooMany);
    if (r.code === "RUBIKA_NOT_CONFIGURED") return reply(chatId, T.notEnabled);
    return reply(chatId, T.siteDown);
  }
  async function unlink(chatId, silent) {
    const r = await site.chatStopped(chatId);
    log.info("unlink", { chat: maskId(chatId), reason: r.ok ? (r.data && r.data.unlinked ? "unlinked" : "none") : r.code });
    if (silent) return;
    if (!r.ok) return reply(chatId, T.siteDown);
    return reply(chatId, r.data && r.data.unlinked ? T.unlinked : T.notLinked);
  }

  async function onMessage(chatId, m) {
    const text = typeof m.text === "string" ? m.text.trim() : "";
    const startId = m.aux_data && typeof m.aux_data.start_id === "string" && m.aux_data.start_id ? m.aux_data.start_id : null;
    const [first = "", ...rest] = text.split(/\s+/); const cmd = first.toLowerCase().replace(/@\w+$/, "");
    if (cmd === "/start" || cmd === "start") { // /start [کد]  یا ورود از لینک دارای start_id
      const payload = rest[0] || startId; return payload ? linkAttempt(chatId, payload) : welcome(chatId);
    }
    if (startId && !text) return linkAttempt(chatId, startId);
    if (cmd === "/unlink" || text === "قطع اتصال") return unlink(chatId, false);
    if (cmd === "/help" || cmd === "help" || text === "راهنما") return reply(chatId, T.help);
    if (looksLikeCode(text)) return linkAttempt(chatId, text); // ارسال دستی کد (مسیر جایگزین اگر لینک start_id کار نکرد)
    return reply(chatId, T.help);
  }

  async function handleUpdate(u) {
    if (!u || typeof u !== "object") return;
    const chatId = typeof u.chat_id === "string" ? u.chat_id : null; if (!chatId) return;
    if (u.type === "StoppedBot") return unlink(chatId, true); // کاربر ربات را متوقف کرد: دیگر نمی‌توانیم پیام بدهیم
    if (u.type === "StartedBot") { // UNVERIFIED: محل دقیق start_id در این نوع آپدیت در مستندات نیست؛ هر دو محل محتمل بررسی می‌شود
      const sid = [u.aux_data && u.aux_data.start_id, u.start_id].find((x) => typeof x === "string" && x);
      return sid ? linkAttempt(chatId, sid) : welcome(chatId);
    }
    if (u.type !== "NewMessage" || !u.new_message) return;
    const m = u.new_message;
    if (m.sender_type && String(m.sender_type).toLowerCase() !== "user") return; // پیام ربات‌ها/سیستم نادیده گرفته می‌شود
    if (m.is_edited) return;
    if (m.message_id && dup(`${chatId}:${m.message_id}`)) return;
    return onMessage(chatId, m);
  }
  return { handleUpdate };
}
