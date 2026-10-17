// ===================================================================
// src/vault.js — رمزنگاری کلیدهای API کاربران (AES-256-GCM)
// -------------------------------------------------------------------
// • کلید AES از «راز سرور» با HKDF-SHA256 و salt تصادفی برای هر رکورد مشتق می‌شود.
// • worker.js برای هر کاربر یک راز مجزا می‌دهد و شناسه‌ی کاربر را به‌عنوان AAD می‌بندد؛
//   پس رکورد یک کاربر روی کاربر دیگر باز نمی‌شود، حتی اگر فایل ذخیره‌سازی دستکاری شود.
// • فرمت: v1.<salt>.<iv>.<ciphertext+tag>  (همه base64url)
// ===================================================================
const enc = new TextEncoder(), dec = new TextDecoder();

export function b64u(bytes) {
  let s = ""; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function fromB64u(str) {
  const s = String(str).replace(/-/g, "+").replace(/_/g, "/"); const pad = s + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(pad); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out;
}
async function deriveKey(secret, salt) {
  if (!secret || String(secret).length < 16) throw new Error("VAULT_SECRET_WEAK");
  const base = await crypto.subtle.importKey("raw", enc.encode(String(secret)), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: enc.encode("qairo-vault-v1") }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
export async function seal(secret, plaintext, aad = "") {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(secret, salt);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, key, enc.encode(String(plaintext))));
  return `v1.${b64u(salt)}.${b64u(iv)}.${b64u(ct)}`;
}
export async function open(secret, sealed, aad = "") {
  const p = String(sealed).split("."); if (p.length !== 4 || p[0] !== "v1") throw new Error("VAULT_FORMAT");
  const key = await deriveKey(secret, fromB64u(p[1]));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64u(p[2]), additionalData: enc.encode(aad) }, key, fromB64u(p[3]));
  return dec.decode(pt);
}
