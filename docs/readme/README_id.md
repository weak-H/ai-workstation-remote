<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · **Bahasa Indonesia** · [Italiano](README_it.md) · [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md)

# AI Workstation Remote

### Kendalikan sesi coding AI lokal dari browser tepercaya mana pun

</div>

## Tangkapan layar

<p align="center">
  <img src="../images/workbench.jpg" alt="AI Workstation Remote workbench" width="30%">
  <img src="../images/task-conversation.jpg" alt="AI Workstation Remote task conversation" width="30%">
</p>

AI Workstation Remote adalah lapisan kendali Web local-first yang netral terhadap vendor. Sesi Codex, Cursor, dan Claude Code nyata dari macOS atau Windows ditampilkan dalam browser ponsel, tablet, laptop, atau perangkat tepercaya lainnya. Pesan, permintaan berhenti, dan keputusan persetujuan yang didukung dikirim kembali ke workstation. Ini bukan desktop jarak jauh atau shell jarak jauh serbaguna.

> [!WARNING]
> Proyek ini masih berupa prototipe aktif. Cloudflare Quick Tunnel yang disertakan hanya untuk pengembangan dan pengujian, bukan untuk repositori sensitif atau beban produksi.

Dokumen ini adalah ringkasan terjemahan. [README bahasa Inggris](../../README.md) menjadi acuan untuk perilaku lengkap, konfigurasi, dan batas keamanan terbaru.

## Mulai cepat

Memerlukan macOS (Apple Silicon atau Intel) atau Windows 10/11, Node.js 22.5+, dan setidaknya satu klien lokal yang didukung.

```bash
./run.sh
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\run.ps1
```

Peluncur membangun UI, menjalankan relay dan Companion, membuat tunnel sementara, lalu menampilkan URL yang dapat diakses dari perangkat lain. Biarkan terminal tetap terbuka; `Ctrl+C` menghentikan layanan dan membatalkan URL publik. Alamat lokal bawaan adalah `http://127.0.0.1:8787`.

## Integrasi

- **Codex**: app-server, CLI resmi, dan Desktop IPC jika tersedia.
- **Cursor**: membaca penyimpanan sesi lokal; Desktop Bridge atau ekstensi relay lokal.
- **Claude Code**: membaca riwayat JSONL dan melanjutkan sesi melalui CLI terpasang.

Kredensial model tetap berada di workstation. Jika kendali tulis tidak dapat diperoleh dengan aman, sesi tetap hanya-baca.

## Pengembangan

```bash
npm install
npm run dev
npm test
npm run typecheck
```

## Keamanan dan lisensi

Akses jarak jauh saat ini memakai tunnel HTTPS/WSS sementara dan bearer token acak pada URL. Identitas perangkat, perintah bertanda tangan, dan enkripsi ujung-ke-ujung tingkat produksi belum diterapkan. Baca [kebijakan keamanan](../../SECURITY.md) dan [model keamanan](../security.md).

Kode dan dokumentasi proyek menggunakan [Lisensi MIT](../../LICENSE). Komponen pihak ketiga mempertahankan lisensinya masing-masing; lihat [pemberitahuan](../../THIRD_PARTY_NOTICES.md), [panduan kontribusi](../../CONTRIBUTING.md), dan [kode etik](../../CODE_OF_CONDUCT.md).
