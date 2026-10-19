import csv
import json
import os
import re

RESULTS_JSON = r'D:\VibeCoding\mail-temp\check_live_results.json'
INPUT_CSV = r'D:\VibeCoding\mail-temp\gmail.csv'
LIVE_CSV = r'D:\VibeCoding\mail-temp\gmail_live.csv'
DIE_CSV = r'D:\VibeCoding\mail-temp\gmail_die.csv'
DISABLED_CSV = r'D:\VibeCoding\mail-temp\gmail_disabled.csv'
ALL_CSV = r'D:\VibeCoding\mail-temp\gmail_full_report.csv'

def main():
    with open(RESULTS_JSON, 'r', encoding='utf-8') as f:
        results = json.load(f)

    # Đọc dữ liệu gốc từ gmail.csv để map thông tin bổ sung (password, dòng...)
    email_meta = {}
    with open(INPUT_CSV, 'r', encoding='utf-8', errors='ignore') as f:
        reader = csv.reader(f)
        header = next(reader, [])
        for row_idx, row in enumerate(reader, start=2):
            for col_idx, cell in enumerate(row):
                for m in re.findall(r'[a-zA-Z0-9_.+-]+@gmail\.com', cell):
                    em = m.lower().strip()
                    # Xác định password liên quan nếu có
                    # Trường hợp Gmail ở cột ACC (col 6): password ở col 7 (PASS MAIL)
                    # Trường hợp Gmail ở cột sau proxy (col 14): kiểm tra các cột xung quanh
                    pwd = ''
                    if col_idx == 6 and len(row) > 7:
                        pwd = row[7]
                    elif col_idx + 1 < len(row) and row[col_idx + 1].strip() and not '@' in row[col_idx + 1]:
                        pwd = row[col_idx + 1]

                    if em not in email_meta:
                        email_meta[em] = {
                            'first_row': row_idx,
                            'password': pwd,
                            'row_data': row
                        }

    live_list = []
    die_list = []
    disabled_list = []
    all_list = []

    for r in results:
        em = r['email']
        status = r['status']
        meta = email_meta.get(em, {'first_row': '', 'password': '', 'row_data': []})
        pwd = meta['password']
        row_num = meta['first_row']

        entry = {
            'index': r['index'],
            'email': em,
            'status': status,
            'password': pwd,
            'row_in_sheet': row_num,
            'code': r['code'],
            'detail': r['detail'],
            'timestamp': r['timestamp']
        }
        all_list.append(entry)

        if status == 'LIVE':
            live_list.append(entry)
        elif status == 'DIE':
            die_list.append(entry)
        elif status == 'DISABLED':
            disabled_list.append(entry)

    # Ghi file gmail_live.csv
    with open(LIVE_CSV, 'w', encoding='utf-8-sig', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(['STT', 'Email', 'Trạng Thái', 'Mật Khẩu (nếu có)', 'Dòng Sheet Gốc', 'Mã Phản Hồi', 'Chi Tiết'])
        for i, item in enumerate(live_list, start=1):
            writer.writerow([i, item['email'], item['status'], item['password'], item['row_in_sheet'], item['code'], item['detail']])

    # Ghi file gmail_die.csv
    with open(DIE_CSV, 'w', encoding='utf-8-sig', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(['STT', 'Email', 'Trạng Thái', 'Dòng Sheet Gốc', 'Mã Phản Hồi', 'Chi Tiết'])
        for i, item in enumerate(die_list, start=1):
            writer.writerow([i, item['email'], item['status'], item['row_in_sheet'], item['code'], item['detail']])

    # Ghi file gmail_disabled.csv
    with open(DISABLED_CSV, 'w', encoding='utf-8-sig', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(['STT', 'Email', 'Trạng Thái', 'Dòng Sheet Gốc', 'Mã Phản Hồi', 'Chi Tiết'])
        for i, item in enumerate(disabled_list, start=1):
            writer.writerow([i, item['email'], item['status'], item['row_in_sheet'], item['code'], item['detail']])

    # Ghi file gmail_full_report.csv
    with open(ALL_CSV, 'w', encoding='utf-8-sig', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(['STT', 'Email', 'Trạng Thái', 'Mật Khẩu (nếu có)', 'Dòng Sheet Gốc', 'Mã Phản Hồi', 'Chi Tiết', 'Thời Gian Check'])
        for i, item in enumerate(all_list, start=1):
            writer.writerow([i, item['email'], item['status'], item['password'], item['row_in_sheet'], item['code'], item['detail'], item['timestamp']])

    print("=" * 60)
    print("        HOÀN TẤT XUẤT CÁC FILE BÁO CÁO PHÂN LOẠI GMAIL       ")
    print("=" * 60)
    print(f"1. Gmail LIVE (Hoạt động tốt):       {len(live_list):>3} tài khoản -> {LIVE_CSV}")
    print(f"2. Gmail DISABLED (Bị vô hiệu hóa):  {len(disabled_list):>3} tài khoản -> {DISABLED_CSV}")
    print(f"3. Gmail DIE (Không tồn tại):        {len(die_list):>3} tài khoản -> {DIE_CSV}")
    print(f"4. Báo cáo đầy đủ 100% tài khoản:   {len(all_list):>3} tài khoản -> {ALL_CSV}")
    print("=" * 60)

if __name__ == '__main__':
    main()
