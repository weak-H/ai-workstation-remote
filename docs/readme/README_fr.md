<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · **Français** · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md) · [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md)

# AI Workstation Remote

### Pilotez les sessions locales de programmation IA depuis tout navigateur de confiance

</div>

## Captures d’écran

<p align="center">
  <img src="../images/workbench.jpg" alt="AI Workstation Remote workbench" width="30%">
  <img src="../images/task-conversation.jpg" alt="AI Workstation Remote task conversation" width="30%">
</p>

AI Workstation Remote est une couche de contrôle Web locale et indépendante des fournisseurs. Elle affiche les véritables sessions Codex, Cursor et Claude Code exécutées sous macOS ou Windows dans le navigateur d'un téléphone, d'une tablette, d'un ordinateur portable ou d'un autre appareil de confiance. Elle renvoie à la station de travail les messages, demandes d'arrêt et validations pris en charge. Ce n'est ni un bureau à distance ni un shell distant généraliste.

> [!WARNING]
> Ce projet est un prototype en développement. Le Cloudflare Quick Tunnel inclus convient au développement et aux tests, pas aux dépôts sensibles ni aux usages de production.

Cette page est un résumé traduit. Le [README anglais](../../README.md) reste la référence pour le comportement complet, la configuration et les limites de sécurité à jour.

## Démarrage rapide

Il faut macOS (Apple Silicon ou Intel) ou Windows 10/11, Node.js 22.5+ et au moins un client local pris en charge.

```bash
./run.sh
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\run.ps1
```

Le lanceur construit l'interface, démarre le relais et le Companion, crée un tunnel temporaire et affiche une URL accessible depuis d'autres appareils. Gardez le terminal ouvert ; `Ctrl+C` arrête les services et invalide l'URL publique. L'adresse locale par défaut est `http://127.0.0.1:8787`.

## Intégrations

- **Codex** : app-server, CLI officielle et Desktop IPC lorsque disponible.
- **Cursor** : lecture seule du stockage local ; Desktop Bridge ou extension relais locale.
- **Claude Code** : lecture de l'historique JSONL et reprise via la CLI installée.

Les identifiants des modèles restent sur la station. Si le contrôle en écriture ne peut pas être acquis en sécurité, la session reste en lecture seule.

## Développement

```bash
npm install
npm run dev
npm test
npm run typecheck
```

## Sécurité et licence

L'accès distant actuel utilise un tunnel HTTPS/WSS temporaire et un bearer token aléatoire dans l'URL. L'identité des appareils, les commandes signées et le chiffrement de bout en bout de niveau production ne sont pas encore implémentés. Consultez la [politique de sécurité](../../SECURITY.md) et le [modèle de sécurité](../security.md).

Le code et la documentation du projet sont sous [licence MIT](../../LICENSE). Les composants tiers conservent leurs licences ; consultez les [avis tiers](../../THIRD_PARTY_NOTICES.md), le [guide de contribution](../../CONTRIBUTING.md) et le [code de conduite](../../CODE_OF_CONDUCT.md).
