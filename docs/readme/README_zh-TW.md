<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · **繁體中文** · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md) · [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md)

# AI Workstation Remote

### 從手機、平板或其他終端裝置控制本機 AI 程式設計工作階段

</div>

## 應用畫面

<p align="center">
  <img src="../images/workbench.jpg" alt="AI Workstation Remote 工作台" width="30%">
  <img src="../images/task-conversation.jpg" alt="AI Workstation Remote 任務對話" width="30%">
</p>

AI Workstation Remote 是本機優先、廠商中立的 Web 控制層，可將 macOS 或 Windows 上真實的 Codex、Cursor 與 Claude Code 工作階段呈現在手機、平板、筆記型電腦或其他受信任裝置的瀏覽器中，並把支援的訊息、停止要求與核准操作送回工作站。它不是遠端桌面，也不是通用遠端 Shell。

> [!WARNING]
> 本專案仍是開發中的原型。內建的 Cloudflare Quick Tunnel 只適合開發與測試，不應用於敏感儲存庫或正式工作負載。

本文是本地化概覽。完整功能、設定與最新安全邊界以[英文主 README](../../README.md) 為準。

## 快速開始

需要 macOS（Apple Silicon 或 Intel）、Windows 10 x64 或 Windows 11（x64/ARM64）、Node.js 22.5+，以及至少一個支援的本機客戶端。

```bash
caffeinate -i ./run.sh
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\run.ps1
```

啟動程式會建置 Web 介面、啟動本機中繼與 Companion、建立暫時通道，並顯示供其他終端裝置存取的 URL。請保持終端機執行；`Ctrl+C` 會停止服務並使公開 URL 失效。預設本機網址是 `http://127.0.0.1:8787`。

## 支援的整合

- **Codex**：透過 app-server、官方 CLI，以及可用時的 Desktop IPC 進行探索與控制。
- **Cursor**：唯讀存取本機工作階段資料；優先使用 Desktop Bridge，否則使用本機中繼擴充功能。
- **Claude Code**：讀取本機 JSONL 歷程，並用已安裝的 CLI 繼續原工作階段。

模型憑證保留在工作站。介面只顯示目前工作階段真正支援的操作；無法安全取得寫入權時會維持唯讀。

## 本機開發

```bash
npm install
npm run dev
npm test
npm run typecheck
```

## 安全與授權

目前遠端模式使用暫時 HTTPS/WSS 通道及 URL 中的隨機 bearer token，尚未提供正式環境所需的裝置身分、簽署命令或端對端加密信封。請閱讀[安全政策](../../SECURITY.md)與[安全模型](../security.md)。

專案原創程式碼與文件採用 [MIT License](../../LICENSE)。第三方元件保留各自授權，詳見[第三方通知](../../THIRD_PARTY_NOTICES.md)。貢獻前請閱讀[貢獻指南](../../CONTRIBUTING.md)與[行為準則](../../CODE_OF_CONDUCT.md)。
