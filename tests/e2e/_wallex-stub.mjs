// پیش‌بارگذاری (node --import) برای تست‌ها: به‌جای والکس واقعی، پاسخ جعلی با ~۶۰ جفت‌ارز تومانی می‌دهد
const REAL = globalThis.fetch;
const CURATED = ["btc", "eth", "usdt", "bnb", "sol", "xrp", "doge", "ada", "trx"]; // ton عمداً نیست (برای تست missing)
const EXTRA = ["ltc", "dot", "link", "shib", "uni", "avax", "atom", "etc", "bch", "xlm", ...Array.from({ length: 40 }, (_, i) => "tkn" + i), "1inch", "pepe"];
const symbols = {};
[...CURATED, ...EXTRA].forEach((id, i) => {
  symbols[id.toUpperCase() + "TMN"] = { stats: { lastPrice: String(1000 + i * 37), bidPrice: String(999 + i * 37), askPrice: String(1001 + i * 37), "24h_ch": ((i % 7) - 3) * 1.5, "24h_volume": String(100 + i), "24h_tmnVolume": String(1e9 - i * 1e7), "24h_highPrice": String(1100 + i * 37), "24h_lowPrice": String(900 + i * 37) }, stepSize: 6, tickSize: 0, minQty: "0.0001", minNotional: "1000" };
});
symbols["BTCUSDT"] = { stats: { lastPrice: "60000", bidPrice: "59999", askPrice: "60001", "24h_ch": 1 }, stepSize: 6, tickSize: 2, minQty: "0.0001", minNotional: "5" }; // جفت غیرتومانی: نباید در فهرست بیاید
symbols["weird-TMN"] = { stats: { lastPrice: "1" } }; // نماد نامعتبر: نادیده گرفته می‌شود
const json = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { "Content-Type": "application/json" } });
globalThis.fetch = async (url, init) => {
  const u = new URL(String(url));
  if (u.origin !== "https://api.wallex.ir") return REAL(url, init);
  if (u.pathname === "/v1/markets") return json({ success: true, result: { symbols } });
  if (u.pathname === "/v1/udf/history") { const n = 336, now = Math.floor(Date.now() / 1000); const t = Array.from({ length: n }, (_, i) => now - (n - i) * 3600); const c = t.map((_, i) => 1000 + Math.sin(i / 9) * 50); return json({ s: "ok", t, c, o: c, h: c.map((x) => x + 5), l: c.map((x) => x - 5), v: c.map(() => 10) }); }
  if (u.pathname === "/v1/depth") return json({ success: true, result: { ask: [{ price: "1010", quantity: "1" }, { price: "1011", quantity: "2" }], bid: [{ price: "990", quantity: "1" }, { price: "989", quantity: "2" }] } });
  if (u.pathname === "/v1/account/balances") return json({ success: true, result: { balances: { TMN: { asset: "TMN", faName: "تومان", fiat: true, value: "5000000", locked: "0" }, LTC: { asset: "LTC", faName: "لایت‌کوین", fiat: false, value: "2", locked: "0" } } } });
  return json({ success: false, message: "stub: not implemented" }, 404);
};
