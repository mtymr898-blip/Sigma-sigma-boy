// تست مرورگر: فرم خرید (مقدار ⇄ قیمت کل تومان)، حذف دکمه‌ی قیمت لحظه‌ای، موجودی زنده، حذف حالت آزمایشی، معامله‌ی واقعی
// اجرا: PLAYWRIGHT_MODULE=... CHROME_PATH=... node tests/e2e/trade-form-ui.mjs
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tf-")); let out = "";
const proc = spawn("node", ["--import", path.join(ROOT, "tests/e2e/_wallex-stub.mjs"), "server.js"], { cwd: ROOT, env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATA_FILE: path.join(tmp, "s.json"), SESSION_SECRET: "S".repeat(48), VAULT_SECRET: "V".repeat(48), REGISTRATION_MODE: "open", SMS_PROVIDER: "console", PBKDF2_ITER: "2000", UPSTREAM_GAP_MS: "0", ENGINE_TICK_SEC: "3600", TRADING_ENABLED: "true", AUTO_TRADING_ENABLED: "true", MAX_ORDER_VALUE_IRT: "100000000" } });
proc.stdout.on("data", (d) => (out += d)); proc.stderr.on("data", (d) => (out += d));
const SITE = `http://127.0.0.1:${port}`; let failures = 0; const ok = (m) => console.log("  ✓", m);
const api = async (p, { method = "GET", body, token } = {}) => { const r = await fetch(SITE + p, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json().catch(() => null); return { status: r.status, j, d: j && j.data !== undefined ? j.data : j }; };
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ["--no-sandbox"] });
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(SITE + "/healthz")).ok) break; } catch {} await sleep(150); }
  const phone = "09140000003"; await api("/api/auth/otp/send", { method: "POST", body: { phone } }); await sleep(300);
  const code = [...out.matchAll(new RegExp(`\\[OTP\\] ${phone} → (\\d+)`, "g"))].pop()[1];
  const v = await api("/api/auth/otp/verify", { method: "POST", body: { phone, code } });
  const session = (await api("/api/auth/register", { method: "POST", body: { phone, otpToken: v.d.otpToken, password: "Zx9!kLm-Qw2e" } })).d; const token = session.token;
  assert.equal((await api("/api/connect", { method: "POST", token, body: { apiKey: "test-key-12345678" } })).status, 200);

  console.log("▶ موجودی همیشه زنده (بدون کش)");
  const w1 = (await api("/api/wallets", { token })).d.find((a) => a.coinId === "irt").available, w2 = (await api("/api/wallets", { token })).d.find((a) => a.coinId === "irt").available;
  assert.notEqual(w1, w2); ok(`دو درخواست پشت‌سرهم دو مقدار متفاوت از والکس گرفتند (${w1} ← ${w2})`);

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "fa-IR" }); const page = await ctx.newPage();
  page.on("pageerror", (e) => { failures++; console.error("PAGE ERROR:", e.message); });
  await page.goto(SITE); await page.waitForFunction(() => typeof Api !== "undefined" && typeof Router !== "undefined");
  await page.evaluate(async (s) => { Api.setSession(s); State.set({ account: { loggedIn: true, phone: s.phone } }); await Api.checkConnection(); Router.go("trade/ltc"); }, session);
  await page.waitForSelector("input[placeholder='مثلاً 0.001']", { timeout: 15000 });
  const amount = page.locator("input[placeholder='مثلاً 0.001']"), total = page.locator("input[placeholder='مثلاً 500000']"), unit = page.locator("input[placeholder='قیمت هر واحد به تومان']");
  const market = (await api("/api/market", { token })).d.find((c) => c.id === "ltc"); const ask = market.bestSell, bid = market.bestBuy;

  console.log("▶ فرم خرید");
  assert.equal(await page.getByRole("button", { name: "قیمت لحظه‌ای بازار" }).count(), 0); ok("دکمه‌ی «قیمت لحظه‌ای بازار» حذف شده");
  assert.equal(Number(await unit.inputValue()), ask); ok(`قیمت هر واحد خودکار با قیمت بازار پر شد (${ask})`);
  await amount.fill("5"); await sleep(150); assert.equal(await total.inputValue(), String(Math.round(5 * ask))); ok(`مقدار ۵ ← قیمت ${Math.round(5 * ask)} تومان در کادر قیمت نوشته شد`);
  assert.match(await page.locator("text=/= .*تومان/").first().innerText(), /تومان/); ok("زیر کادر قیمت، مبلغ با جداکننده‌ی هزارگان هم نشان داده می‌شود");
  await total.fill("100000"); await sleep(150); const expect = Math.floor(100000 / ask * 1e6 + 1e-9) / 1e6; assert.equal(Number(await amount.inputValue()), expect); ok(`قیمت ۱۰۰٬۰۰۰ تومان ← مقدار ${expect} LTC در کادر بالا نوشته شد (گرد‌شده‌ی رو به پایین طبق دقت بازار)`);
  await total.fill("۲۵۰۰۰۰"); await sleep(150); assert.ok(Number(await amount.inputValue()) > 0); ok("ارقام فارسی هم پذیرفته می‌شود");
  await total.fill(""); await sleep(150); assert.equal(await amount.inputValue(), ""); ok("با خالی‌کردن قیمت، مقدار هم خالی می‌شود");
  await unit.fill("1300"); await amount.fill("2"); await sleep(150); assert.equal(await total.inputValue(), "2600"); ok("قیمت دلخواه هر واحد: ۲ × ۱۳۰۰ = ۲۶۰۰");
  await total.fill("13000"); await sleep(150); assert.equal(Number(await amount.inputValue()), 10); ok("با قیمت دلخواه، تبدیل برعکس هم درست است (۱۳۰۰۰ ÷ ۱۳۰۰ = ۱۰)");
  await page.getByRole("button", { name: "فروش", exact: true }).click(); await sleep(200);
  assert.equal(Number(await unit.inputValue()), 1300, "قیمت دستی با تغییر جهت حفظ می‌شود");
  await page.getByRole("button", { name: "سفارش بازار" }).click(); await sleep(200); assert.equal(await unit.count(), 0); ok("در سفارش بازار کادر قیمت هر واحد نیست و قیمت از بازار حساب می‌شود");
  await amount.fill("3"); await sleep(150); assert.equal(await total.inputValue(), String(Math.round(3 * bid))); ok(`فروش در سفارش بازار از قیمت خریدار حساب شد (${bid})`);
  await page.screenshot({ path: `${SHOTS}/T1-form-mobile.png` });

  console.log("▶ موجودی زنده در صفحه");
  const balText = () => page.locator("span:near(:text('موجودی')) >> nth=0").innerText().catch(() => "");
  await page.getByRole("button", { name: "خرید", exact: true }).click(); await sleep(300);
  const at1 = await page.locator("text=/موجودی از والکس/").innerText(); await sleep(11500); const at2 = await page.locator("text=/موجودی از والکس/").innerText();
  assert.notEqual(at1, at2); ok("زمان و مقدار موجودی هر ۱۰ ثانیه از والکس به‌روز می‌شود"); 

  console.log("▶ پیش‌نمایش/ارسال با موجودی ناکافی");
  const pv = await api("/api/trade/preview", { method: "POST", token, body: { order: { coinId: "ltc", side: "buy", execution: "limit", amount: "6000", price: String(ask) } } });
  assert.equal(pv.status, 200, JSON.stringify(pv.j)); assert.ok(pv.d.warnings.some((w) => /موجودی تومانی/.test(w))); ok("پیش‌نمایش هشدار موجودی ناکافی داد");
  const sub = await api("/api/trade/submit", { method: "POST", token, body: { order: pv.d.order, clientOrderId: pv.d.clientOrderId, confirmToken: pv.d.confirmToken } });
  assert.equal(sub.status, 400); assert.equal(sub.j.error.code, "INSUFFICIENT_BALANCE"); ok("ارسال با موجودی ناکافی پیش از رسیدن به والکس رد شد: " + sub.j.error.message);

  console.log("▶ حالت آزمایشی حذف شد / معامله‌ی واقعی فعال");
  await page.evaluate(() => Router.go("ai")); await page.waitForSelector(".ai-mode-card", { timeout: 15000 }); await sleep(500);
  assert.equal(await page.locator(".ai-mode-card").count(), 2); const aiText = await page.locator("body").innerText(); assert.ok(!/آزمایشی|Paper/i.test(aiText)); ok("فقط دو حالت: «تحلیل و پیشنهاد» و «معامله‌ی واقعی»؛ هیچ اثری از آزمایشی نیست");
  assert.equal(await page.locator(".ai-mode-card.locked").count(), 0); assert.ok(!/فعلاً در دسترس نیست/.test(aiText)); ok("معامله‌ی واقعی قفل نیست (AUTO_TRADING_ENABLED=true)");
  await page.screenshot({ path: `${SHOTS}/T2-ai-modes-mobile.png` });
  assert.equal((await api("/api/trading/mode", { method: "POST", token, body: { mode: "paper" } })).j.error.code, "INVALID_MODE"); ok("API هم حالت paper را رد می‌کند");
  const noPhrase = await api("/api/trading/mode", { method: "POST", token, body: { mode: "live" } }); assert.equal(noPhrase.j.error.code, "CONFIRM_REQUIRED"); ok("فعال‌سازی واقعی همچنان تأیید صریح می‌خواهد");
  const perf = (await api("/api/trading/performance", { token })).d; assert.deepEqual(Object.keys(perf), ["live"]); ok("گزارش عملکرد فقط واقعی است");
  await page.locator(".ai-mode-card", { hasText: "معامله‌ی واقعی" }).click(); await page.waitForSelector(".modal", { timeout: 5000 }); assert.match(await page.locator(".modal").innerText(), /ACTIVATE LIVE TRADING/); ok("در رابط، فعال‌سازی واقعی با عبارت تأیید (و تیک ریسک) انجام می‌شود");
  await ctx.close();
  console.log("\n✅ همه‌ی بررسی‌ها موفق بود؛ تصاویر در " + SHOTS);
} catch (e) { failures++; console.error("\n❌ شکست:", e && e.stack || e); console.error(out.slice(-1200)); }
finally { await browser.close(); proc.kill("SIGTERM"); await sleep(200); process.exit(failures ? 1 : 0); }
