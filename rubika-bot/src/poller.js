// حلقه‌ی polling روی getUpdates با مدیریت offset_id و backoff
export function createPoller({ api, handlers, state, log, intervalMs = 3000, limit = 100, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let stopped = false; let lastPollAt = 0; let loop = null;
  async function pollOnce() {
    const data = await api.getUpdates(state.offsetId, limit);
    const updates = Array.isArray(data && data.updates) ? data.updates : [];
    for (const u of updates) { try { await handlers.handleUpdate(u); } catch (e) { log.error("update handler failed", { err: e }); } } // خطای یک پیام بقیه را متوقف نمی‌کند
    if (data && typeof data.next_offset_id === "string" && data.next_offset_id) state.save(data.next_offset_id); // بعد از پردازش دسته ذخیره می‌شود
    lastPollAt = Date.now();
    return updates.length;
  }
  async function run() {
    let backoff = 0;
    while (!stopped) {
      try { const n = await pollOnce(); backoff = 0; await sleep(n >= limit ? 0 : intervalMs); }
      catch (e) {
        backoff = Math.min(backoff ? backoff * 2 : 2000, 60000);
        log.warn("getUpdates failed", { kind: e && e.kind, status: e && e.status, retryInMs: backoff });
        await sleep(backoff);
      }
    }
  }
  return { pollOnce, start() { stopped = false; loop = run(); return loop; }, async stop() { stopped = true; if (loop) await Promise.race([loop, sleep(1500)]); }, get lastPollAt() { return lastPollAt; } };
}
