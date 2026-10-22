<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · **Deutsch** · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md) · [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md)

# AI Workstation Remote

### Lokale KI-Coding-Sitzungen über jeden vertrauenswürdigen Browser steuern

</div>

## Screenshots

<p align="center">
  <img src="../images/workbench.jpg" alt="AI Workstation Remote workbench" width="30%">
  <img src="../images/task-conversation.jpg" alt="AI Workstation Remote task conversation" width="30%">
</p>

AI Workstation Remote ist eine lokale, herstellerneutrale Websteuerung, die echte Codex-, Cursor- und Claude-Code-Sitzungen unter macOS oder Windows im Browser eines Smartphones, Tablets, Laptops oder anderen vertrauenswürdigen Geräts anzeigt. Unterstützte Nachrichten, Stoppanforderungen und Freigaben werden an die Workstation zurückgesendet. Es handelt sich weder um eine Remote-Desktop-Lösung noch um eine allgemeine Remote-Shell.

> [!WARNING]
> Dieses Repository ist ein aktiver Entwicklungsprototyp. Der mitgelieferte Cloudflare Quick Tunnel ist nur für Entwicklung und Tests vorgesehen, nicht für vertrauliche Repositorys oder Produktionslasten.

Dies ist eine lokalisierte Übersicht. Verbindlich für vollständiges Verhalten, Konfiguration und aktuelle Sicherheitsgrenzen ist die [englische README](../../README.md).

## Schnellstart

Erforderlich sind macOS (Apple Silicon oder Intel) oder Windows 10/11, Node.js 22.5+ und mindestens ein unterstützter lokaler Client.

```bash
caffeinate -i ./run.sh
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\run.ps1
```

Der Starter baut die Weboberfläche, startet Relay und Companion, erstellt einen temporären Tunnel und zeigt eine Zugriffs-URL für andere Geräte an. Das Terminal muss geöffnet bleiben; `Ctrl+C` beendet die Dienste und macht die öffentliche URL ungültig. Die lokale Standardadresse ist `http://127.0.0.1:8787`.

## Unterstützte Integrationen

- **Codex**: Erkennung und Steuerung über app-server, offizielle CLI und, falls verfügbar, Desktop IPC.
- **Cursor**: Nur-Lese-Zugriff auf den lokalen Sitzungsspeicher; bevorzugt Desktop Bridge, sonst die lokale Relay-Erweiterung.
- **Claude Code**: Liest lokale JSONL-Verläufe und setzt Sitzungen über die installierte CLI fort.

Modellzugangsdaten bleiben auf der Workstation. Kann Schreibzugriff nicht sicher übernommen werden, bleibt die Sitzung schreibgeschützt.

## Lokale Entwicklung

```bash
npm install
npm run dev
npm test
npm run typecheck
```

## Sicherheit und Lizenz

Der aktuelle Fernzugriff verwendet einen temporären HTTPS/WSS-Tunnel und ein zufälliges Bearer-Token in der URL. Geräteidentitäten, signierte Befehle und Ende-zu-Ende-Verschlüsselung auf Produktionsniveau fehlen noch. Siehe [Sicherheitsrichtlinie](../../SECURITY.md) und [Sicherheitsmodell](../security.md).

Projektcode und Dokumentation stehen unter der [MIT-Lizenz](../../LICENSE). Komponenten Dritter behalten ihre eigenen Lizenzen; siehe [Drittanbieterhinweise](../../THIRD_PARTY_NOTICES.md), [Beitragsleitfaden](../../CONTRIBUTING.md) und [Verhaltenskodex](../../CODE_OF_CONDUCT.md).
