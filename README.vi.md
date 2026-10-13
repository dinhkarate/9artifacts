<div align="center">

<img src="web/themes/default/logo.svg" width="64" alt="vitrine">

# vitrine

**Artifact kiểu Claude, chạy trên VPS của bạn.**

[English](README.md) · Tiếng Việt

</div>

AI agent (Claude Code, Codex, Cursor…) tạo ra rất nhiều dashboard, báo cáo, sơ đồ. Vitrine là nơi
lưu chúng **trên server của bạn**:

- **Riêng tư mặc định.** Đăng nhập bằng passkey. Link công khai **luôn có hạn** (1 giờ đến 30 ngày)
  và thu hồi được.
- **Cho agent dùng thẳng.** Có sẵn MCP server, CLI và skill (`npx skills add dinhkarate/vitrine`).
  Agent publish xong trả về link riêng tư cho bạn.
- **Trải nghiệm giống Claude.** Viewer full màn hình chạy trong sandbox, có lịch sử phiên bản.
  Agent sửa xong thì tab đang mở **tự cập nhật**.
- **Phong cách của bạn.** Agent đọc `design.md` trước khi viết, nên artifact nào cũng theo đúng
  style của bạn. Giao diện app đổi theme được, và có thể nhờ AI thiết kế lại theme.
- **Siêu nhẹ.** Một binary Go khoảng 10 MB, RAM khoảng 10 MB, tự lấy chứng chỉ HTTPS. Chạy tốt
  trên VPS 1 CPU / 512 MB hoặc VM miễn phí.

## Cài nhanh

```bash
curl -fsSL https://raw.githubusercontent.com/dinhkarate/vitrine/main/install.sh \
  | sudo sh -s -- --domain art.example.com --content-domain art-content.example.com --email ban@example.com
```

Mở link "first run" in ra trong log, đặt mật khẩu, thêm passkey, rồi vào **Settings → Connect an AI
agent** để lấy lệnh kết nối Claude Code:

```bash
claude mcp add --transport http vitrine https://art.example.com/mcp --header "Authorization: Bearer vt_..."
```

Muốn chạy **miễn phí**: máy của bạn + Tailscale (HTTPS `*.ts.net` free, không cần domain)
hoặc Cloudflare Tunnel, hay Oracle Cloud Always Free, Google Cloud `e2-micro`. Xem
[docs/deploy.md](docs/deploy.md#free-hosting).

Tài liệu đầy đủ (bảo mật, API, theme) nằm trong [README tiếng Anh](README.md).
