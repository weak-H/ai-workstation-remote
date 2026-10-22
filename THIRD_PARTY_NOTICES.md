# Third-party notices

AI Workstation Remote-authored code and documentation are licensed under the
[MIT License](LICENSE). Third-party software retains its own copyright,
license, attribution, and notice requirements. The project's MIT license does
not relicense those components.

Product and project names identify compatible integrations. They do not imply
affiliation, sponsorship, or endorsement.

## Distributed components

| Component | How it is used | License records |
| --- | --- | --- |
| `cloudflared` 2026.10.1 | Official upstream binaries are checked in for macOS Intel, macOS Apple Silicon, and Windows x64. | Apache-2.0. See [`vendor/cloudflared/README.md`](vendor/cloudflared/README.md) for provenance and hashes and [`vendor/cloudflared/LICENSE`](vendor/cloudflared/LICENSE) for the full license. |
| Node.js | Release builds copy the build host's Node.js runtime. The exact Node version is therefore recorded by the release environment rather than pinned here. | Node.js is MIT-licensed and includes third-party component notices. The build copies the runtime's own `LICENSE` into each release. |
| npm dependencies | JavaScript dependencies are bundled into the Web UI and local services. | Run `npm run licenses` after `npm install` to refresh [`licenses/npm-dependencies.md`](licenses/npm-dependencies.md) and [`licenses/npm-notices.txt`](licenses/npm-notices.txt) from the locked dependency tree. |
| AI Workstation Cursor Relay | Project-authored extension packaged with releases. | MIT, under the repository's root [`LICENSE`](LICENSE). |

## External integrations

Codex, Cursor, and Claude Code are separately installed products and are not
licensed or distributed by this repository. Users must obtain and use them
under their vendors' applicable terms. AI Workstation Remote provides no
account, subscription, API key, model entitlement, or license for those
products.

Cloudflare Quick Tunnels are provided by Cloudflare and remain subject to
Cloudflare's applicable service terms. The bundled `cloudflared` executable's
open-source license does not grant a right to use the hosted tunnel service on
different terms.

## Redistributing releases

Keep the root MIT license, this document, the generated npm notices, the
bundled `cloudflared` Apache-2.0 license, and the Node.js license shipped by the
build. If you add or replace a bundled component, review the material actually
distributed and preserve all required license, copyright, NOTICE, source, and
modification records.
