<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · **한국어** · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md) · [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md)

# AI Workstation Remote

### 모든 신뢰할 수 있는 기기의 브라우저에서 로컬 AI 코딩 세션 제어

</div>

## 스크린샷

<p align="center">
  <img src="../images/workbench.jpg" alt="AI Workstation Remote workbench" width="30%">
  <img src="../images/task-conversation.jpg" alt="AI Workstation Remote task conversation" width="30%">
</p>

AI Workstation Remote는 macOS 또는 Windows에서 실행 중인 실제 Codex, Cursor, Claude Code 세션을 휴대폰, 태블릿, 노트북이나 다른 신뢰할 수 있는 기기의 브라우저에 표시하는 로컬 우선의 공급업체 중립적 제어 계층입니다. 지원되는 메시지, 중지 요청, 승인 결정을 워크스테이션으로 보낼 수 있습니다. 원격 데스크톱이나 범용 원격 셸은 아닙니다.

> [!WARNING]
> 이 프로젝트는 개발 중인 프로토타입입니다. 포함된 Cloudflare Quick Tunnel은 개발 및 테스트 전용이며 민감한 저장소나 프로덕션 작업에 적합하지 않습니다.

이 문서는 현지화된 개요입니다. 전체 동작, 설정, 최신 보안 경계는 [영문 README](../../README.md)를 기준으로 합니다.

## 빠른 시작

macOS(Apple Silicon 또는 Intel)나 Windows 10/11, Node.js 22.5 이상, 지원되는 로컬 클라이언트 하나 이상이 필요합니다.

```bash
./run.sh
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\run.ps1
```

런처는 Web UI, 로컬 릴레이와 Companion을 시작하고 임시 터널을 만든 뒤 다른 기기에서 사용할 수 있는 URL을 표시합니다. 터미널을 계속 실행해야 하며 `Ctrl+C`를 누르면 서비스와 공개 URL이 종료됩니다. 기본 로컬 주소는 `http://127.0.0.1:8787`입니다.

## 지원 통합

- **Codex**: app-server, 공식 CLI, 가능한 경우 Desktop IPC를 사용합니다.
- **Cursor**: 로컬 세션 저장소를 읽기 전용으로 확인하고 Desktop Bridge 또는 로컬 릴레이 확장을 사용합니다.
- **Claude Code**: 로컬 JSONL 기록을 읽고 설치된 CLI로 기존 세션을 계속합니다.

모델 자격 증명은 워크스테이션에 남습니다. 안전하게 쓰기 권한을 얻을 수 없으면 세션은 읽기 전용으로 유지됩니다.

## 로컬 개발

```bash
npm install
npm run dev
npm test
npm run typecheck
```

## 보안 및 라이선스

현재 원격 모드는 임시 HTTPS/WSS 터널과 URL의 무작위 bearer token을 사용합니다. 프로덕션 수준의 장치 ID, 서명된 명령, 종단 간 암호화는 아직 구현되지 않았습니다. [보안 정책](../../SECURITY.md)과 [보안 모델](../security.md)을 읽어 주세요.

프로젝트가 작성한 코드와 문서는 [MIT License](../../LICENSE)를 따릅니다. 제3자 구성 요소는 각자의 라이선스를 유지합니다. [제3자 고지](../../THIRD_PARTY_NOTICES.md), [기여 가이드](../../CONTRIBUTING.md), [행동 강령](../../CODE_OF_CONDUCT.md)을 참조하세요.
