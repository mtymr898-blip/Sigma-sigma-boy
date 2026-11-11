// ذخیره‌ی پایدار offset_id (نوشتن اتمیک) تا بعد از restart پیام‌ها دوباره پردازش نشوند
import fs from "node:fs";
import path from "node:path";

export function createState(dir) {
  const file = path.join(dir, "offset.json");
  let offsetId = null;
  try { const j = JSON.parse(fs.readFileSync(file, "utf8")); if (j && typeof j.offset_id === "string" && j.offset_id) offsetId = j.offset_id; } catch (_) { /* اولین اجرا یا فایل خراب: از ابتدا */ }
  return {
    get offsetId() { return offsetId; },
    save(next) {
      if (typeof next !== "string" || !next || next === offsetId) return;
      offsetId = next; fs.mkdirSync(dir, { recursive: true });
      const tmp = file + ".tmp"; fs.writeFileSync(tmp, JSON.stringify({ offset_id: offsetId, savedAt: new Date().toISOString() }), { mode: 0o600 }); fs.renameSync(tmp, file);
    },
  };
}
