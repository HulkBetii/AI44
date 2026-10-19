# Microsoft (Hotmail / Outlook) Signup Selectors & Flow Specification

Tài liệu đặc tả các trường dữ liệu, DOM Selectors, API ngầm và luồng xử lý tự động cho trang đăng ký tài khoản Microsoft Live (`https://signup.live.com/signup`).

---

## 1. Các bước trong luồng giao diện (Multi-step SPA)

Trang đăng ký của Microsoft là ứng dụng Single Page App (SPA), các bước hiển thị tuần tự và dùng chung nút hành động chính (`#iSignupAction`).

### Bước 1: Khởi tạo & Chọn tên tài khoản (Email)
* **URL:** `https://signup.live.com/signup`
* **Nút chuyển chế độ tạo email mới:** `#liveDomainOption` (Text: *"Get a new email address"* hoặc *"Nhận địa chỉ email mới"*)
* **Input tên email:** `#MemberName`
* **Dropdown chọn đuôi email:** `#LiveDomainBox` hoặc `select[name="LiveDomainBoxDropdown"]`
  * Giá trị: `@outlook.com`, `@hotmail.com`
* **Nút Tiếp tục:** `#iSignupAction` hoặc `input[type="submit"]`
* **Lỗi email đã tồn tại:** `#MemberNameError`, `.alert-error` (Text chứa *"is already taken"*, *"đã có người sử dụng"*)

### Bước 2: Nhập Mật khẩu (Password)
* **Input mật khẩu:** `#PasswordInput`
* **Checkbox hiện mật khẩu (nếu cần debug):** `#ShowPasswordCheckbox`
* **Nút Tiếp tục:** `#iSignupAction`

### Bước 3: Nhập Họ & Tên (Name)
* **Input Họ (First Name / Họ):** `#FirstName`
* **Input Tên (Last Name / Tên):** `#LastName`
* **Nút Tiếp tục:** `#iSignupAction`

### Bước 4: Quốc gia & Ngày tháng năm sinh (DOB & Country)
* **Dropdown Quốc gia:** `#Country` (hoặc `select#Country`)
* **Dropdown/Input Tháng:** `#BirthMonth` (Giá trị 1 - 12)
* **Dropdown/Input Ngày:** `#BirthDay` (Giá trị 1 - 31)
* **Input Năm:** `#BirthYear` (Giá trị YYYY, ví dụ: 1995 - 2004)
* **Nút Tiếp tục:** `#iSignupAction`

### Bước 5: Giải Arkose Labs FunCaptcha
* **Iframe định danh:**
  * `iframe#enforcementFrame`
  * `iframe[src*="arkoselabs.com"]`
  * `iframe[src*="client-api.arkoselabs.com"]`
  * `iframe[data-e2e="enforcement-frame"]`
* **Public Key (PKEY) thông dụng của Microsoft Signup:**
  * `B7D8911C-5CC8-A9A3-35B0-554ACEE604DA` (hoặc trích xuất từ query param `pk=` trên iframe src)
* **Service URL:** `https://client-api.arkoselabs.com`
* **Element nhận Token:** `#FunCaptcha-Token` hoặc inject vào token dispatch event `FunCaptcha.completed`

### Bước 6: Xác minh số điện thoại qua SMS (Khi bị yêu cầu)
* **Dấu hiệu nhận biết:** Xuất hiện `#PhoneNumber` hoặc text *"Help us protect your account"*, *"Xác minh số điện thoại của bạn"*
* **Dropdown mã vùng quốc gia:** `#CountryCode` hoặc `select[name="CountryCode"]`
* **Input số điện thoại:** `#PhoneNumber` hoặc `input[type="tel"]`
* **Nút Gửi mã:** `#iSignupAction` (Send code)
* **Input mã OTP nhận được:** `#iOttText` hoặc `input[name="otc"]`
* **Nút Xác nhận OTP:** `#iSignupAction`

### Bước 7: Màn hình hậu đăng ký (Post-Signup / Stay Signed In)
* **Prompt duy trì đăng nhập (KMSI):**
  * Nút Đồng ý: `#acceptButton` hoặc `input[type="submit"][value="Yes"]` / `input[value="Có"]`
  * Nút Bỏ qua: `#declineButton` hoặc `input[type="button"][value="No"]`
* **URL đích khi thành công:**
  * `https://account.microsoft.com/`
  * `https://outlook.live.com/mail/`

---

## 2. Các API Endpoint Ngầm (XHR / Fetch)

* **Check Email:** `POST https://signup.live.com/API/CheckAvailableSigninNames`
* **Create Account:** `POST https://signup.live.com/API/CreateAccount`
* **Telemetry / Logs:** `https://logincdn.msauth.net`

---

## 3. Quy tắc Timing & Tránh Nhận Diện Bot

1. **Typing Jitter:** Sử dụng `typeHuman()` từ `human-behavior.js` thay vì gán trực tiếp `input.value = '...'`.
2. **Step Delays:** Chờ 1.5s - 3s giữa các bước chuyển màn hình (`think()`).
3. **Mouse Movement:** Di chuyển chuột ngẫu nhiên nhẹ nhàng trước khi click nút `#iSignupAction`.
