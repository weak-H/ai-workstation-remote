<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md) · [Ελληνικά](README_el.md) · **മലയാളം**

# AI Workstation Remote

### വിശ്വസനീയമായ ഏത് ബ്രൗസറിൽ നിന്നും ലോക്കൽ AI കോഡിംഗ് സെഷനുകൾ നിയന്ത്രിക്കുക

</div>

## സ്ക്രീൻഷോട്ടുകൾ

<p align="center">
  <img src="../images/workbench.jpg" alt="AI Workstation Remote workbench" width="30%">
  <img src="../images/task-conversation.jpg" alt="AI Workstation Remote task conversation" width="30%">
</p>

macOS അല്ലെങ്കിൽ Windows-ൽ പ്രവർത്തിക്കുന്ന യഥാർത്ഥ Codex, Cursor, Claude Code സെഷനുകൾ ഫോൺ, ടാബ്‌ലെറ്റ്, ലാപ്‌ടോപ്പ് അല്ലെങ്കിൽ മറ്റൊരു വിശ്വസനീയമായ ഉപകരണത്തിന്റെ ബ്രൗസറിൽ കാണിക്കുന്ന local-first, vendor-neutral Web നിയന്ത്രണ പാളിയാണ് AI Workstation Remote. പിന്തുണയ്ക്കുന്ന സന്ദേശങ്ങൾ, നിർത്തൽ അഭ്യർത്ഥനകൾ, അനുമതികൾ എന്നിവ വർക്ക്‌സ്റ്റേഷനിലേക്ക് അയയ്ക്കാം. ഇത് റിമോട്ട് ഡെസ്ക്ടോപ്പോ പൊതുവായ remote shell-ഓ അല്ല.

> [!WARNING]
> ഈ പ്രോജക്റ്റ് വികസനത്തിലുള്ള പ്രോട്ടോടൈപ്പാണ്. ഉൾപ്പെടുത്തിയ Cloudflare Quick Tunnel വികസനത്തിനും പരിശോധനയ്ക്കുമുള്ളതാണ്; രഹസ്യ repository-കൾക്കോ production ഉപയോഗത്തിനോ വേണ്ടിയല്ല.

ഇത് പരിഭാഷപ്പെടുത്തിയ സംഗ്രഹമാണ്. പൂർണ്ണമായ പ്രവർത്തനം, ക്രമീകരണം, പുതിയ സുരക്ഷാ പരിധികൾ എന്നിവയ്ക്ക് [ഇംഗ്ലീഷ് README](../../README.md) ആണ് ആധികാരിക രേഖ.

## വേഗത്തിൽ തുടങ്ങുക

macOS (Apple Silicon അല്ലെങ്കിൽ Intel) അല്ലെങ്കിൽ Windows 10/11, Node.js 22.5+, പിന്തുണയ്ക്കുന്ന ഒരു ലോക്കൽ client എങ്കിലും ആവശ്യമാണ്.

```bash
caffeinate -i ./run.sh
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\run.ps1
```

Launcher UI നിർമ്മിച്ച് relay, Companion എന്നിവ ആരംഭിക്കുകയും താൽക്കാലിക tunnel സൃഷ്ടിച്ച് മറ്റ് ഉപകരണങ്ങളിൽ നിന്ന് ഉപയോഗിക്കാവുന്ന URL കാണിക്കുകയും ചെയ്യും. Terminal തുറന്നുവയ്ക്കുക; `Ctrl+C` സേവനങ്ങൾ നിർത്തി public URL അസാധുവാക്കും. സ്വതവേയുള്ള local വിലാസം `http://127.0.0.1:8787` ആണ്.

## സംയോജനങ്ങൾ

- **Codex**: app-server, ഔദ്യോഗിക CLI, ലഭ്യമെങ്കിൽ Desktop IPC.
- **Cursor**: ലോക്കൽ session store വായിക്കുന്നു; Desktop Bridge അല്ലെങ്കിൽ ലോക്കൽ relay extension.
- **Claude Code**: JSONL ചരിത്രം വായിച്ച് ഇൻസ്റ്റാൾ ചെയ്ത CLI വഴി session തുടരുന്നു.

Model credentials വർക്ക്‌സ്റ്റേഷനിൽ തന്നെ തുടരും. എഴുത്ത് നിയന്ത്രണം സുരക്ഷിതമായി ലഭിക്കാത്തപ്പോൾ session read-only ആയി തുടരും.

## വികസനം

```bash
npm install
npm run dev
npm test
npm run typecheck
```

## സുരക്ഷയും ലൈസൻസും

നിലവിലെ remote access താൽക്കാലിക HTTPS/WSS tunnel-ഉം URL-യിലെ random bearer token-ഉം ഉപയോഗിക്കുന്നു. Production നിലവാരത്തിലുള്ള device identity, signed commands, end-to-end encryption എന്നിവ ഇതുവരെ നടപ്പാക്കിയിട്ടില്ല. [സുരക്ഷാ നയം](../../SECURITY.md), [സുരക്ഷാ മാതൃക](../security.md) എന്നിവ വായിക്കുക.

പ്രോജക്റ്റ് കോഡും രേഖകളും [MIT License](../../LICENSE) പ്രകാരമാണ്. Third-party ഘടകങ്ങൾക്ക് അവയുടെ സ്വന്തം ലൈസൻസുകൾ ബാധകമാണ്; [അറിയിപ്പുകൾ](../../THIRD_PARTY_NOTICES.md), [സംഭാവന മാർഗ്ഗരേഖ](../../CONTRIBUTING.md), [പെരുമാറ്റച്ചട്ടം](../../CODE_OF_CONDUCT.md) എന്നിവ കാണുക.
