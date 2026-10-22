<div align="center" dir="rtl">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · **فارسی** · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md) · [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md)

# AI Workstation Remote

### نشست‌های محلی برنامه‌نویسی هوش مصنوعی را از هر مرورگر مطمئن کنترل کنید

</div>

## تصاویر محیط برنامه

<p align="center">
  <img src="../images/workbench.jpg" alt="AI Workstation Remote workbench" width="30%">
  <img src="../images/task-conversation.jpg" alt="AI Workstation Remote task conversation" width="30%">
</p>

<div dir="rtl">

AI Workstation Remote یک لایهٔ کنترل Web با رویکرد local-first و مستقل از فروشنده است. نشست‌های واقعی Codex، Cursor و Claude Code روی macOS یا Windows را در مرورگر تلفن، تبلت، لپ‌تاپ یا دستگاه مطمئن دیگری نمایش می‌دهد و پیام‌ها، درخواست‌های توقف و تصمیم‌های تأیید پشتیبانی‌شده را به رایانه بازمی‌گرداند. این پروژه دسکتاپ از راه دور یا shell عمومی از راه دور نیست.

> [!WARNING]
> این پروژه نمونه‌ای در حال توسعه است. Cloudflare Quick Tunnel همراه فقط برای توسعه و آزمایش است و برای مخزن‌های حساس یا محیط تولید مناسب نیست.

این صفحه یک مرور ترجمه‌شده است. [README انگلیسی](../../README.md) مرجع رفتار کامل، پیکربندی و مرزهای امنیتی به‌روز است.

## شروع سریع

به macOS ‏(Apple Silicon یا Intel) یا Windows 10/11، نسخهٔ Node.js 22.5+ و دست‌کم یک برنامهٔ محلی پشتیبانی‌شده نیاز است.

</div>

```bash
./run.sh
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\run.ps1
```

<div dir="rtl">

راه‌انداز رابط را می‌سازد، relay و Companion را اجرا می‌کند، تونل موقت می‌سازد و نشانی قابل دسترسی از دستگاه‌های دیگر را نشان می‌دهد. پایانه را باز نگه دارید؛ `Ctrl+C` سرویس‌ها را متوقف و نشانی عمومی را باطل می‌کند. نشانی محلی پیش‌فرض `http://127.0.0.1:8787` است.

## یکپارچه‌سازی‌ها

- **Codex**: app-server، ابزار رسمی CLI و Desktop IPC در صورت دسترس بودن.
- **Cursor**: خواندن مخزن نشست محلی؛ Desktop Bridge یا افزونهٔ relay محلی.
- **Claude Code**: خواندن تاریخچهٔ JSONL و ادامهٔ نشست با CLI نصب‌شده.

اطلاعات ورود مدل روی رایانه باقی می‌ماند. اگر کنترل نوشتن با اطمینان به دست نیاید، نشست فقط‌خواندنی می‌ماند.

## توسعه

</div>

```bash
npm install
npm run dev
npm test
npm run typecheck
```

<div dir="rtl">

## امنیت و مجوز

دسترسی راه دور فعلی از تونل موقت HTTPS/WSS و bearer token تصادفی در نشانی استفاده می‌کند. هویت دستگاه، فرمان‌های امضاشده و رمزگذاری سرتاسری مناسب تولید هنوز پیاده‌سازی نشده‌اند. [سیاست امنیت](../../SECURITY.md) و [مدل امنیت](../security.md) را ببینید.

کد و مستندات پروژه با [مجوز MIT](../../LICENSE) منتشر می‌شوند. اجزای شخص ثالث مجوزهای خود را حفظ می‌کنند؛ [اعلان‌ها](../../THIRD_PARTY_NOTICES.md)، [راهنمای مشارکت](../../CONTRIBUTING.md) و [آیین‌نامهٔ رفتاری](../../CODE_OF_CONDUCT.md) را ببینید.

</div>
