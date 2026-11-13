// تست «همه‌ی ارزها»: سرور واقعی + والکس جعلی (tests/e2e/_wallex-stub.mjs). اجرا: node tests/e2e/markets-all.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = await new Promise((r) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mk-")); let out = "";
const proc = spawn("node", ["--import", path.join(ROOT, "tests/e2e/_wallex-stub.mjs"), "server.js"], { cwd: ROOT, env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATA_FILE: path.join(tmp, "s.json"), SESSION_SECRET: "S".repeat(48), VAULT_SECRET: "V".repeat(48), REGISTRATION_MODE: "open", SMS_PROVIDER: "console", PBKDF2_ITER: "2000", UPSTREAM_GAP_MS: "0", ENGINE_TICK_SEC: "3600", TRADING_ENABLED: "false" } });
proc.stdout.on("data", (d) => (out += d)); proc.stderr.on("data", (d) => (out += d));
const SITE = `http://127.0.0.1:${port}`; let failures = 0; const ok = (m) => console.log("  ✓", m);
const api = async (p, { method = "GET", body, token } = {}) => { const r = await fetch(SITE + p, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json().catch(() => null); return { status: r.status, j, d: j && j.data !== undefined ? j.data : j }; };
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(SITE + "/healthz")).ok) break; } catch {} await sleep(150); }
  const phone = "09140000001"; await api("/api/auth/otp/send", { method: "POST", body: { phone } }); await sleep(300);
  const code = [...out.matchAll(new RegExp(`\\[OTP\\] ${phone} → (\\d+)`, "g"))].pop()[1];
  const v = await api("/api/auth/otp/verify", { method: "POST", body: { phone, code } });
  const token = (await api("/api/auth/register", { method: "POST", body: { phone, otpToken: v.d.otpToken, password: "Zx9!kLm-Qw2e" } })).d.token; assert.ok(token);

  console.log("▶ بازار");
  const m = await api("/api/market", { token }); assert.equal(m.status, 200);
  const ids = m.d.map((c) => c.id); const total = 9 + 10 + 40 + 2;
  assert.equal(ids.length, total); ok(`همه‌ی ${ids.length} جفت‌ارز تومانی آمد (قبلاً فقط ۱۰ ارز منتخب)`);
  assert.deepEqual(ids.slice(0, 9), ["btc", "eth", "usdt", "bnb", "sol", "xrp", "doge", "ada", "trx"]); ok("ارزهای منتخب اول و با ترتیب ثابت‌اند");
  assert.ok(!ids.includes("ton")); assert.deepEqual(m.j.meta.missing, ["ton"]); assert.equal(m.j.meta.total, total); ok("ارز منتخبِ غایب در missing گزارش شد");
  assert.ok(!ids.includes("btcusdt") && !ids.some((i) => /weird|-/.test(i))); ok("جفت‌های غیرتومانی/نماد نامعتبر وارد فهرست نشدند");
  const ltc = m.d.find((c) => c.id === "ltc"); assert.equal(ltc.name, "لایت‌کوین"); assert.equal(ltc.symbol, "LTC/IRT");
  assert.equal(m.d.find((c) => c.id === "tkn3").name, "TKN3"); assert.equal(m.d.find((c) => c.id === "1inch").symbol, "1INCH/IRT"); ok("نام فارسی برای معروف‌ها و نماد انگلیسی برای بقیه");
  const extraVols = m.d.slice(9).map((c) => c.volume24h); assert.deepEqual(extraVols, [...extraVols].sort((a, b) => b - a)); ok("بقیه‌ی ارزها بر اساس حجم مرتب‌اند");

  console.log("▶ نمودار/دفتر سفارش/نمودار کوچک");
  assert.equal((await api("/api/orderbook/tkn7", { token })).status, 200); ok("دفتر سفارش ارز غیرمنتخب");
  assert.equal((await api("/api/orderbook/nonexist", { token })).status, 404); ok("ارز ناموجود ← ۴۰۴");
  const h = await api("/api/history/pepe?range=7d", { token }); assert.equal(h.status, 200); assert.ok(h.d.length > 10); assert.equal((await api("/api/history/nonexist?range=7d", { token })).status, 404); ok("تاریخچه‌ی قیمت");
  const sp = await api("/api/sparklines?ids=ltc,nonexist,tkn1,dot", { token }); assert.deepEqual(Object.keys(sp.d).sort(), ["dot", "ltc", "tkn1"]); ok("نمودار کوچک فقط برای ارزهای معتبر");

  console.log("▶ ثبت سفارش (پیش‌نمایش)");
  const cfg = await api("/api/trade/config", { token }); assert.equal(cfg.d.markets.length, total); assert.equal(cfg.d.markets[0].id, "btc"); ok("فهرست بازارهای صفحه‌ی خرید و فروش = همه‌ی ارزها");
  const pv = await api("/api/trade/preview", { method: "POST", token, body: { order: { coinId: "ltc", side: "buy", execution: "limit", amount: "5", price: "1100" } } });
  assert.equal(pv.status, 200, JSON.stringify(pv.j)); assert.equal(pv.d.summary.market, "LTC/IRT"); ok("پیش‌نمایش سفارش برای ارز غیرمنتخب (LTC)");
  const bad = await api("/api/trade/preview", { method: "POST", token, body: { order: { coinId: "nonexist", side: "buy", execution: "limit", amount: "1", price: "1" } } }); assert.equal(bad.status, 400); assert.equal(bad.j.error.code, "INVALID_ORDER"); ok("ارز ناموجود رد شد");
  const inj = await api("/api/trade/preview", { method: "POST", token, body: { order: { coinId: "ltc/../x", side: "buy", execution: "limit", amount: "1", price: "1" } } }); assert.equal(inj.status, 400); ok("شناسه‌ی مشکوک رد شد");
  const sub = await api("/api/trade/submit", { method: "POST", token, body: { order: { coinId: "ltc", side: "buy", execution: "limit", amount: "5", price: "1100" }, clientOrderId: "dabcdefgh1234", confirmToken: "1.x" } }); assert.equal(sub.status, 403); ok("با TRADING_ENABLED=false ارسال واقعی همچنان قفل است");

  console.log("▶ معامله‌ی خودکار/تحلیل AI محدود به ارزهای منتخب می‌ماند");
  const st = await api("/api/trading/settings", { token }); assert.equal(st.status, 200, JSON.stringify(st.j)); const allowed = st.d.allowedCoins;
  assert.ok(allowed.includes("btc") && !allowed.includes("ltc") && !allowed.includes("tkn1") && !allowed.includes("usdt")); ok("allowedCoins = منتخب‌ها (" + allowed.length + " ارز)");
  console.log("\n✅ همه‌ی بررسی‌ها موفق بود");
} catch (e) { failures++; console.error("\n❌ شکست:", e && e.stack || e); console.error(out.slice(-1500)); }
finally { proc.kill("SIGTERM"); await sleep(200); process.exit(failures ? 1 : 0); }
