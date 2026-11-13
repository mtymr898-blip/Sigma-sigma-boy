// تست مرورگر «همه‌ی ارزها»: بازار، جست‌وجو، نمودارهای کوچک تنبل، انتخاب بازار در خرید/فروش، داشبورد
// اجرا: PLAYWRIGHT_MODULE=... CHROME_PATH=... node tests/e2e/markets-ui.mjs   (نیاز: playwright)
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SHOTS = process.env.SHOTS_DIR || "/tmp/shots"; fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = await new Promise((r) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mu-")); let out = "";
const proc = spawn("node", ["--import", path.join(ROOT, "tests/e2e/_wallex-stub.mjs"), "server.js"], { cwd: ROOT, env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATA_FILE: path.join(tmp, "s.json"), SESSION_SECRET: "S".repeat(48), VAULT_SECRET: "V".repeat(48), REGISTRATION_MODE: "open", SMS_PROVIDER: "console", PBKDF2_ITER: "2000", UPSTREAM_GAP_MS: "0", ENGINE_TICK_SEC: "3600" } });
proc.stdout.on("data", (d) => (out += d)); proc.stderr.on("data", (d) => (out += d));
const SITE = `http://127.0.0.1:${port}`; let failures = 0; const ok = (m) => console.log("  ✓", m);
const api = async (p, { method = "GET", body, token } = {}) => { const r = await fetch(SITE + p, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json().catch(() => null); return { status: r.status, j, d: j && j.data !== undefined ? j.data : j }; };
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ["--no-sandbox"] });
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(SITE + "/healthz")).ok) break; } catch {} await sleep(150); }
  const phone = "09140000002"; await api("/api/auth/otp/send", { method: "POST", body: { phone } }); await sleep(300);
  const code = [...out.matchAll(new RegExp(`\\[OTP\\] ${phone} → (\\d+)`, "g"))].pop()[1];
  const v = await api("/api/auth/otp/verify", { method: "POST", body: { phone, code } });
  const session = (await api("/api/auth/register", { method: "POST", body: { phone, otpToken: v.d.otpToken, password: "Zx9!kLm-Qw2e" } })).d;
  assert.equal((await api("/api/connect", { method: "POST", token: session.token, body: { apiKey: "test-key-12345678" } })).status, 200);
  const market = (await api("/api/market", { token: session.token })).d; const top30 = new Set([...market].sort((a, b) => (b.volume24h || 0) - (a.volume24h || 0)).slice(0, 30).map((c) => c.id));

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "fa-IR" }); const page = await ctx.newPage();
  page.on("pageerror", (e) => { failures++; console.error("PAGE ERROR:", e.message); });
  const sparkReqs = []; page.on("request", (r) => { if (r.url().includes("/api/sparklines")) sparkReqs.push(decodeURIComponent(new URL(r.url()).searchParams.get("ids")).split(",")); });
  await page.goto(SITE); await page.waitForFunction(() => typeof Api !== "undefined" && typeof Router !== "undefined");
  await page.evaluate(async (s) => { Api.setSession(s); State.set({ account: { loggedIn: true, phone: s.phone } }); await Api.checkConnection(); Router.go("market"); }, session);
  await page.waitForSelector(".q-list canvas, .q-list .q-row, .q-list [class*=row]", { timeout: 15000 });
  const rowIds = () => page.$$eval("canvas[data-key^='row_']", (cs) => cs.map((c) => c.dataset.key.slice(4)));

  console.log("▶ صفحه‌ی بازار");
  await sleep(1200); let ids = await rowIds(); assert.equal(ids.length, 8, "فقط ۸ ردیف اول دیده می‌شود"); ok("۸ ردیف اول نمایش داده شد (از ۶۱ ارز)");
  assert.ok(sparkReqs.length >= 1 && sparkReqs[0].length <= 8 && sparkReqs[0].every((i) => ids.includes(i))); ok("نمودار کوچک فقط برای ردیف‌های دیده‌شده درخواست شد: " + sparkReqs[0].length + " ارز");
  const before = sparkReqs.length; await page.getByRole("button", { name: /نمایش موارد بیشتر/ }).click(); await sleep(1200);
  ids = await rowIds(); assert.equal(ids.length, 16); assert.ok(sparkReqs.length > before && sparkReqs.slice(before).flat().every((i) => !sparkReqs[0].includes(i))); ok("«نمایش موارد بیشتر» ← ۸ ردیف بعدی و فقط نمودار همان‌ها");
  await page.screenshot({ path: `${SHOTS}/M1-market-mobile.png` });
  await page.fill(".q-search input", "ltc"); await sleep(700); ids = await rowIds(); assert.deepEqual(ids, ["ltc"]); ok("جست‌وجوی «ltc» ← لایت‌کوین");
  await page.fill(".q-search input", "لایت"); await sleep(700); assert.deepEqual(await rowIds(), ["ltc"]); ok("جست‌وجوی فارسی هم کار می‌کند");
  await page.fill(".q-search input", "tkn1"); await sleep(700); assert.ok((await rowIds()).length >= 5); ok("جست‌وجوی ارز بدون نام فارسی با نماد");
  await page.fill(".q-search input", "zzzz"); await sleep(700); assert.equal((await rowIds()).length, 0); assert.ok(await page.getByText("نتیجه‌ای یافت نشد").count()); ok("جست‌وجوی بی‌نتیجه پیام می‌دهد");

  console.log("▶ داشبورد");
  await page.evaluate(() => Router.go("dashboard")); await sleep(1800); const dash = await rowIds();
  assert.ok(dash.length > 0 && dash.length <= 5 && dash.every((i) => top30.has(i))); ok("بیشترین تغییر فقط بین ۳۰ ارز پرحجم: " + dash.join(", "));

  console.log("▶ خرید و فروش");
  await page.evaluate(() => Router.go("trade/btc")); await page.waitForSelector(".dropdown-trigger", { timeout: 10000 });
  await page.locator(".dropdown-trigger").first().click(); await page.waitForSelector(".dropdown-sheet");
  const nOpts = await page.locator(".dropdown-sheet .dropdown-option").count(); assert.equal(nOpts, 61); ok("انتخاب بازار: ۶۱ گزینه");
  await sleep(700); await page.screenshot({ path: `${SHOTS}/M2-trade-dropdown-mobile.png` });
  await page.fill(".dropdown-sheet input[type=search]", "لایت"); await sleep(400); assert.equal(await page.locator(".dropdown-sheet .dropdown-option").count(), 1); ok("جست‌وجو در انتخاب بازار");
  const obReq = page.waitForRequest((r) => r.url().includes("/api/orderbook/ltc"), { timeout: 8000 });
  await page.locator(".dropdown-sheet .dropdown-option").first().click(); await obReq; ok("با انتخاب LTC دفتر سفارش همان ارز گرفته شد");
  assert.match(await page.locator(".dropdown-trigger").first().innerText(), /LTC/); ok("برچسب انتخاب به‌روز شد");
  await page.screenshot({ path: `${SHOTS}/M3-trade-ltc-mobile.png` });
  await ctx.close();
  console.log("\n✅ همه‌ی سناریوهای مرورگر موفق بود");
} catch (e) { failures++; console.error("\n❌ شکست:", e && e.stack || e); console.error(out.slice(-1200)); }
finally { await browser.close(); proc.kill("SIGTERM"); await sleep(200); process.exit(failures ? 1 : 0); }
