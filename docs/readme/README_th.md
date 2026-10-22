<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · **ไทย** · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md) · [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md)

# AI Workstation Remote

### ควบคุมเซสชันเขียนโค้ด AI ในเครื่องจากเบราว์เซอร์ที่เชื่อถือได้ทุกอุปกรณ์

</div>

## ภาพหน้าจอ

<p align="center">
  <img src="../images/workbench.jpg" alt="AI Workstation Remote workbench" width="30%">
  <img src="../images/task-conversation.jpg" alt="AI Workstation Remote task conversation" width="30%">
</p>

AI Workstation Remote เป็นชั้นควบคุม Web แบบ local-first และไม่ผูกกับผู้ให้บริการ ซึ่งแสดงเซสชัน Codex, Cursor และ Claude Code จริงจาก macOS หรือ Windows ในเบราว์เซอร์ของโทรศัพท์ แท็บเล็ต แล็ปท็อป หรืออุปกรณ์ที่เชื่อถือได้อื่น และส่งข้อความ คำขอหยุด และการอนุมัติที่รองรับกลับไปยังเวิร์กสเตชัน โครงการนี้ไม่ใช่รีโมตเดสก์ท็อปหรือ remote shell สำหรับใช้งานทั่วไป

> [!WARNING]
> โครงการนี้ยังเป็นต้นแบบที่กำลังพัฒนา Cloudflare Quick Tunnel ที่ให้มาสำหรับการพัฒนาและทดสอบเท่านั้น ไม่เหมาะกับคลังโค้ดที่ละเอียดอ่อนหรืองานจริง

เอกสารนี้เป็นภาพรวมฉบับแปล โปรดใช้ [README ภาษาอังกฤษ](../../README.md) เป็นข้อมูลหลักสำหรับพฤติกรรมทั้งหมด การตั้งค่า และขอบเขตความปลอดภัยล่าสุด

## เริ่มต้นอย่างรวดเร็ว

ต้องใช้ macOS (Apple Silicon หรือ Intel) หรือ Windows 10/11, Node.js 22.5+ และไคลเอนต์ในเครื่องที่รองรับอย่างน้อยหนึ่งรายการ

```bash
./run.sh
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\run.ps1
```

ตัวเริ่มระบบจะสร้าง UI เปิด relay และ Companion สร้าง tunnel ชั่วคราว และแสดง URL ที่เข้าถึงได้จากอุปกรณ์อื่น โปรดเปิดเทอร์มินัลไว้; `Ctrl+C` จะหยุดบริการและทำให้ URL สาธารณะใช้ไม่ได้ ที่อยู่ในเครื่องเริ่มต้นคือ `http://127.0.0.1:8787`

## การเชื่อมต่อ

- **Codex**: app-server, CLI ทางการ และ Desktop IPC เมื่อพร้อมใช้
- **Cursor**: อ่านที่เก็บเซสชันในเครื่อง; ใช้ Desktop Bridge หรือส่วนขยาย relay ในเครื่อง
- **Claude Code**: อ่านประวัติ JSONL และดำเนินเซสชันต่อด้วย CLI ที่ติดตั้งไว้

ข้อมูลรับรองโมเดลจะอยู่บนเวิร์กสเตชัน หากไม่สามารถรับสิทธิ์เขียนได้อย่างปลอดภัย เซสชันจะเป็นแบบอ่านอย่างเดียว

## การพัฒนา

```bash
npm install
npm run dev
npm test
npm run typecheck
```

## ความปลอดภัยและสัญญาอนุญาต

การเข้าถึงระยะไกลปัจจุบันใช้ HTTPS/WSS tunnel ชั่วคราวและ bearer token แบบสุ่มใน URL ยังไม่มีข้อมูลประจำตัวอุปกรณ์ คำสั่งที่ลงนาม และการเข้ารหัสตั้งแต่ต้นทางถึงปลายทางระดับใช้งานจริง โปรดอ่าน[นโยบายความปลอดภัย](../../SECURITY.md)และ[แบบจำลองความปลอดภัย](../security.md)

โค้ดและเอกสารของโครงการใช้ [MIT License](../../LICENSE) ส่วนประกอบบุคคลที่สามคงสัญญาอนุญาตของตนเอง ดู[ประกาศบุคคลที่สาม](../../THIRD_PARTY_NOTICES.md) [คู่มือการมีส่วนร่วม](../../CONTRIBUTING.md) และ[หลักปฏิบัติ](../../CODE_OF_CONDUCT.md)
