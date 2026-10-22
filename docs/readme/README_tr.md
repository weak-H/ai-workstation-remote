<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · **Türkçe** · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md) · [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md)

# AI Workstation Remote

### Yerel yapay zeka kodlama oturumlarını güvenilir herhangi bir tarayıcıdan yönetin

</div>

## Ekran görüntüleri

<p align="center">
  <img src="../images/workbench.jpg" alt="AI Workstation Remote workbench" width="30%">
  <img src="../images/task-conversation.jpg" alt="AI Workstation Remote task conversation" width="30%">
</p>

AI Workstation Remote, macOS veya Windows üzerinde çalışan gerçek Codex, Cursor ve Claude Code oturumlarını telefon, tablet, dizüstü bilgisayar veya başka bir güvenilir cihazın tarayıcısında gösteren local-first ve satıcıdan bağımsız bir Web denetim katmanıdır. Desteklenen iletileri, durdurma isteklerini ve onayları iş istasyonuna geri gönderir. Uzak masaüstü veya genel amaçlı uzak kabuk değildir.

> [!WARNING]
> Bu depo geliştirme aşamasında bir prototiptir. Birlikte gelen Cloudflare Quick Tunnel yalnızca geliştirme ve test içindir; hassas depolar veya üretim iş yükleri için uygun değildir.

Bu sayfa çevrilmiş bir özettir. Tam davranış, yapılandırma ve güncel güvenlik sınırları için [İngilizce README](../../README.md) esas alınır.

## Hızlı başlangıç

macOS (Apple Silicon veya Intel) ya da Windows 10/11, Node.js 22.5+ ve desteklenen en az bir yerel istemci gerekir.

```bash
./run.sh
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\run.ps1
```

Başlatıcı arayüzü derler, relay ve Companion'ı çalıştırır, geçici tünel oluşturur ve diğer cihazlardan erişilebilen bir URL gösterir. Terminali açık tutun; `Ctrl+C` hizmetleri durdurur ve genel URL'yi geçersiz kılar. Varsayılan yerel adres `http://127.0.0.1:8787`'dir.

## Entegrasyonlar

- **Codex**: app-server, resmi CLI ve kullanılabiliyorsa Desktop IPC.
- **Cursor**: yerel oturum deposuna salt okunur erişim; Desktop Bridge veya yerel relay uzantısı.
- **Claude Code**: yerel JSONL geçmişi ve kurulu CLI ile oturuma devam etme.

Model kimlik bilgileri iş istasyonunda kalır. Yazma denetimi güvenle alınamazsa oturum salt okunur kalır.

## Geliştirme

```bash
npm install
npm run dev
npm test
npm run typecheck
```

## Güvenlik ve lisans

Mevcut uzaktan erişim, geçici HTTPS/WSS tüneli ve URL'de rastgele bearer token kullanır. Üretim düzeyi cihaz kimliği, imzalı komutlar ve uçtan uca şifreleme henüz uygulanmamıştır. [Güvenlik politikasına](../../SECURITY.md) ve [güvenlik modeline](../security.md) bakın.

Proje kodu ve belgeleri [MIT Lisansı](../../LICENSE) altındadır. Üçüncü taraf bileşenler kendi lisanslarını korur; [bildirimlere](../../THIRD_PARTY_NOTICES.md), [katkı rehberine](../../CONTRIBUTING.md) ve [davranış kurallarına](../../CODE_OF_CONDUCT.md) bakın.
