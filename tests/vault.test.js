// تست رمزنگاری کلید و اسکریپت چرخش راز — فقط داده‌ی ساختگی و فایل‌های موقت؛ هیچ راز یا کلید واقعی‌ای وجود ندارد.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { seal, open, deriveUserSecret, vaultAadFor, vaultSecretsFor, isStrongSecret, MIN_SECRET_LEN } from "../src/vault.js";
import { rotate } from "../scripts/vault-rotate.mjs";

const UID1 = "AAAAAAAAAAAAAAAAAAAAAAAA", UID2 = "BBBBBBBBBBBBBBBBBBBBBBBB";
const S = { cur: "c".repeat(40), prev: "p".repeat(40), sess: "s".repeat(40) };

test("راز ضعیف رد می‌شود (حداقل ۳۲ کاراکتر)", async () => {
  assert.equal(MIN_SECRET_LEN, 32); assert.equal(isStrongSecret("x".repeat(31)), false); assert.equal(isStrongSecret("x".repeat(32)), true); assert.equal(isStrongSecret(undefined), false);
  await assert.rejects(seal("short", "k", "a")); await assert.rejects(deriveUserSecret("short", UID1));
});
test("seal/open: هر بار salt/iv متفاوت؛ AAD و راز اشتباه رد می‌شوند؛ دست‌کاری شناسایی می‌شود", async () => {
  const sec = await deriveUserSecret(S.cur, UID1), aad = vaultAadFor(UID1);
  const a = await seal(sec, "PLAIN-KEY", aad), b = await seal(sec, "PLAIN-KEY", aad); assert.notEqual(a, b); assert.ok(!a.includes("PLAIN-KEY"));
  assert.equal(await open(sec, a, aad), "PLAIN-KEY");
  await assert.rejects(open(sec, a, vaultAadFor(UID2))); await assert.rejects(open(await deriveUserSecret(S.cur, UID2), a, aad)); await assert.rejects(open(await deriveUserSecret(S.prev, UID1), a, aad));
  const p = a.split("."); p[3] = p[3].slice(0, -2) + (p[3].endsWith("AA") ? "BB" : "AA"); await assert.rejects(open(sec, p.join("."), aad), "ciphertext دست‌کاری‌شده");
  await assert.rejects(open(sec, "v2.x.y.z", aad));
});
test("ترتیب و فیلتر رازها: current → previous → legacy؛ رازهای ضعیف حذف می‌شوند", () => {
  assert.deepEqual(vaultSecretsFor({ VAULT_SECRET: S.cur, VAULT_SECRET_PREVIOUS: S.prev, SESSION_SECRET: S.sess }).map((x) => x.id), ["current", "previous", "legacy"]);
  assert.deepEqual(vaultSecretsFor({ VAULT_SECRET: "weak", SESSION_SECRET: S.sess }).map((x) => x.id), ["legacy"]);
  assert.deepEqual(vaultSecretsFor({}).map((x) => x.id), []);
  assert.deepEqual(vaultSecretsFor({ VAULT_SECRET: S.cur, VAULT_SECRET_PREVIOUS: S.cur, SESSION_SECRET: S.cur }).map((x) => x.id), ["current"], "راز تکراری یک‌بار شمرده می‌شود");
});

// ---------- اسکریپت چرخش راز ----------
async function makeStore(dir) {
  const rec = async (uid, secret, key) => ({ sealed: await seal(await deriveUserSecret(secret, uid), key, vaultAadFor(uid)), savedAt: "2026-10-01T00:00:00.000Z", hint: key.slice(-4) });
  const entries = [
    ["kv:u:" + UID1 + ":secret:wallex", await rec(UID1, S.prev, "KEY-ONE-0000000001")],   // با راز قبلی
    ["kv:u:" + UID2 + ":secret:wallex", await rec("CCCCCCCCCCCCCCCCCCCCCCCC", S.sess, "KEY-TWO-0000000002")], // با راز قدیمی، ولی AAD/uid نامطابق → ناخوانا
    ["kv:u:CCCCCCCCCCCCCCCCCCCCCCCC:secret:wallex", await rec("CCCCCCCCCCCCCCCCCCCCCCCC", S.sess, "KEY-THREE-000000003")], // legacy
    ["kv:u:DDDDDDDDDDDDDDDDDDDDDDDD:secret:wallex", await rec("DDDDDDDDDDDDDDDDDDDDDDDD", S.cur, "KEY-FOUR-0000000004")], // current
    ["kv:u:EEEEEEEEEEEEEEEEEEEEEEEE:secret:wallex", await rec("EEEEEEEEEEEEEEEEEEEEEEEE", "z".repeat(40), "KEY-FIVE-0000000005")], // ناشناخته → ناخوانا
    ["kv:u:" + UID1 + ":eng:trades", [{ id: "t" }]],
    ["kv:auth:user:09120000000", { pw: "x" }],
  ];
  const file = path.join(dir, "store.json"); fs.writeFileSync(file, JSON.stringify(entries), { mode: 0o600 }); return { file, entries };
}
const quiet = () => {}; const envOf = (extra = {}) => ({ VAULT_SECRET: S.cur, VAULT_SECRET_PREVIOUS: S.prev, SESSION_SECRET: S.sess, ...extra });

