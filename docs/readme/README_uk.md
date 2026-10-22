<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · **Українська** · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md) · [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md)

# AI Workstation Remote

### Керуйте локальними сеансами програмування з ШІ з будь-якого довіреного браузера

</div>

## Знімки екрана

<p align="center">
  <img src="../images/workbench.jpg" alt="AI Workstation Remote workbench" width="30%">
  <img src="../images/task-conversation.jpg" alt="AI Workstation Remote task conversation" width="30%">
</p>

AI Workstation Remote — локальний і незалежний від постачальника веб-рівень керування. Він показує справжні сеанси Codex, Cursor і Claude Code на macOS або Windows у браузері телефона, планшета, ноутбука чи іншого довіреного пристрою. Він надсилає на робочу станцію підтримувані повідомлення, запити зупинки та рішення про схвалення. Це не віддалений робочий стіл і не універсальна віддалена оболонка.

> [!WARNING]
> Проєкт є прототипом у розробці. Вбудований Cloudflare Quick Tunnel призначений лише для розробки й тестування, а не для конфіденційних репозиторіїв чи промислового використання.

Це локалізований огляд. Повну поведінку, налаштування та актуальні межі безпеки визначає [англійський README](../../README.md).

## Швидкий запуск

Потрібні macOS (Apple Silicon або Intel) чи Windows 10/11, Node.js 22.5+ і щонайменше один підтримуваний локальний клієнт.

```bash
./run.sh
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\run.ps1
```

Скрипт збирає інтерфейс, запускає relay і Companion, створює тимчасовий тунель та показує URL для доступу з інших пристроїв. Не закривайте термінал; `Ctrl+C` зупиняє служби й робить публічний URL недійсним. Локальна адреса за замовчуванням: `http://127.0.0.1:8787`.

## Інтеграції

- **Codex**: app-server, офіційна CLI та Desktop IPC, коли доступний.
- **Cursor**: читання локального сховища; Desktop Bridge або локальне relay-розширення.
- **Claude Code**: читання історії JSONL і продовження сеансу через встановлену CLI.

Облікові дані моделей залишаються на робочій станції. Якщо безпечно отримати право запису неможливо, сеанс залишається лише для читання.

## Розробка

```bash
npm install
npm run dev
npm test
npm run typecheck
```

## Безпека та ліцензія

Поточний віддалений доступ використовує тимчасовий HTTPS/WSS-тунель і випадковий bearer token в URL. Ідентифікацію пристроїв, підписані команди та наскрізне шифрування промислового рівня ще не реалізовано. Див. [політику безпеки](../../SECURITY.md) і [модель безпеки](../security.md).

Код і документація проєкту поширюються за [ліцензією MIT](../../LICENSE). Сторонні компоненти зберігають власні ліцензії; див. [сповіщення](../../THIRD_PARTY_NOTICES.md), [посібник для учасників](../../CONTRIBUTING.md) і [кодекс поведінки](../../CODE_OF_CONDUCT.md).
