<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · **Русский** · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md) · [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md)

# AI Workstation Remote

### Управляйте локальными сеансами ИИ-программирования из любого доверенного браузера

</div>

## Скриншоты

<p align="center">
  <img src="../images/workbench.jpg" alt="AI Workstation Remote workbench" width="30%">
  <img src="../images/task-conversation.jpg" alt="AI Workstation Remote task conversation" width="30%">
</p>

AI Workstation Remote — локальный и независимый от поставщика веб-слой управления. Он показывает реальные сеансы Codex, Cursor и Claude Code на macOS или Windows в браузере телефона, планшета, ноутбука или другого доверенного устройства. Он передаёт на рабочую станцию поддерживаемые сообщения, запросы остановки и решения об одобрении. Это не удалённый рабочий стол и не универсальная удалённая оболочка.

> [!WARNING]
> Проект является разрабатываемым прототипом. Встроенный Cloudflare Quick Tunnel предназначен только для разработки и тестирования, а не для конфиденциальных репозиториев или промышленной эксплуатации.

Это локализованный обзор. Полное поведение, настройки и актуальные границы безопасности описаны в [английском README](../../README.md).

## Быстрый запуск

Требуются macOS (Apple Silicon или Intel) либо Windows 10/11, Node.js 22.5+ и хотя бы один поддерживаемый локальный клиент.

```bash
./run.sh
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\run.ps1
```

Скрипт собирает интерфейс, запускает relay и Companion, создаёт временный туннель и выводит URL для доступа с других устройств. Не закрывайте терминал; `Ctrl+C` остановит службы и сделает публичный URL недействительным. Локальный адрес по умолчанию: `http://127.0.0.1:8787`.

## Интеграции

- **Codex**: app-server, официальная CLI и Desktop IPC, когда он доступен.
- **Cursor**: чтение локального хранилища; Desktop Bridge или локальное relay-расширение.
- **Claude Code**: чтение истории JSONL и продолжение сеанса через установленную CLI.

Учётные данные моделей остаются на рабочей станции. Если безопасно получить право записи нельзя, сеанс остаётся только для чтения.

## Разработка

```bash
npm install
npm run dev
npm test
npm run typecheck
```

## Безопасность и лицензия

Сейчас удалённый доступ использует временный HTTPS/WSS-туннель и случайный bearer token в URL. Идентификация устройств, подписанные команды и сквозное шифрование промышленного уровня ещё не реализованы. См. [политику безопасности](../../SECURITY.md) и [модель безопасности](../security.md).

Код и документация проекта распространяются по [лицензии MIT](../../LICENSE). Компоненты третьих сторон сохраняют свои лицензии; см. [уведомления](../../THIRD_PARTY_NOTICES.md), [руководство по участию](../../CONTRIBUTING.md) и [кодекс поведения](../../CODE_OF_CONDUCT.md).
