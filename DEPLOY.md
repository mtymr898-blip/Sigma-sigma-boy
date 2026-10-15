# راه‌اندازی داشبورد روی VPS ایرانی

`src/worker.js` (به‌همراه `src/engine.js` و `src/trading.js` برای موتور معاملاتی) بدون تغییر روی Node اجرا می‌شود. `server.js` همان را روی Node.js اجرا می‌کند
(ذخیره‌سازی → فایل `data/store.json`، فایل‌های `public/` → سرو مستقیم، cron → هر ۳۰ دقیقه).
هیچ پکیج npm‌ای لازم نیست؛ فقط Node.js ‏۲۰ یا بالاتر.

## ۰) قبل از هر کاری: تست IP سرور

بعد از خرید VPS (اوبونتو ۲۲.۰۴ یا ۲۴.۰۴ پیشنهاد می‌شود) وصل شو و این را بزن:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://api.wallex.ir/v1/markets
```

اگر `200` آمد، IP سرور برای والکس قابل قبول است. اگر `403` یا خطا آمد، قبل از ادامه با پشتیبانی
سرویس‌دهنده یا والکس صحبت کن (بعضی رنج IPها در دیتابیس والکس «ایرانی» شناخته نمی‌شوند).

## ۱) نصب Node.js

```bash
apt update && apt install -y curl unzip ufw
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
node -v
```

اگر NodeSource از روی سرور در دسترس نبود: فایل `node-v22.*-linux-x64.tar.xz` را روی کامپیوتر خودت
دانلود کن، با `scp` بفرست و با `tar -xf ... -C /usr/local --strip-components=1` باز کن.

## ۲) آپلود پروژه

اول در `public/index.html` (حدود خط ۹۴۵) آدرس دامنه‌ات را بگذار (برای وب و APK هر دو لازم است):

```js
window.__API_BASE__ = "https://dashboard.example.com";
```

بعد از روی کامپیوتر:

```bash
scp dashboard.zip root@IP_SERVER:/root/
ssh root@IP_SERVER
unzip dashboard.zip -d /opt
```

## ۳) تنظیمات و Secrets

```bash
useradd -r -s /usr/sbin/nologin dashboard
cd /opt/dashboard
cp .env.example .env
nano .env          # WALLEX_API_KEY ، SESSION_SECRET ، DASHBOARD_PASSCODE را پر کن
chmod 600 .env
mkdir -p data && chown -R dashboard:dashboard data
```

برای `SESSION_SECRET` خروجی `openssl rand -hex 32` را بگذار.
`TRADING_ENABLED` را تا وقتی همه‌چیز را تست نکرده‌ای روی `false` نگه دار.

## ۴) اجرا به‌صورت سرویس

```bash
cp deploy/dashboard.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now dashboard
curl http://127.0.0.1:8787/healthz     # باید ok بدهد
journalctl -u dashboard -f             # لاگ زنده
```

## ۵) HTTPS با Caddy

اپ اندروید (Capacitor با scheme از نوع https) فقط به آدرس **HTTPS** وصل می‌شود، پس دامنه لازم است.

1. رکورد A دامنه را روی IP سرور بگذار.
2. نصب و تنظیم:

```bash
apt install -y caddy
cp /opt/dashboard/deploy/Caddyfile /etc/caddy/Caddyfile
nano /etc/caddy/Caddyfile              # dashboard.example.com را با دامنه‌ات عوض کن
systemctl reload caddy
```

3. فایروال (حتماً اول SSH را باز کن):

```bash
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp
ufw enable
```

Caddy خودش گواهی را می‌گیرد و تمدید می‌کند. با باز کردن `https://دامنه‌ی_تو` داشبورد باید بالا بیاید،
بدون VPN.

## ۶) ساخت دوباره‌ی APK

فایل `public/index.html` (با `__API_BASE__` جدید) را در ریپوی گیت‌هاب جایگزین کن و Push کن تا
GitHub Actions دوباره APK را بسازد. `ALLOWED_ORIGINS=https://localhost` در `.env` همان مبدأ اپ اندروید است.

## ۷) بعد از راه‌اندازی

- اگر در پنل والکس برای کلید API فهرست IP مجاز می‌شود، IP سرور را اضافه کن.
- به‌روزرسانی کد: فایل‌ها را جایگزین کن و `systemctl restart dashboard` بزن.
- پشتیبان: `data/store.json` (سوابق سفارش و نمونه‌های نمودار پرتفو). نمونه‌های قدیمی Cloudflare منتقل نمی‌شوند.
- لاگین ناموفق ۵ بار در ۱۵ دقیقه قفل می‌شود (مثل قبل). رمز دسترسی را قوی بگذار، چون حالا روی اینترنت عمومی است.
- سرویس Worker قدیمی روی Cloudflare دیگر لازم نیست و می‌توانی پاکش کنی.


## آپدیت موتور معاملاتی (نسخه ۱.۲.۰)
فایل‌های جایگزین‌شونده: `server.js`، `src/worker.js`، `public/index.html`، `package.json`، `.env.example`، `DEPLOY.md`
فایل‌های جدید: `src/engine.js`، `src/trading.js`، `docs/TRADING.md`، `tests/*`

```bash
cd /opt/dashboard            # مسیر پروژه‌ات
cp -r . ../dashboard-backup-$(date +%F)       # بکاپ
# فایل‌ها را جایگزین کن، سپس:
npm test                     # باید همه‌ی تست‌ها pass شوند
sudo systemctl restart dashboard
```
پیش‌فرض‌ها امن‌اند: حالت «تحلیل و پیشنهاد»، معامله‌ی واقعی قفل (`AUTO_TRADING_ENABLED=false`).
راهنمای کامل: `docs/TRADING.md`
