AI Workstation Remote for Windows
=================================

系统要求：Windows 10 x64，或 Windows 11 x64/ARM64。ARM64 版本通过 Windows 11 的 x64 兼容层运行包内 cloudflared。

启动
----

1. 解压整个 ZIP，不要只复制启动脚本。
2. 双击 AI-Workstation-Remote.cmd。
3. 等待终端输出 AI_WORKSTATION_ACCESS_URL。
4. 在手机浏览器中打开该地址；本机也可以打开终端显示的 AI_WORKSTATION_LOCAL_URL。
5. 保持终端运行；关闭终端后，临时公网地址会失效。

支持的本地客户端
----------------

- Codex：需要 Codex CLI 已加入 PATH，或设置 CODEX_BIN。
- Claude Code：需要原生或 npm CLI 已安装，或设置 CLAUDE_BIN。
- Cursor：优先使用 Desktop Bridge；不可用时使用包内的本地中继、Windows 命名管道和 SendInput 辅助程序。

首次安装或更新 Cursor 中继后，请完整退出并重新启动 Cursor。Cursor 控制不读取或修改剪贴板，也不需要 cursor-agent 登录。

安全说明
--------

公网地址来自临时 Cloudflare Quick Tunnel，并包含随机配对令牌。它仅适合开发和测试，不具备生产级身份认证或端到端加密；不要用于敏感工作。

开源许可
--------

AI Workstation Remote 原创代码采用 MIT 许可证。完整的项目、Node.js、npm 依赖和 cloudflared 许可材料位于 app\licenses 目录。
