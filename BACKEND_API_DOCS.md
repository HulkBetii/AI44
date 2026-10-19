# TÀI LIỆU TÍCH HỢP BỘ 3 ROUTER API CHO BACKEND (ELEVENLABS KEY MANAGEMENT)

Tài liệu này cung cấp đặc tả kỹ thuật, schema, mã lỗi và các ví dụ gọi API dành cho đội ngũ Backend tích hợp hệ thống quản lý xoay vòng ElevenLabs API Key / Bearer Token.

---

## 1. TỔNG QUAN HẠ TẦNG & BASE URL

* **Base URL Mặc định:** `http://127.0.0.1:4317` (hoặc cấu hình tùy biến qua biến môi trường).
* **Tiền tố Router:** `/api/keys`
* **Loại Token hỗ trợ:**
  * **JWT Bearer Token** (phiên bản v2.0 Catch-All, chuỗi bắt đầu bằng `eyJhbGciOi...`).
  * **Legacy xi-api-key** (chuỗi `sk_...`).
* **Định dạng dữ liệu:** Chuẩn `application/json; charset=utf-8` (hoặc `text/plain` cho danh sách text).

---

## 2. CHI TIẾT CÁC ENDPOINT

### 🟢 1. POST `/api/keys/check-quota`
> **Mục đích:** Kiểm tra trực tiếp trạng thái sống/chết (valid/invalid), hạn mức quota tổng và số ký tự khả dụng của 1 key trước khi gán task TTS.

* **Method:** `POST`
* **Headers:** `Content-Type: application/json`
* **Request Body:**
  ```json
  {
    "key": "eyJhbGciOiJSUzI1NiIs...",       // (Tùy chọn A) Kiểm tra trực tiếp bằng chuỗi Token/Key
    "email": "zoewilson65239@mrhulkstore.store" // (Tùy chọn B) Hoặc truyền email, hệ thống tự tra cứu key
  }
  ```
  *(Lưu ý: Bắt buộc truyền ít nhất 1 trong 2 trường `key` hoặc `email`).*

* **Response Success (`200 OK` - Key còn sống):**
  ```json
  {
    "success": true,
    "valid": true,
    "tier": "free",
    "characterCount": 0,
    "characterLimit": 10000,
    "remainingCharacters": 10000,
    "status": "free",
    "resetAt": 1791152233,
    "checkedAt": "2026-09-04T11:07:01.731Z"
  }
  ```

* **Response Khi Key Hết Hạn / Chết (`200 OK` - Key Invalid):**
  ```json
  {
    "success": true,
    "valid": false,
    "error": "UNAUTHORIZED_OR_EXPIRED",
    "message": "Token is invalid, expired, or revoked by ElevenLabs",
    "checkedAt": "2026-09-04T11:07:01.731Z"
  }
  ```

* **Ví dụ gọi bằng cURL:**
  ```bash
  curl -X POST http://127.0.0.1:4317/api/keys/check-quota \
    -H "Content-Type: application/json" \
    -d '{"key": "eyJhbGciOiJSUzI1NiIs..."}'
  ```

---

### 🟢 2. GET `/api/keys`
> **Mục đích:** Backend lấy danh sách các key trong kho (từ Google Sheet và bộ nhớ đệm) để nạp vào Pool xoay vòng.

* **Method:** `GET`
* **Query Parameters:**
  | Tham số | Kiểu dữ liệu | Mặc định | Mô tả |
  | :--- | :---: | :---: | :--- |
  | `limit` | `integer` | `50` | Số lượng key cần lấy (tối đa 500). |
  | `offset` | `integer` | `0` | Vị trí bắt đầu lấy (phục vụ phân trang). |
  | `status` | `string` | `"complete"` | Lọc theo trạng thái: `"complete"`, `"pending"`, `"failed"`, `"all"`. |
  | `format` | `string` | `"json"` | Định dạng trả về: `"json"` hoặc `"text"`. |
  | `with_quota` | `boolean` | `false` | Nếu `true`, API sẽ gọi kiểm tra quota live cho từng key trả về. |

#### A. Khi `format=json` (Mặc định):
* **Headers:** `Content-Type: application/json`
* **Response Body (`200 OK`):**
  ```json
  {
    "success": true,
    "total": 42,
    "count": 2,
    "offset": 0,
    "limit": 2,
    "data": [
      {
        "rowIndex": 42,
        "email": "abigailwhite26182@mrhulkstore.store",
        "apiKey": "eyJhbGciOiJSUzI1NiIs...",
        "status": "complete",
        "createdAt": "2026-09-04T10:31:00.000Z"
      },
      {
        "rowIndex": 43,
        "email": "zoewilson65239@mrhulkstore.store",
        "apiKey": "eyJhbGciOiJSUzI1NiIs...",
        "status": "complete",
        "createdAt": "2026-09-04T10:31:00.000Z"
      }
    ]
  }
  ```

