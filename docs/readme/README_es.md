<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · **Español** · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md) · [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md)

# AI Workstation Remote

### Controla sesiones locales de programación con IA desde cualquier navegador de confianza

</div>

## Capturas de pantalla

<p align="center">
  <img src="../images/workbench.jpg" alt="AI Workstation Remote workbench" width="30%">
  <img src="../images/task-conversation.jpg" alt="AI Workstation Remote task conversation" width="30%">
</p>

AI Workstation Remote es una capa de control Web local y neutral respecto al proveedor. Muestra sesiones reales de Codex, Cursor y Claude Code ejecutadas en macOS o Windows en el navegador de un teléfono, tableta, portátil u otro dispositivo de confianza. Permite devolver mensajes, solicitudes de detención y aprobaciones compatibles a la estación de trabajo. No es un escritorio remoto ni un shell remoto de uso general.

> [!WARNING]
> Este proyecto es un prototipo en desarrollo. El Cloudflare Quick Tunnel incluido sirve para desarrollo y pruebas, no para repositorios sensibles ni cargas de producción.

Este documento es un resumen traducido. La [README en inglés](../../README.md) es la referencia para el comportamiento completo, la configuración y los límites de seguridad vigentes.

## Inicio rápido

Se requiere macOS (Apple Silicon o Intel) o Windows 10/11, Node.js 22.5+ y al menos un cliente local compatible.

```bash
caffeinate -i ./run.sh
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\run.ps1
```

El iniciador construye la interfaz, ejecuta el relay y Companion, crea un túnel temporal y muestra una URL accesible desde otros dispositivos. Mantén abierta la terminal; `Ctrl+C` detiene los servicios e invalida la URL pública. La dirección local predeterminada es `http://127.0.0.1:8787`.

## Integraciones

- **Codex**: app-server, CLI oficial y Desktop IPC cuando está disponible.
- **Cursor**: lectura del almacén local; Desktop Bridge o la extensión relay local.
- **Claude Code**: lectura del historial JSONL y continuación mediante la CLI instalada.

Las credenciales del modelo permanecen en la estación. Si no puede obtenerse control de escritura con seguridad, la sesión queda en modo de solo lectura.

## Desarrollo

```bash
npm install
npm run dev
npm test
npm run typecheck
```

## Seguridad y licencia

El acceso remoto actual usa un túnel HTTPS/WSS temporal y un bearer token aleatorio en la URL. Aún no incorpora identidad de dispositivo, órdenes firmadas ni cifrado de extremo a extremo para producción. Consulta la [política de seguridad](../../SECURITY.md) y el [modelo de seguridad](../security.md).

El código y la documentación propios usan la [licencia MIT](../../LICENSE). Los componentes de terceros conservan sus licencias; consulta los [avisos de terceros](../../THIRD_PARTY_NOTICES.md), la [guía de contribución](../../CONTRIBUTING.md) y el [código de conducta](../../CODE_OF_CONDUCT.md).
