<div align="center" dir="rtl">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · **العربية** · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md) · [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md)

# AI Workstation Remote

### تحكّم في جلسات البرمجة بالذكاء الاصطناعي المحلية من أي متصفح موثوق

</div>

## لقطات الشاشة

<p align="center">
  <img src="../images/workbench.jpg" alt="AI Workstation Remote workbench" width="30%">
  <img src="../images/task-conversation.jpg" alt="AI Workstation Remote task conversation" width="30%">
</p>

<div dir="rtl">

AI Workstation Remote هو طبقة تحكّم Web محلية أولاً ومحايدة تجاه المورّدين. يعرض جلسات Codex وCursor وClaude Code الحقيقية العاملة على macOS أو Windows في متصفح هاتف أو جهاز لوحي أو حاسوب محمول أو أي جهاز موثوق آخر، ويرسل الرسائل وطلبات الإيقاف وقرارات الموافقة المدعومة إلى محطة العمل. وهو ليس سطح مكتب بعيداً ولا shell بعيداً للأغراض العامة.

> [!WARNING]
> المشروع نموذج أولي قيد التطوير. خدمة Cloudflare Quick Tunnel المرفقة مخصصة للتطوير والاختبار، وليست للمستودعات الحساسة أو أحمال الإنتاج.

هذه نظرة عامة مترجمة. يبقى [README الإنجليزي](../../README.md) المرجع للسلوك الكامل والإعدادات وحدود الأمان الحالية.

## البدء السريع

يلزم macOS ‏(Apple Silicon أو Intel) أو Windows 10/11، وNode.js 22.5+، وعميل محلي مدعوم واحد على الأقل.

</div>

```bash
./run.sh
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\run.ps1
```

<div dir="rtl">

يبني المشغّل الواجهة ويشغّل relay وCompanion وينشئ نفقاً مؤقتاً ثم يعرض رابطاً يمكن الوصول إليه من الأجهزة الأخرى. أبقِ الطرفية مفتوحة؛ يوقف `Ctrl+C` الخدمات ويلغي الرابط العام. العنوان المحلي الافتراضي هو `http://127.0.0.1:8787`.

## التكاملات

- **Codex**: عبر app-server وCLI الرسمي وDesktop IPC عند توفره.
- **Cursor**: قراءة مخزن الجلسات المحلي؛ عبر Desktop Bridge أو إضافة relay المحلية.
- **Claude Code**: قراءة سجل JSONL ومتابعة الجلسة بواسطة CLI المثبت.

تبقى بيانات اعتماد النماذج على محطة العمل. إذا تعذر الحصول على صلاحية الكتابة بأمان، تبقى الجلسة للقراءة فقط.

## التطوير

</div>

```bash
npm install
npm run dev
npm test
npm run typecheck
```

<div dir="rtl">

## الأمان والترخيص

يستخدم الوصول البعيد حالياً نفق HTTPS/WSS مؤقتاً وbearer token عشوائياً في الرابط. لم تُنفّذ بعد هوية الأجهزة والأوامر الموقّعة والتشفير بين الطرفين بمستوى الإنتاج. راجع [سياسة الأمان](../../SECURITY.md) و[نموذج الأمان](../security.md).

كود المشروع ووثائقه متاحة وفق [رخصة MIT](../../LICENSE). تحتفظ مكوّنات الطرف الثالث برخصها؛ راجع [إشعارات الطرف الثالث](../../THIRD_PARTY_NOTICES.md) و[دليل المساهمة](../../CONTRIBUTING.md) و[مدونة السلوك](../../CODE_OF_CONDUCT.md).

</div>
