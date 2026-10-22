<div align="center">

[English](../../README.md) · **简体中文** · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md) · [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md)

# AI Workstation Remote

### 从手机、平板或其他终端设备控制本地 AI 编程会话

</div>

## 应用效果

<p align="center">
  <img src="../images/workbench.jpg" alt="AI Workstation Remote 工作台" width="30%">
  <img src="../images/task-conversation.jpg" alt="AI Workstation Remote 任务对话" width="30%">
</p>

AI Workstation Remote 是一个本地优先、厂商中立的 Web 控制层。它把 macOS 或 Windows 上真实的 Codex、Cursor 和 Claude Code 会话呈现在手机、平板、笔记本、副屏电脑或其他受信任终端设备的浏览器中，并把受支持的消息、停止请求和审批操作发送回工作站。它不是远程桌面，也不是通用远程 Shell。

> [!WARNING]
> 本项目仍是开发中的原型。内置 Cloudflare Quick Tunnel 仅适合开发和测试，不应处理敏感仓库或生产工作负载。

本文是本地化概览。功能细节、配置项和最新安全边界以[英文主 README](../../README.md) 为准。

## 为什么开发这个项目

AI 编程任务可能长时间运行、等待审批，也可能在开发者离开后偏离方向。厂商远控通常受单一生态限制，而远程桌面和 SSH 又暴露了超出任务管理所需的权限。本项目让源码、工具、凭证和模型路由继续留在工作站，同时为多个 Agent 提供统一、结构化的控制界面。

> **终端设备配对的是用户自己的工作站和任务，而不是某个模型厂商账号；模型凭证保留在工作站，各 Agent 继续使用原有的本地配置执行。**

通过任意受信任设备的浏览器，用户可以统一查看 Codex、Cursor 和 Claude Code 的进度、历史、文件变更、测试与错误，发送后续指令，处理受支持的审批，以及停止或新建任务。Workstation Companion 始终是最终授权边界；无法安全取得控制权的会话会保持只读。完整设计见[开源项目白皮书](../open-source-whitepaper.md)。

## 快速开始

需要 macOS（Apple Silicon 或 Intel）、Windows 10 x64 或 Windows 11（x64/ARM64）、Node.js 22.5+，以及至少一个受支持的本地客户端。

macOS：

```bash
./run.sh
```

Windows PowerShell：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\run.ps1
```

启动器会构建 Web 界面、启动本地中继和 Companion、建立临时隧道，并打印供其他终端设备访问的 URL。保持终端运行；`Ctrl+C` 会停止服务并使临时公网地址失效。默认本地地址为 `http://127.0.0.1:8787`。

## 支持的集成

- **Codex**：通过 app-server、官方 CLI 和可用时的 Desktop IPC 进行会话发现与控制。
- **Cursor**：只读访问本地会话存储；优先使用 Desktop Bridge，否则使用本地中继扩展。
- **Claude Code**：读取本地 JSONL 历史，并使用已安装的 CLI 继续原会话。

所有模型凭证都留在工作站。界面只展示当前会话真实支持的操作；无法安全取得写入权时会降级为只读。

## 本地开发

```bash
npm install
npm run dev
npm test
npm run typecheck
```

## 安全与开源协议

当前远程模式使用临时 HTTPS/WSS 隧道和 URL 中的随机 bearer token，尚未实现生产级设备身份、签名命令或端到端加密信封。请阅读[安全策略](../../SECURITY.md)和[安全模型](../security.md)。

项目原创代码和文档采用 [MIT License](../../LICENSE)。第三方组件保留各自许可证，详见[第三方通知](../../THIRD_PARTY_NOTICES.md)。参与贡献前请阅读[贡献指南](../../CONTRIBUTING.md)和[行为准则](../../CODE_OF_CONDUCT.md)。
