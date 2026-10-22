<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · **Tiếng Việt** · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md) · [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md)

# AI Workstation Remote

### Điều khiển các phiên lập trình AI cục bộ từ mọi trình duyệt đáng tin cậy

</div>

## Ảnh chụp màn hình

<p align="center">
  <img src="../images/workbench.jpg" alt="AI Workstation Remote workbench" width="30%">
  <img src="../images/task-conversation.jpg" alt="AI Workstation Remote task conversation" width="30%">
</p>

AI Workstation Remote là lớp điều khiển Web local-first và trung lập với nhà cung cấp. Nó hiển thị các phiên Codex, Cursor và Claude Code thực đang chạy trên macOS hoặc Windows trong trình duyệt của điện thoại, máy tính bảng, máy tính xách tay hoặc thiết bị đáng tin cậy khác. Nó gửi các tin nhắn, yêu cầu dừng và quyết định phê duyệt được hỗ trợ trở lại máy trạm. Đây không phải là phần mềm điều khiển màn hình từ xa hay shell từ xa đa dụng.

> [!WARNING]
> Dự án vẫn là nguyên mẫu đang phát triển. Cloudflare Quick Tunnel đi kèm chỉ dành cho phát triển và thử nghiệm, không dành cho kho mã nhạy cảm hoặc môi trường sản xuất.

Đây là bản tổng quan đã dịch. [README tiếng Anh](../../README.md) là tài liệu chuẩn cho hành vi đầy đủ, cấu hình và ranh giới bảo mật mới nhất.

## Khởi động nhanh

Cần macOS (Apple Silicon hoặc Intel) hay Windows 10/11, Node.js 22.5+ và ít nhất một ứng dụng cục bộ được hỗ trợ.

```bash
caffeinate -i ./run.sh
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\run.ps1
```

Trình khởi chạy xây dựng giao diện, chạy relay và Companion, tạo đường hầm tạm thời rồi hiển thị URL truy cập được từ các thiết bị khác. Hãy giữ cửa sổ terminal mở; `Ctrl+C` dừng dịch vụ và vô hiệu URL công khai. Địa chỉ cục bộ mặc định là `http://127.0.0.1:8787`.

## Tích hợp

- **Codex**: app-server, CLI chính thức và Desktop IPC khi có sẵn.
- **Cursor**: đọc kho phiên cục bộ; dùng Desktop Bridge hoặc tiện ích relay cục bộ.
- **Claude Code**: đọc lịch sử JSONL và tiếp tục phiên bằng CLI đã cài.

Thông tin xác thực mô hình ở lại máy trạm. Nếu không thể giành quyền ghi một cách an toàn, phiên sẽ ở chế độ chỉ đọc.

## Phát triển

```bash
npm install
npm run dev
npm test
npm run typecheck
```

## Bảo mật và giấy phép

Truy cập từ xa hiện dùng đường hầm HTTPS/WSS tạm thời và bearer token ngẫu nhiên trong URL. Danh tính thiết bị, lệnh có chữ ký và mã hóa đầu cuối cấp sản xuất chưa được triển khai. Xem [chính sách bảo mật](../../SECURITY.md) và [mô hình bảo mật](../security.md).

Mã nguồn và tài liệu do dự án tạo ra dùng [giấy phép MIT](../../LICENSE). Thành phần bên thứ ba giữ giấy phép riêng; xem [thông báo](../../THIRD_PARTY_NOTICES.md), [hướng dẫn đóng góp](../../CONTRIBUTING.md) và [quy tắc ứng xử](../../CODE_OF_CONDUCT.md).
