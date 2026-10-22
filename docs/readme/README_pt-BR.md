<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · **Português (Brasil)** · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md) · [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md)

# AI Workstation Remote

### Controle sessões locais de programação com IA por qualquer navegador confiável

</div>

## Capturas de tela

<p align="center">
  <img src="../images/workbench.jpg" alt="AI Workstation Remote workbench" width="30%">
  <img src="../images/task-conversation.jpg" alt="AI Workstation Remote task conversation" width="30%">
</p>

AI Workstation Remote é uma camada de controle Web local e neutra em relação ao fornecedor. Ela exibe sessões reais do Codex, Cursor e Claude Code executadas no macOS ou Windows no navegador de um celular, tablet, notebook ou outro dispositivo confiável. Ela envia à estação de trabalho mensagens, solicitações de parada e aprovações compatíveis. Não é uma solução de área de trabalho remota nem um shell remoto de uso geral.

> [!WARNING]
> Este projeto é um protótipo em desenvolvimento. O Cloudflare Quick Tunnel incluído serve para desenvolvimento e testes, não para repositórios sensíveis ou produção.

Este é um resumo traduzido. O [README em inglês](../../README.md) é a referência para o comportamento completo, a configuração e os limites de segurança atuais.

## Início rápido

Requer macOS (Apple Silicon ou Intel) ou Windows 10/11, Node.js 22.5+ e pelo menos um cliente local compatível.

```bash
caffeinate -i ./run.sh
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\run.ps1
```

O iniciador compila a interface, inicia o relay e o Companion, cria um túnel temporário e mostra uma URL acessível por outros dispositivos. Mantenha o terminal aberto; `Ctrl+C` encerra os serviços e invalida a URL pública. O endereço local padrão é `http://127.0.0.1:8787`.

## Integrações

- **Codex**: app-server, CLI oficial e Desktop IPC quando disponível.
- **Cursor**: leitura do armazenamento local; Desktop Bridge ou extensão relay local.
- **Claude Code**: leitura do histórico JSONL e continuação pela CLI instalada.

As credenciais dos modelos ficam na estação. Quando o controle de gravação não pode ser obtido com segurança, a sessão permanece somente leitura.

## Desenvolvimento

```bash
npm install
npm run dev
npm test
npm run typecheck
```

## Segurança e licença

O acesso remoto atual usa um túnel HTTPS/WSS temporário e um bearer token aleatório na URL. Identidade de dispositivo, comandos assinados e criptografia de ponta a ponta para produção ainda não foram implementados. Consulte a [política de segurança](../../SECURITY.md) e o [modelo de segurança](../security.md).

O código e a documentação do projeto usam a [licença MIT](../../LICENSE). Componentes de terceiros mantêm suas próprias licenças; consulte os [avisos](../../THIRD_PARTY_NOTICES.md), o [guia de contribuição](../../CONTRIBUTING.md) e o [código de conduta](../../CODE_OF_CONDUCT.md).