#### B. Khi `format=text`:
* **Headers:** `Content-Type: text/plain; charset=utf-8`
* **Định dạng trả về:** Chuẩn `key [khoảng cách] dấu ","` và xuống dòng:
  ```text
  eyJhbGciOiJSUzI1NiIs...0ZQljAEA ,
  eyJhbGciOiJSUzI1NiIs...PV548zAA ,
  ```

* **Ví dụ gọi bằng cURL:**
  ```bash
  # Lấy 10 key định dạng JSON
  curl "http://127.0.0.1:4317/api/keys?limit=10"

  # Lấy key định dạng Text (chuẩn bị import tool)
  curl "http://127.0.0.1:4317/api/keys?limit=5&format=text"
  ```

---

### 🟢 3. POST `/api/keys/refresh`
> **Mục đích:** Xử lý sự cố khi 1 key bị chết (hết hạn phiên đăng nhập) hoặc đã tiêu thụ hết 10,000 ký tự.

* **Method:** `POST`
* **Headers:** `Content-Type: application/json`
* **Request Body:**
  ```json
  {
    "email": "zoewilson65239@mrhulkstore.store", // Email cần làm mới (bắt buộc nếu reauth)
    "key": "eyJhbGciOiJSUzI1NiIs...",              // Key cũ gặp sự cố
    "mode": "auto"                                 // "auto" | "reauth" | "provision" (mặc định: "auto")
  }
  ```

* **Giải thích các chế độ (`mode`):**
  1. **`mode = "auto"` (Khuyến nghị cho Backend):**
     - Hệ thống tự kiểm tra số dư của key cũ:
       - Nếu tài khoản còn ký tự khả dụng nhưng token hết hạn -> Tự chạy `reauth`.
       - Nếu tài khoản đã cạn 10,000 ký tự -> Tự cấp phát key mới từ pool (`provision`).
  2. **`mode = "reauth"` (Đăng nhập lại lấy token mới):**
     - Mở Chromium headless đăng nhập lại bằng thông tin tài khoản có sẵn trong Sheet để bắt Bearer Token mới (mất ~2–3s, không cần giải CAPTCHA).
     - Ghi đè token mới vào Google Sheet.
  3. **`mode = "provision"` (Cấp phát key mới từ kho dự phòng):**
     - Lấy 1 tài khoản chưa sử dụng khác trong Standby Pool để thay thế ngay lập tức (< 50ms).

* **Response Success (`200 OK`):**
  ```json
  {
    "success": true,
    "action": "provision_pool", // hoặc "reauth"
    "email": "danielthompson95808@mrhulkstore.store",
    "apiKey": "sk_bd08aa4d172dfc4464f9e7219857732c2c1aeb97cecb02fe",
    "status": "complete",
    "message": "Allocated unexhausted key from standby pool"
  }
  ```

---

## 3. BẢNG MÃ LỖI (ERROR CODES)

| HTTP Status | Error Code | Ý nghĩa & Hướng xử lý |
| :---: | :--- | :--- |
| **`400`** | `VALIDATION_ERROR` | Thiếu trường bắt buộc hoặc sai định dạng request. Đọc chi tiết tại trường `message`. |
| **`404`** | `ACCOUNT_NOT_FOUND` | Không tìm thấy email yêu cầu trong Google Sheet. |
| **`500`** | `REFRESH_FAILED` | Quá trình re-auth hoặc cấp phát thất bại (ví dụ: kho dự phòng cạn kiệt). |
| **`504`** | `TIMEOUT` | Kết nối tới máy chủ ElevenLabs bị quá thời gian (sau 6 giây). |

---

## 4. CODE MẪU GỌI API CHO BACKEND (NODE.JS / FETCH)

```javascript
// Ví dụ: Kiểm tra quota và tự động đổi key nếu cạn ký tự
async function getUsableKey(currentKey) {
  const checkRes = await fetch('http://127.0.0.1:4317/api/keys/check-quota', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: currentKey }),
  });
  const quota = await checkRes.json();

  if (quota.valid && quota.remainingCharacters > 500) {
    return currentKey; // Key vẫn tốt
  }

  // Key hết hạn hoặc sắp cạn ký tự -> Gọi refresh tự động
  console.log('Key invalid/exhausted, requesting fresh key...');
  const refreshRes = await fetch('http://127.0.0.1:4317/api/keys/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: currentKey, mode: 'auto' }),
  });
  const refreshData = await refreshRes.json();
  return refreshData.apiKey;
}
```
