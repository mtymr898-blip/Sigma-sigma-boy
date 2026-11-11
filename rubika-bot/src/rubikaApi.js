// ===================================================================
// rubikaApi.js — کلاینت Rubika Bot API نسخه‌ی v3 (مستندات: https://rubika.ir/botapi/methods)
// آدرس: POST https://botapi.rubika.ir/v3/{token}/{method} با بدنه‌ی JSON
// متدهای استفاده‌شده: getMe، sendMessage، getUpdates (offset_id / next_offset_id)، getChat، setCommands
//
// • خطاها هرگز آدرس درخواست (که توکن در آن است) را در پیام خود ندارند.
// • قالب پاسخ: {"status":"OK","data":{...}}؛ خطا مثل {"status":"INVALID_INPUT","dev_message":"..."}.
//   UNVERIFIED: نام دقیق سایر statusها (مثلاً TOO_REQUEST / INVALID_ACCESS) در مستندات صفحه‌ی متدها نیامده؛
//   هر status غیر از OK خطا حساب می‌شود و طبقه‌بندی (classifySendError) محافظه‌کارانه است.
// ===================================================================
export class RubikaApiError extends Error {
  constructor(message, { kind, status = null, httpStatus = null, devMessage = null } = {}) {
    super(message); this.name = "RubikaApiError"; this.kind = kind; this.status = status; this.httpStatus = httpStatus; this.devMessage = devMessage;
  }
}

export function createRubikaApi({ token, baseUrl = "https://botapi.rubika.ir/v3", fetchFn = (...a) => fetch(...a), timeoutMs = 15000 }) {
  async function call(method, body = {}) {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchFn(`${baseUrl}/${token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal });
    } catch (e) {
      throw new RubikaApiError(e && e.name === "AbortError" ? `${method}: timeout` : `${method}: network error`, { kind: e && e.name === "AbortError" ? "timeout" : "network" });
    } finally { clearTimeout(timer); }
    let j = null; try { j = await res.json(); } catch (_) { /* غیر JSON */ }
    if (j && typeof j.status === "string" && j.status !== "OK")
      throw new RubikaApiError(`${method}: ${j.status}`, { kind: "api", status: j.status, httpStatus: res.status, devMessage: typeof j.dev_message === "string" ? j.dev_message : null });
    if (!res.ok) throw new RubikaApiError(`${method}: HTTP ${res.status}`, { kind: "http", httpStatus: res.status });
    if (!j) throw new RubikaApiError(`${method}: invalid response`, { kind: "http", httpStatus: res.status });
    return j.data !== undefined ? j.data : j;
  }
  return {
    getMe: async () => { const d = await call("getMe"); return d.bot || d; },
    sendMessage: (chatId, text) => call("sendMessage", { chat_id: chatId, text }),
    getUpdates: (offsetId, limit = 100) => call("getUpdates", { ...(offsetId ? { offset_id: offsetId } : {}), limit }),
    getChat: async (chatId) => { const d = await call("getChat", { chat_id: chatId }); return d.chat || d; },
    setCommands: (botCommands) => call("setCommands", { bot_commands: botCommands }),
  };
}

// طبقه‌بندی خطای ارسال برای تصمیم retry و گزارش به سایت
//  retryable: خطای گذرا (شبکه، ۵xx، محدودیت نرخ)   permanent: مشکل از خود چت (مثلاً chat_id نامعتبر)
// INVALID_INPUT فقط وقتی «مشکل چت» حساب می‌شود که API/توکن سالم باشد (getMe اخیراً موفق بوده)، وگرنه ممکن است خطای
// پیکربندی (مثل نسخه‌ی اشتباه API) باشد و نباید اتصال کاربران را خراب کند.
export function classifySendError(err, { apiHealthy = false } = {}) {
  if (!(err instanceof RubikaApiError)) return { code: "INTERNAL", retryable: false, permanent: false };
  if (err.kind === "network" || err.kind === "timeout") return { code: "NETWORK", retryable: true, permanent: false };
  if (err.httpStatus === 429 || /TOO_REQUEST/i.test(err.status || "")) return { code: "RATE_LIMITED", retryable: true, permanent: false };
  if (err.httpStatus >= 500) return { code: "UPSTREAM", retryable: true, permanent: false };
  if (/INVALID_ACCESS/i.test(err.status || "")) return { code: "BOT_AUTH", retryable: false, permanent: false };
  if (/INVALID_INPUT/i.test(err.status || "")) return { code: "CHAT_REJECTED", retryable: false, permanent: !!apiHealthy };
  return { code: "API_ERROR", retryable: false, permanent: false };
}
