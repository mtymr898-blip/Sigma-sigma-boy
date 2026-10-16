// ===================================================================
// src/vault.js — رمزنگاری کلید API والکس هنگام ذخیره روی دیسک سرور
// -------------------------------------------------------------------
// AES-256-GCM با کلیدی که از VAULT_SECRET (یا SESSION_SECRET) مشتق می‌شود.
// اگر آن Secret عوض شود، کلید ذخیره‌شده خوانا نیست و کاربر باید دوباره آن را وارد کند.
// فقط WebCrypto استفاده شده؛ روی Node و Cloudflare Workers یکسان کار می‌کند.
// ===================================================================
const enc = new TextEncoder(), dec = new TextDecoder();

export function toB64u(bytes) {
  let s = ""; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function fromB64u(str) {
  const s = String(str).replace(/-/g, "+").replace(/_/g, "/"); const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out;
}
async function aesKey(secret) {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(`wallex-key-vault-v1:${secret}`));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function seal(secret, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secret), enc.encode(plaintext)));
  return { v: 1, iv: toB64u(iv), ct: toB64u(ct) };
}
export async function open(secret, rec) {
  if (!rec || rec.v !== 1) throw new Error("bad_vault_record");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64u(rec.iv) }, await aesKey(secret), fromB64u(rec.ct));
  return dec.decode(pt);
}
