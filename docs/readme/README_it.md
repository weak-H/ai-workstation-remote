<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · **Italiano** · [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md)

# AI Workstation Remote

### Controlla le sessioni locali di programmazione IA da qualsiasi browser attendibile

</div>

## Schermate

<p align="center">
  <img src="../images/workbench.jpg" alt="AI Workstation Remote workbench" width="30%">
  <img src="../images/task-conversation.jpg" alt="AI Workstation Remote task conversation" width="30%">
</p>

AI Workstation Remote è un livello di controllo Web locale e indipendente dal fornitore. Mostra le vere sessioni Codex, Cursor e Claude Code in esecuzione su macOS o Windows nel browser di un telefono, tablet, portatile o altro dispositivo attendibile. Invia alla workstation messaggi, richieste di arresto e approvazioni supportate. Non è un desktop remoto né una shell remota generica.

> [!WARNING]
> Il progetto è un prototipo in sviluppo. Il Cloudflare Quick Tunnel incluso è adatto a sviluppo e test, non a repository sensibili o carichi di produzione.

Questa è una panoramica tradotta. Il [README inglese](../../README.md) è il riferimento per comportamento completo, configurazione e limiti di sicurezza aggiornati.

## Avvio rapido

Servono macOS (Apple Silicon o Intel) o Windows 10/11, Node.js 22.5+ e almeno un client locale supportato.

```bash
./run.sh
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\run.ps1
```

Il launcher crea l'interfaccia, avvia relay e Companion, apre un tunnel temporaneo e mostra un URL accessibile da altri dispositivi. Mantieni aperto il terminale; `Ctrl+C` arresta i servizi e invalida l'URL pubblico. L'indirizzo locale predefinito è `http://127.0.0.1:8787`.

## Integrazioni

- **Codex**: app-server, CLI ufficiale e Desktop IPC quando disponibile.
- **Cursor**: accesso in sola lettura ai dati locali; Desktop Bridge o estensione relay locale.
- **Claude Code**: lettura della cronologia JSONL e ripresa con la CLI installata.

Le credenziali dei modelli restano sulla workstation. Se il controllo in scrittura non può essere acquisito in sicurezza, la sessione resta in sola lettura.

## Sviluppo

```bash
npm install
npm run dev
npm test
npm run typecheck
```

## Sicurezza e licenza

L'accesso remoto attuale usa un tunnel HTTPS/WSS temporaneo e un bearer token casuale nell'URL. Identità del dispositivo, comandi firmati e cifratura end-to-end da produzione non sono ancora implementati. Consulta la [politica di sicurezza](../../SECURITY.md) e il [modello di sicurezza](../security.md).

Codice e documentazione del progetto usano la [licenza MIT](../../LICENSE). I componenti di terze parti conservano le proprie licenze; consulta gli [avvisi](../../THIRD_PARTY_NOTICES.md), la [guida ai contributi](../../CONTRIBUTING.md) e il [codice di condotta](../../CODE_OF_CONDUCT.md).
