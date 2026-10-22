<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · **Polski** · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md) · [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md)

# AI Workstation Remote

### Steruj lokalnymi sesjami programowania AI z dowolnej zaufanej przeglądarki

</div>

## Zrzuty ekranu

<p align="center">
  <img src="../images/workbench.jpg" alt="AI Workstation Remote workbench" width="30%">
  <img src="../images/task-conversation.jpg" alt="AI Workstation Remote task conversation" width="30%">
</p>

AI Workstation Remote to lokalna, niezależna od dostawcy warstwa sterowania WWW. Pokazuje rzeczywiste sesje Codex, Cursor i Claude Code działające na macOS lub Windows w przeglądarce telefonu, tabletu, laptopa lub innego zaufanego urządzenia. Przekazuje do stacji roboczej obsługiwane wiadomości, żądania zatrzymania i decyzje zatwierdzenia. Nie jest to pulpit zdalny ani uniwersalna zdalna powłoka.

> [!WARNING]
> Projekt jest prototypem w aktywnym rozwoju. Dołączony Cloudflare Quick Tunnel służy do programowania i testów, nie do poufnych repozytoriów ani środowisk produkcyjnych.

To zlokalizowany skrót. Pełne zachowanie, konfigurację i aktualne granice bezpieczeństwa określa [angielski README](../../README.md).

## Szybki start

Wymagane są macOS (Apple Silicon lub Intel) albo Windows 10/11, Node.js 22.5+ i co najmniej jeden obsługiwany klient lokalny.

```bash
./run.sh
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\run.ps1
```

Program startowy buduje interfejs, uruchamia relay i Companion, tworzy tymczasowy tunel i wyświetla adres dostępny z innych urządzeń. Terminal musi pozostać otwarty; `Ctrl+C` zatrzymuje usługi i unieważnia publiczny URL. Domyślny adres lokalny to `http://127.0.0.1:8787`.

## Integracje

- **Codex**: app-server, oficjalne CLI i Desktop IPC, gdy jest dostępne.
- **Cursor**: odczyt lokalnego magazynu; Desktop Bridge lub lokalne rozszerzenie relay.
- **Claude Code**: odczyt historii JSONL i wznowienie przez zainstalowane CLI.

Dane uwierzytelniające modeli pozostają na stacji roboczej. Jeśli nie można bezpiecznie uzyskać prawa zapisu, sesja pozostaje tylko do odczytu.

## Rozwój

```bash
npm install
npm run dev
npm test
npm run typecheck
```

## Bezpieczeństwo i licencja

Obecny zdalny dostęp używa tymczasowego tunelu HTTPS/WSS i losowego bearer token w adresie URL. Tożsamość urządzeń, podpisane polecenia i produkcyjne szyfrowanie end-to-end nie są jeszcze zaimplementowane. Zobacz [politykę bezpieczeństwa](../../SECURITY.md) i [model bezpieczeństwa](../security.md).

Kod i dokumentacja projektu są dostępne na [licencji MIT](../../LICENSE). Komponenty zewnętrzne zachowują własne licencje; zobacz [informacje](../../THIRD_PARTY_NOTICES.md), [przewodnik współtworzenia](../../CONTRIBUTING.md) i [kodeks postępowania](../../CODE_OF_CONDUCT.md).
