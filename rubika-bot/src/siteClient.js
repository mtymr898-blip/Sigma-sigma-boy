// کلاینت endpointهای داخلی سایت (فقط روی همین سرور، با راز مشترک)
export function createSiteClient({ baseUrl, secret, fetchFn = (...a) => fetch(...a), timeoutMs = 8000 }) {
  async function post(path, body) {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchFn(baseUrl + path, { method: "POST", signal: ctl.signal, headers: { "Content-Type": "application/json", Authorization: "Bearer " + secret }, body: JSON.stringify(body) });
    } catch (_) { return { ok: false, code: "SITE_UNREACHABLE", status: 0 }; }
    finally { clearTimeout(timer); }
    let j = null; try { j = await res.json(); } catch (_) { /* غیر JSON */ }
    if (res.ok && j && j.ok === true) return { ok: true, data: j.data };
    return { ok: false, code: (j && j.error && j.error.code) || `HTTP_${res.status}`, status: res.status };
  }
  return {
    consume: (code, chatId) => post("/api/internal/rubika/consume", { code, chatId }),
    verifyChat: (chatId) => post("/api/internal/rubika/verify-chat", { chatId }),
    chatStopped: (chatId) => post("/api/internal/rubika/chat-stopped", { chatId }),
  };
}
