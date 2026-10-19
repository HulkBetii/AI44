# Mail Automation Operator Console

Local Windows operator console for the Hotmail to ElevenLabs automation pipeline.

## Requirements

- Node.js 24+
- GPM Login running on the configured local API port
- `service-account.json` with access to the configured Google Sheet

## Run

```powershell
npm install
npm run dev
```

Open `http://127.0.0.1:5173`. For a production build:

```powershell
npm run build
npm start
```

The production console is served at `http://127.0.0.1:4317`.

## Configuration

Copy `config.example.json` to `config.local.json` and adjust the local paths. Environment variables override the file:

- `MAIL_TEMP_SHEET_ID`
- `MAIL_TEMP_SHEET_NAME`
- `GOOGLE_SERVICE_ACCOUNT_PATH`
- `GPM_API_BASE`
- `MAIL_TEMP_DEFAULT_INTERVAL`
- `MAIL_TEMP_RUNTIME_DIR`

Job history, redacted logs and screenshots are stored under `.runtime/`. Account data remains in Google Sheet.

## Tests

```powershell
npm test
npm run build
```

The original CLI remains available:

```powershell
node signup-hotmail.js --row=25
npm run batch -- --limit=10
```

The UI and CLI share an exclusive automation lock, so they cannot control GPM at the same time.

## Phiên Bản (Version History)

- **v1.0 (Commit `a34abcf`):**
  - Khởi tạo luồng Catch-All Domain Email cho ElevenLabs với xác thực tự động qua Gmail IMAP.
  - Hỗ trợ đa luồng (Multi-Worker Concurrency) và cơ chế khóa tiến trình (Automation Lock).
  - Lấy API Key qua phương thức điều hướng giao diện DOM truyền thống.

- **v2.0 (Phiên Bản Hiện Tại - Work In Progress):**
  - **Tích hợp Proxy Xoay IPv4 (`proxyxoay.shop` / `topproxy.vn`):** Tự động điều phối thời gian xoay IP (cooldown 60s) và khóa Mutex chống xung đột luồng.
  - **Kỹ thuật Bắt Gói Tin Mạng (Bearer Token Network Interception):** Thay thế toàn bộ 14 thao tác DOM lấy key cũ, bắt trực tiếp Bearer token trong `< 1s` ngay khi đăng nhập.
  - **Tiện ích Xuất Dữ Liệu:** Hỗ trợ xuất linh hoạt qua `npm run export:catchall` và `npm run export:new`.

