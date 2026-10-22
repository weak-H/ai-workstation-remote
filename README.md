<div align="center">

**English** · [简体中文](docs/readme/README_zh.md) · [繁體中文](docs/readme/README_zh-TW.md) · [日本語](docs/readme/README_ja.md) · [한국어](docs/readme/README_ko.md) · [Türkçe](docs/readme/README_tr.md) · [Русский](docs/readme/README_ru.md) · [Tiếng Việt](docs/readme/README_vi.md) · [ไทย](docs/readme/README_th.md) · [Deutsch](docs/readme/README_de.md) · [Español](docs/readme/README_es.md) · [Français](docs/readme/README_fr.md) · [Українська](docs/readme/README_uk.md) · [Polski](docs/readme/README_pl.md) · [Português (Brasil)](docs/readme/README_pt-BR.md) · [العربية](docs/readme/README_ar.md) · [فارسی](docs/readme/README_fa.md) · [Bahasa Indonesia](docs/readme/README_id.md) · [Italiano](docs/readme/README_it.md) · [Ελληνικά](docs/readme/README_el.md) · [മലയാളം](docs/readme/README_ml.md)

# AI Workstation Remote

### Control local AI coding sessions from any browser

[![MIT license](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](LICENSE)
[![Node.js 22.5+](https://img.shields.io/badge/Node.js-22.5%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)](package.json)

[Screenshots](#screenshots) · [Why](#why-this-project) · [Quick start](#quick-start) · [Integrations](#current-integrations) · [Security](#security-boundary) · [Contributing](#contributing) · [License](#license)

</div>

AI Workstation Remote is a local-first, vendor-neutral Web control plane for AI coding sessions on macOS and Windows. It makes real Codex, Cursor, and Claude Code sessions available in a browser on a phone, tablet, laptop, secondary desktop, or another trusted device. From that browser you can inspect progress and send supported messages, stop requests, and approval decisions back to the workstation. It is not a remote-desktop implementation or a general-purpose remote shell.

> This repository is an active development prototype. The bundled Cloudflare Quick Tunnel is suitable for development and testing, not sensitive or production workloads.

## Screenshots

<p align="center">
  <img src="docs/images/workbench.jpg" alt="AI Workstation Remote workbench showing local AI coding sessions" width="30%">
  <img src="docs/images/task-conversation.jpg" alt="AI Workstation Remote task conversation with live progress and tool activity" width="30%">
</p>

## Why this project

AI coding tasks can run for a long time, pause for approval, or drift while the developer is away. Vendor remote products are often tied to one ecosystem, while remote desktop and SSH expose more access than task monitoring requires. This project keeps source code, tools, credentials, and model routing on the workstation while providing one structured control interface for multiple Agents.

> **The client device pairs with the user's workstation and tasks, not with a model vendor account. Model credentials remain on the workstation, and each Agent continues to use its existing local configuration.**

From any trusted browser, users can inspect progress, history, diffs, tests, and errors; send follow-ups; handle supported approvals; and stop or create tasks across Codex, Cursor, and Claude Code. The Workstation Companion remains the final authorization boundary, and sessions stay read-only when control cannot be established safely. See the [open-source whitepaper](docs/open-source-whitepaper.md) for the full rationale and security direction.

## Quick start

Requirements:

- macOS (Apple Silicon or Intel), Windows 10 x64, or Windows 11 (x64 or ARM64)
- Node.js 22.5 or newer
- At least one supported local client: Codex, Cursor, or Claude Code

The repository contains compressed `cloudflared` archives for each supported platform. On first use, the launcher extracts only the binary needed by the current machine and verifies its SHA-256 checksum; it does not download or install Cloudflare software.

### macOS

```bash
./run.sh
```

### Windows PowerShell

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\run.ps1
```

The launcher:

1. validates Node.js, the selected port, and bundled `cloudflared`;
2. installs npm dependencies when the manifests have changed;
3. installs or updates the local Cursor relay when Cursor is present;
4. builds the Web UI and starts the relay plus Workstation Companion;
5. creates a temporary Cloudflare Quick Tunnel and prints an access URL for other devices.

On macOS, the QR code is printed directly in the launcher terminal. Keep the launcher terminal running; `Ctrl+C` stops the workstation services and invalidates the temporary public URL.

The default local URL is `http://127.0.0.1:8787`. Direct loopback access does not require the pairing token. Tunnel access requires the random token embedded in the printed URL.

Use another port when `8787` is already occupied:

```bash
CONTROL_PORT=8788 ./run.sh
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\run.ps1 -Port 8788
```

The scripts reject invalid or occupied ports instead of silently connecting a new tunnel to an older process.

## Local development

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:5173`. Vite serves the UI on port `5173`; the development relay and Companion use `127.0.0.1:8787`. `npm run dev` also checks the optional Cursor relay. If Cursor is not installed, setup is skipped and Codex/Claude Code remain available.

Useful commands:

```bash
npm test
npm run typecheck
npm run verify:codex
npm run verify:cursor
npm run verify:claude
npm run smoke
```

`verify:*` commands inspect local data and client availability without sending a prompt. `npm run smoke` expects the local development services to be running and verifies that the relay exposes real Codex thread IDs rather than simulated data.

## Current integrations

| Source | Discovery and history | Control path |
| --- | --- | --- |
| Codex | Codex app-server plus the desktop project catalog | New tasks and Companion-owned sessions use the installed official CLI. A session owned by Codex Desktop is controlled through the same-user Desktop IPC follower channel when available; otherwise it remains read-only. |
| Cursor | Read-only access to Cursor's local SQLite conversation store | Prefers Cursor Desktop Bridge. If that account-gated bridge is unavailable, the local relay extension focuses the exact Composer and uses a platform input helper. |
| Claude Code | Read-only parsing of `~/.claude/projects` JSONL transcripts | Uses the installed CLI with the original session ID. Only Companion-started turns can be stopped from the Web UI. |

The UI groups sessions by their native projects, loads chronological history on demand, displays reasoning/tool activity and working-tree diffs, and exposes only the controls reported as safe for each task. Codex history is bounded to 200 turns and all source timelines are bounded to 1,000 entries.

New tasks and follow-up messages accept up to three PNG, JPEG, WebP, or GIF files, at most 5 MB each. Attachments are validated and written with owner-only permissions to a temporary workstation directory; the Agent receives local file paths rather than a separate cloud upload.

### Codex behavior

The Companion uses app-server for registration, discovery, history, and project mapping. For a new task it creates a Desktop-visible thread, releases the app-server writer, and submits the first prompt through `codex exec resume`. Later behavior depends on ownership:

- Companion/CLI-owned sessions continue through the installed Codex CLI.
- Desktop-owned sessions remain owned by Desktop; the local IPC follower channel forwards start, steer, stop, and approval decisions to that owner when available.
- If writer ownership cannot be coordinated, the task fails closed to read-only.

Do not intentionally run competing CLI turns against the same thread.

### Cursor setup

The source launchers install the checked-in `AI Workstation Cursor Relay` extension only when Cursor is present. Completely restart Cursor after the first installation or an extension update.

Cursor Desktop Bridge is preferred when the account exposes it. Enable **Allow CLI to access desktop agents** under Cursor Settings > Beta, then restart Cursor. The fallback relay does not require `cursor-agent login`, an API key, or clipboard access. It does require an unlocked desktop session; on macOS, grant Accessibility permission to `cursor-input-helper` when prompted. Source-based macOS setup also needs `xcrun` with the Swift compiler to build that helper.

### Claude Code behavior

Claude projects are derived from each transcript's working directory. Sending a message runs the installed CLI non-interactively with `--resume`; creating a task uses a new session ID. A session recently written by another terminal is read-only until it is no longer active.

## Configuration

| Variable | Purpose |
| --- | --- |
| `CONTROL_PORT` | Local relay port; defaults to `8787`. Windows users can also pass `-Port`. |
| `CLOUDFLARED_BIN` | Override the bundled `cloudflared` executable. |
| `CODEX_BIN` | Path to a non-standard Codex CLI installation. |
| `CURSOR_BIN` | Path to a non-standard Cursor CLI installation. |
| `CLAUDE_BIN` | Path to a non-standard Claude Code CLI installation. |
| `WORKSTATION_CWD` | Default working directory for source-wide task creation. |
| `CODEX_HOME` | Override the Codex state directory. |
| `CLAUDE_PROJECTS_DIR` | Override the Claude Code transcript directory. |

## Security boundary

The HTTP relay binds only to loopback. Remote access is provided by a temporary HTTPS/WSS tunnel and guarded by a random application-level pairing token. The hostname changes after each restart, there is no uptime guarantee, and anyone who obtains the full URL can attempt to access the endpoint.

This is not production authentication or end-to-end encryption. Device keys, signed commands, encrypted envelopes, and a persistent replay ledger are not implemented yet. See [Security](docs/security.md) for the current trust model.

## Release builds

### Windows portable ZIP

Build on the target Windows architecture:

```powershell
npm run build:win
```

The result is `release/AI-Workstation-Remote-<version>-windows-<arch>.zip`. It includes Node.js, the built services and Web UI, the bundled x64 `cloudflared.exe`, the Cursor relay, and the Windows input helper. Windows ARM64 builds require Windows 11's x64 compatibility layer. Extract the full directory and run `AI-Workstation-Remote.cmd`.

### macOS app and installer

Build on the target Mac architecture:

```bash
npm run build:mac
```

This creates a self-contained app and PKG in `release/`. The default build is ad-hoc signed. Set `BUILD_DMG=1` for a DMG. Public distribution additionally requires `MACOS_SIGN_IDENTITY`, `MACOS_INSTALLER_IDENTITY`, and `NOTARYTOOL_PROFILE`.

## Repository layout

```text
apps/mobile/                    Mobile-first React PWA
apps/mac-companion/             Cross-platform workstation adapter host
apps/cursor-relay-extension/    Local Cursor fallback relay
packages/protocol/              Shared event and command contracts
services/control-plane/         Loopback WebSocket relay and Web server
scripts/                        Setup, verification, tunnel, and packaging tools
packaging/                      Native macOS and Windows launchers
docs/                           Architecture, security, and product notes
docs/readme/                    Localized README overviews
licenses/                       Generated npm license inventory and notices
vendor/cloudflared/             Pinned platform tunnel archives and license
```

More detail is available in [Architecture](docs/architecture.md), [Security](docs/security.md), the [open-source whitepaper](docs/open-source-whitepaper.md), and [product strategy](docs/product-strategy.md).

## Contributing

Bug reports, documentation fixes, tests, and focused pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a substantial change. Please follow the [Code of Conduct](CODE_OF_CONDUCT.md), and report vulnerabilities through the private process in [SECURITY.md](SECURITY.md), not a public issue.

## License

Project-authored code and documentation are available under the [MIT License](LICENSE). Bundled and linked third-party components retain their own licenses, copyright notices, and trademarks; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the generated inventory under [`licenses/`](licenses/README.md).

Codex, Cursor, Claude, Claude Code, Cloudflare, macOS, Windows, and other product names belong to their respective owners. Their mention describes compatibility and does not imply affiliation or endorsement. See [DISCLAIMER.md](DISCLAIMER.md) for the project's operational and product-name disclaimers.
