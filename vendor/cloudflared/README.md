# Bundled cloudflared

This directory contains compressed `cloudflared` 2026.10.1 archives for macOS
and Windows. Launchers and package builds extract only the current platform's
binary when it is missing, then verify the extracted SHA-256 checksum. No
runtime download is required.

| Archive | Architecture | Extracted SHA-256 | Provenance |
| --- | --- | --- | --- |
| `darwin-amd64/cloudflared.zip` | Intel (`x86_64`) | `8ccc6383aef109c8d88965937649a796febbb166dab4b73345e820623aee1ede` | Cloudflare release binary |
| `darwin-arm64/cloudflared.zip` | Apple Silicon (`arm64`) | `35b7e34c9a3f214d80d859c4223450c69e583c7668d228c45771026fe376cab9` | Cloudflare release binary |
| `windows-amd64/cloudflared.exe.zip` | Windows x64 | `4d2490e74082c5d48dbfedaf92576fa5bd1702379ab88eb7faa0cfbe8dc891b6` | Cloudflare release binary |

Extracted binaries are intentionally ignored by Git. Delete the extracted file
to make the next source launcher or package build restore it from the archive.

Cloudflare does not publish a native Windows ARM64 executable for this release.
Windows 11 ARM can run the bundled x64 executable through its compatibility
layer.

The upstream project is <https://github.com/cloudflare/cloudflared>. Its
Apache 2.0 license is included in `LICENSE`.