test("اسکریپت چرخش: پیش‌فرض dry-run است و هیچ فایلی را تغییر نمی‌دهد", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-")); const { file } = await makeStore(dir); const before = fs.readFileSync(file);
  const rep = await rotate({ env: envOf(), file, log: quiet });
  assert.deepEqual([rep.total, rep.current, rep.previous, rep.legacy, rep.unreadable, rep.resealed], [5, 1, 1, 1, 2, 0]);
  assert.ok(fs.readFileSync(file).equals(before), "dry-run نباید چیزی بنویسد"); assert.deepEqual(fs.readdirSync(dir), ["store.json"]);
});
test("اسکریپت چرخش: --apply بدون پشتیبان یا با پشتیبان موجود رد می‌شود و چیزی نمی‌نویسد", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-")); const { file } = await makeStore(dir); const before = fs.readFileSync(file);
  await assert.rejects(rotate({ env: envOf(), file, apply: true, log: quiet }), /backup/);
  fs.writeFileSync(path.join(dir, "b.json"), "x"); await assert.rejects(rotate({ env: envOf(), file, apply: true, backup: path.join(dir, "b.json"), log: quiet }), /پشتیبان/);
  await assert.rejects(rotate({ env: envOf({ VAULT_SECRET: "weak" }), file, log: quiet }), /VAULT_SECRET/);
  assert.ok(fs.readFileSync(file).equals(before)); assert.equal(fs.readFileSync(path.join(dir, "b.json"), "utf8"), "x", "پشتیبان قبلی بازنویسی نشود");
});
test("اسکریپت چرخش: با پشتیبان تأییدشده، رکوردهای previous/legacy منتقل می‌شوند؛ ناخوانا و سایر داده‌ها دست‌نخورده‌اند؛ بازیابی از پشتیبان ممکن است", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-")); const { file, entries } = await makeStore(dir); const original = fs.readFileSync(file); const backup = path.join(dir, "store.backup.json");
  const rep = await rotate({ env: envOf(), file, apply: true, backup, log: quiet });
  assert.equal(rep.resealed, 2); assert.ok(fs.readFileSync(backup).equals(original), "پشتیبان بایت‌به‌بایت برابر اصل");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
  const after = new Map(JSON.parse(fs.readFileSync(file, "utf8"))); const before = new Map(entries);
  const plain = { [UID1]: "KEY-ONE-0000000001", CCCCCCCCCCCCCCCCCCCCCCCC: "KEY-THREE-000000003", DDDDDDDDDDDDDDDDDDDDDDDD: "KEY-FOUR-0000000004" };
  for (const [uid, key] of Object.entries(plain)) { const r = after.get(`kv:u:${uid}:secret:wallex`); assert.equal(await open(await deriveUserSecret(S.cur, uid), r.sealed, vaultAadFor(uid)), key, "با راز فعلی باز می‌شود"); }
  for (const k of ["kv:u:" + UID2 + ":secret:wallex", "kv:u:EEEEEEEEEEEEEEEEEEEEEEEE:secret:wallex", "kv:u:" + UID1 + ":eng:trades", "kv:auth:user:09120000000", "kv:u:DDDDDDDDDDDDDDDDDDDDDDDD:secret:wallex"]) assert.deepEqual(after.get(k), before.get(k), "دست‌نخورده: " + k);
  const raw = fs.readFileSync(file, "utf8"); for (const k of Object.values(plain)) assert.ok(!raw.includes(k), "کلید خام در فایل نیست");
  // دوباره اجرا: چیزی برای انتقال نمی‌ماند (idempotent)
  const again = await rotate({ env: envOf(), file, log: quiet }); assert.equal(again.previous + again.legacy, 0);
  // بازیابی: جایگزینی فایل با پشتیبان وضعیت قبلی را برمی‌گرداند
  fs.copyFileSync(backup, file); assert.ok(fs.readFileSync(file).equals(original));
});

test("سازگاری با رکوردهای قبلی: اشتقاق راز کاربر دقیقاً HMAC-SHA256(راز، «wallex-key:»+uid) به‌صورت base64url است", async () => {
  const { createHmac } = await import("node:crypto");
  for (const [secret, uid] of [[S.cur, UID1], [S.sess, UID2]]) {
    const expected = createHmac("sha256", secret).update("wallex-key:" + uid).digest("base64url");
    assert.equal(await deriveUserSecret(secret, uid), expected);
  }
});
