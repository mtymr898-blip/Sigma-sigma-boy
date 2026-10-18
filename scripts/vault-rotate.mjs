#!/usr/bin/env node
// ===================================================================
// scripts/vault-rotate.mjs — انتقال امن کلیدهای والکس به VAULT_SECRET فعلی
// -------------------------------------------------------------------
// پیش‌فرض: فقط گزارش (dry-run)؛ هیچ چیزی نوشته نمی‌شود.
//   node scripts/vault-rotate.mjs                       ← گزارش وضعیت رکوردها
//   node scripts/vault-rotate.mjs --apply --backup=data/store.backup-YYYYMMDD.json
// پیش‌نیازها برای --apply:
//   ۱) سرور متوقف باشد (سرور ذخیره‌سازی را در حافظه نگه می‌دارد و فایل را بازنویسی می‌کند).
//   ۲) مسیر پشتیبان داده شود و وجود نداشته باشد؛ اسکریپت اول پشتیبان می‌گیرد و درستی آن را (بایت‌به‌بایت) می‌سنجد.
//   ۳) رازها فقط از متغیرهای محیطی خوانده می‌شوند (هرگز از آرگومان و هرگز چاپ نمی‌شوند):
//      VAULT_SECRET (جدید)، VAULT_SECRET_PREVIOUS (قبلی)، SESSION_SECRET (رکوردهای قدیمی).
// هر رکورد بعد از بازرمزنگاری دوباره باز می‌شود و باید همان کلید را بدهد؛ رکورد ناخوانا هرگز دست‌کاری/حذف نمی‌شود.
// بازیابی: سرور را متوقف کنید و فایل پشتیبان را جایگزین DATA_FILE کنید.
// ===================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seal, open, deriveUserSecret, vaultAadFor, vaultSecretsFor, isStrongSecret } from "../src/vault.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v === undefined ? true : v]; }));
const file = process.env.DATA_FILE || path.join(__dirname, "..", "data", "store.json");
const REC = /^kv:u:([A-Za-z0-9_-]{16,40}):secret:wallex$/;

export async function rotate({ env, file, apply = false, backup = null, log = console.log }) {
  if (!isStrongSecret(env.VAULT_SECRET)) throw new Error("VAULT_SECRET (حداقل ۳۲ کاراکتر) باید تنظیم باشد.");
  const entries = JSON.parse(fs.readFileSync(file, "utf8")); const map = new Map(entries);
  const cands = vaultSecretsFor(env); const rep = { total: 0, current: 0, previous: 0, legacy: 0, unreadable: 0, resealed: 0 }; const todo = [];
  for (const [k, rec] of map) {
    const m = REC.exec(k); if (!m || !rec || !rec.sealed) continue; rep.total++;
    let used = null, plain = null;
    for (const c of cands) { try { plain = await open(await deriveUserSecret(c.secret, m[1]), rec.sealed, vaultAadFor(m[1])); used = c.id; break; } catch (_) {} }
    if (!used) { rep.unreadable++; continue; }
    rep[used]++; if (used !== "current") todo.push([k, m[1], rec, plain]);
  }
  log(`رکوردهای کلید: ${rep.total} | با راز فعلی: ${rep.current} | با راز قبلی: ${rep.previous} | با راز قدیمی (SESSION_SECRET): ${rep.legacy} | ناخوانا: ${rep.unreadable}`);
  if (!apply) { log(`حالت گزارش (dry-run): ${todo.length} رکورد قابل انتقال است. برای اجرا: --apply --backup=<مسیر>`); return rep; }
  if (!backup) throw new Error("--backup=<مسیر> الزامی است.");
  if (fs.existsSync(backup)) throw new Error("فایل پشتیبان از قبل وجود دارد؛ مسیر جدید بدهید (پشتیبان قبلی بازنویسی نمی‌شود).");
  fs.copyFileSync(file, backup); fs.chmodSync(backup, 0o600);
  if (!fs.readFileSync(backup).equals(fs.readFileSync(file))) throw new Error("پشتیبان با فایل اصلی یکسان نیست؛ عملیات متوقف شد.");
  log(`پشتیبان ساخته و تأیید شد: ${backup}`);
  for (const [k, uid, rec, plain] of todo) {
    const sealed = await seal(await deriveUserSecret(env.VAULT_SECRET, uid), plain, vaultAadFor(uid));
    if ((await open(await deriveUserSecret(env.VAULT_SECRET, uid), sealed, vaultAadFor(uid))) !== plain) throw new Error("تأیید پس از رمزنگاری ناموفق بود؛ فایل اصلی دست‌نخورده است.");
    map.set(k, { ...rec, sealed, rotatedAt: new Date().toISOString() }); rep.resealed++;
  }
  const tmp = file + ".tmp"; fs.writeFileSync(tmp, JSON.stringify([...map]), { mode: 0o600 }); fs.renameSync(tmp, file);
  log(`انتقال انجام شد: ${rep.resealed} رکورد. رکوردهای ناخوانا (${rep.unreadable}) دست‌نخورده ماندند.`);
  return rep;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  rotate({ env: process.env, file, apply: !!args.apply, backup: args.backup || null }).catch((e) => { console.error("خطا: " + e.message); process.exit(1); });
}
