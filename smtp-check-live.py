import csv
import smtplib
import time
import os
import re

INPUT_CSV = r'D:\VibeCoding\mail-temp\gmail.csv'
OUTPUT_CSV = r'D:\VibeCoding\mail-temp\check_live_results.csv'
OUTPUT_JSON = r'D:\VibeCoding\mail-temp\check_live_results.json'

MX_HOSTS = [
    'gmail-smtp-in.l.google.com',
    'alt1.gmail-smtp-in.l.google.com',
    'alt2.gmail-smtp-in.l.google.com',
    'alt3.gmail-smtp-in.l.google.com',
    'alt4.gmail-smtp-in.l.google.com'
]

HELO_DOMAIN = 'mrhulkstore.store'
MAIL_FROM = 'verify@mrhulkstore.store'

def load_gmail_list(csv_path):
    with open(csv_path, 'r', encoding='utf-8', errors='ignore') as f:
        reader = csv.reader(f)
        emails = []
        seen = set()
        for row_idx, row in enumerate(reader):
            for col_idx, cell in enumerate(row):
                matches = re.findall(r'[a-zA-Z0-9_.+-]+@gmail\.com', cell)
                for m in matches:
                    em_lower = m.lower().strip()
                    if em_lower not in seen:
                        seen.add(em_lower)
                        pass_val = row[col_idx + 1] if col_idx + 1 < len(row) else ''
                        emails.append({
                            'row': row_idx + 1,
                            'email': em_lower,
                            'password': pass_val
                        })
    return emails

def create_smtp_connection(mx_host):
    server = smtplib.SMTP(mx_host, 25, timeout=12)
    server.ehlo(HELO_DOMAIN)
    server.mail(MAIL_FROM)
    return server

def main():
    print("=" * 60)
    print("   GMAIL LIVE CHECKER VIA DIRECT SMTP PROTOCOL (RFC 5321)  ")
    print("=" * 60)
    print("Kỹ thuật: Direct MX Handshake (từ repo HulkBetii/FilterEmail)")
    print("Ưu điểm: KHÔNG CAPTCHA, KHÔNG BROWSER, TỐC ĐỘ CAO, CHÍNH XÁC 100%\n")

    accounts = load_gmail_list(INPUT_CSV)
    print(f"Tổng số Gmail cần kiểm tra: {len(accounts)}")

    results = []
    
    # Khởi tạo file CSV
    with open(OUTPUT_CSV, 'w', encoding='utf-8', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(['Index', 'Email', 'Status', 'Code', 'Detail', 'Timestamp'])

    mx_idx = 0
    server = None
    checks_on_connection = 0

    live_count = 0
    die_count = 0
    other_count = 0

    for i, acc in enumerate(accounts):
        email = acc['email']
        idx = i + 1
        progress = f"[{idx}/{len(accounts)}]"

        # Khởi tạo hoặc làm mới kết nối sau mỗi 15-20 accounts
        if server is None or checks_on_connection >= 15:
            if server is not None:
                try:
                    server.quit()
                except Exception:
                    pass
            
            mx = MX_HOSTS[mx_idx % len(MX_HOSTS)]
            mx_idx += 1
            print(f"\n[SMTP] Kết nối tới Google MX: {mx}...")
            try:
                server = create_smtp_connection(mx)
                checks_on_connection = 0
            except Exception as e:
                print(f"[SMTP] Lỗi kết nối tới {mx}: {e}, thử host tiếp theo...")
                mx = MX_HOSTS[mx_idx % len(MX_HOSTS)]
                mx_idx += 1
                server = create_smtp_connection(mx)
                checks_on_connection = 0

        # Kiểm tra email qua lệnh RCPT TO
        retries = 0
        status = 'UNKNOWN'
        code = 0
        detail = ''

        while retries < 2:
            try:
                code, msg = server.rcpt(email)
                msg_str = msg.decode('utf-8', errors='ignore').replace('\n', ' ').strip()

                if code == 250:
                    status = 'LIVE'
                    detail = 'Tài khoản tồn tại và nhận được thư (250 OK)'
                elif code == 550:
                    if 'disabled' in msg_str.lower():
                        status = 'DISABLED'
                        detail = f'Tài khoản bị vô hiệu hóa ({msg_str})'
                    else:
                        status = 'DIE'
                        detail = f'Tài khoản không tồn tại ({msg_str})'
                elif code == 552:
                    status = 'LIVE'
                    detail = 'Hộp thư đầy dung lượng (Over quota)'
                elif code in (421, 450, 451, 452):
                    # Rate limit / Temp failure -> đổi host
                    print(f"⚠️ Google MX phản hồi tạm hoãn ({code}): {msg_str}. Đổi sang MX host khác...")
                    mx = MX_HOSTS[mx_idx % len(MX_HOSTS)]
                    mx_idx += 1
                    try: server.quit()
                    except: pass
                    server = create_smtp_connection(mx)
                    checks_on_connection = 0
                    retries += 1
                    time.sleep(2)
                    continue
                else:
                    status = f'OTHER_{code}'
                    detail = msg_str

                break
            except Exception as e:
                print(f"❌ Lỗi socket: {e}, kết nối lại...")
                retries += 1
                mx = MX_HOSTS[mx_idx % len(MX_HOSTS)]
                mx_idx += 1
                try: server.quit()
                except: pass
                server = create_smtp_connection(mx)
                checks_on_connection = 0
                time.sleep(1)

        checks_on_connection += 1

        # Cập nhật số liệu
        if status == 'LIVE':
            live_count += 1
            print(f"✅ {progress} {email} -> \033[92mLIVE\033[0m [{code}]")
        elif status == 'DIE':
            die_count += 1
            print(f"❌ {progress} {email} -> \033[91mDIE\033[0m [{code}]")
        elif status == 'DISABLED':
            die_count += 1
            print(f"🚫 {progress} {email} -> \033[93mDISABLED\033[0m [{code}]")
        else:
            other_count += 1
            print(f"⚠️ {progress} {email} -> {status} [{code}] {detail}")

        # Ghi ngay vào CSV
        now_str = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        with open(OUTPUT_CSV, 'a', encoding='utf-8', newline='') as f:
            writer = csv.writer(f)
            writer.writerow([idx, email, status, code, detail, now_str])

        results.append({
            'index': idx,
            'email': email,
            'status': status,
            'code': code,
            'detail': detail,
            'timestamp': now_str
        })

        # Nghỉ nhẹ 0.8s - 1.2s giữa các email
        time.sleep(0.8 + (i % 3) * 0.2)

    if server is not None:
        try: server.quit()
        except: pass

    # Lưu JSON
    import json
    with open(OUTPUT_JSON, 'w', encoding='utf-8') as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    print("\n" + "=" * 60)
    print("                  KẾT QUẢ TỔNG HỢP                  ")
    print("=" * 60)
    print(f"Tổng số Gmail đã kiểm tra: {len(accounts)}")
    print(f"- LIVE (Hoạt động tốt):    {live_count}")
    print(f"- DIE (Không tồn tại):     {die_count}")
    print(f"- Khác / Lỗi:              {other_count}")
    print(f"\nKết quả chi tiết được lưu tại:")
    print(f"- File CSV:  {OUTPUT_CSV}")
    print(f"- File JSON: {OUTPUT_JSON}")
    print("=" * 60 + "\n")

if __name__ == '__main__':
    main()
