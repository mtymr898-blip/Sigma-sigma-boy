// محدودکننده‌ی نرخ پنجره‌ی لغزان در حافظه (برای ضد اسپم و جلوگیری از سوءاستفاده در صورت نشت راز)
export function createLimiter({ now = () => Date.now() } = {}) {
  const buckets = new Map();
  function hit(key, max, windowMs) {
    const t = now(); const arr = (buckets.get(key) || []).filter((x) => t - x < windowMs);
    if (arr.length >= max) { buckets.set(key, arr); return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((arr[0] + windowMs - t) / 1000)) }; }
    arr.push(t); buckets.set(key, arr);
    if (buckets.size > 5000) for (const [k, v] of buckets) if (!v.length || t - v[v.length - 1] > 3600000) buckets.delete(k);
    return { allowed: true, retryAfterSec: 0 };
  }
  return { hit };
}
