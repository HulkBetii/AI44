import csv
import json
import re

RESULTS_JSON = r'D:\VibeCoding\mail-temp\check_live_results.json'
INPUT_CSV = r'D:\VibeCoding\mail-temp\gmail.csv'
TARGET_LIVE_CSV = r'D:\VibeCoding\mail-temp\gmail_live.csv'

EMAIL_REGEX = re.compile(r'^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$')

def is_valid_email(val):
    if not val:
        return False
    val = val.strip()
    return bool(EMAIL_REGEX.match(val))

def main():
    with open(RESULTS_JSON, 'r', encoding='utf-8') as f:
        results = json.load(f)

    live_emails = [r['email'].strip().lower() for r in results if r['status'] == 'LIVE']

    with open(INPUT_CSV, 'r', encoding='utf-8', errors='ignore') as f:
        rows = list(csv.reader(f))

    extracted_rows = []

    for em in live_emails:
        # Tìm tất cả các dòng chứa email này
        matching_rows = []
        for idx, r in enumerate(rows, start=1):
            if any(em in c.lower() for c in r):
                matching_rows.append((idx, r))

        # Ưu tiên dòng mà em nằm ở cột 6 (ACC chính)
        best_match = None
        for idx, r in matching_rows:
            if len(r) > 6 and em == r[6].strip().lower():
                best_match = (idx, r)
                break

        if not best_match and matching_rows:
            best_match = matching_rows[0]

        primary_idx, primary_row = best_match
        all_row_numbers = [str(idx) for idx, _ in matching_rows]

        stt_orig = primary_row[0].strip() if len(primary_row) > 0 else ''
        note_col1 = primary_row[1].strip() if len(primary_row) > 1 else ''
        two_fa = primary_row[2].strip() if len(primary_row) > 2 else ''
        metamask = primary_row[5].strip() if len(primary_row) > 5 else ''

        pass_mail = ''
        rec_mail = ''
        pass_sub = ''
        proxy = ''
        note = note_col1

        # Nếu là tài khoản chính nằm ở cột 6
        if len(primary_row) > 6 and em == primary_row[6].strip().lower():
            display_email = primary_row[6].strip()
            pass_mail = primary_row[7].strip() if len(primary_row) > 7 else ''

            # Rà soát cột 8, 9, 10, 11 tìm Recovery Mail và Pass Sub
            candidates = [primary_row[i].strip() for i in [8, 9, 10, 11] if i < len(primary_row)]
            sub_passes = []
            for c in candidates:
                if is_valid_email(c) and not rec_mail:
                    rec_mail = c
                elif c and not is_valid_email(c):
                    if c not in sub_passes:
                        sub_passes.append(c)
            pass_sub = ' | '.join(sub_passes)
            proxy = primary_row[13].strip() if len(primary_row) > 13 else ''
        else:
            # Email nằm ở cột khác (quản lý / tracking)
            display_email = em
            for c in primary_row:
                if is_valid_email(c) and c.strip().lower() != em and not rec_mail:
                    rec_mail = c
                if re.search(r'\d+\.\d+\.\d+\.\d+:\d+', c):
                    proxy = c
            if len(matching_rows) > 1:
                note = f'Email quản lý / tracking (xuất hiện {len(matching_rows)} lần trong file)'
            else:
                note = f'Email xuất hiện ở cột phụ dòng {primary_idx}'

        extracted_rows.append({
            'stt_orig': stt_orig,
            'email': display_email,
            'pass_mail': pass_mail,
            'two_fa': two_fa,
            'metamask': metamask,
            'rec_mail': rec_mail,
            'pass_sub': pass_sub,
            'proxy': proxy,
            'note': note,
            'rows': ', '.join(all_row_numbers),
            'status': 'LIVE',
            'detail': '250 OK (Hộp thư tồn tại và nhận được thư)'
        })

    # Ghi file gmail_live.csv với mã hóa UTF-8 BOM
    with open(TARGET_LIVE_CSV, 'w', encoding='utf-8-sig', newline='') as f:
        writer = csv.writer(f)
        writer.writerow([
            'STT',
            'Mã Tài Khoản',
            'Email',
            'Mật Khẩu Gmail',
            '2FA Key (TOTP)',
            'Địa Chỉ Ví MetaMask',
            'Email Khôi Phục',
            'Mật Khẩu Phụ / Pass Bybit',
            'Proxy Gán',
            'Ghi Chú',
            'Dòng Xuất Hiện Trong Sheet',
            'Trạng Thái Check',
            'Chi Tiết Phản Hồi'
        ])

        for i, item in enumerate(extracted_rows, start=1):
            writer.writerow([
                i,
                item['stt_orig'],
                item['email'],
                item['pass_mail'],
                item['two_fa'],
                item['metamask'],
                item['rec_mail'],
                item['pass_sub'],
                item['proxy'],
                item['note'],
                item['rows'],
                item['status'],
                item['detail']
            ])

    print("=" * 60)
    print(f"Đã cập nhật thành công {len(extracted_rows)} tài khoản Gmail LIVE duy nhất!")
    print(f"File lưu tại: {TARGET_LIVE_CSV}")
    print("=" * 60)

if __name__ == '__main__':
    main()
