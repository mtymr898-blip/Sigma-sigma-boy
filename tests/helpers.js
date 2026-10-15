// ابزار مشترک تست‌ها: گام تصادفی ساختگی با بذر ثابت
const H = 3600000;
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
export function walk(n, drift, vol, seed) { // گام تصادفی ساختگی با بذر ثابت (قابل تکرار)
  const r = rng(seed); let p = 1000; const out = [];
  for (let i = 0; i < n; i++) { const u = (r() + r() + r() + r() - 2) * vol; const o = p; p = p * (1 + drift + u);
    out.push({ t: Date.UTC(2026, 0, 1) + i * H, o, h: Math.max(o, p) * (1 + r() * vol * 0.4), l: Math.min(o, p) * (1 - r() * vol * 0.4), c: p, v: 100 + r() * 80 }); }
  return out;
}
