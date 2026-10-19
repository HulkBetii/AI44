const fs = require('fs');
const path = require('path');
const { generateTOTP, getSecondsRemaining } = require('./totp-helper');

// 1. Nếu người dùng truyền key trực tiếp qua dòng lệnh: node get-totp.js <KEY>
const cliKey = process.argv[2];
if (cliKey) {
  try {
    const code = generateTOTP(cliKey);
    const sec = getSecondsRemaining();
    console.log(`\nKey: ${cliKey}`);
    console.log(`Mã OTP hiện tại: \x1b[32m\x1b[1m${code}\x1b[0m`);
    console.log(`Thời gian còn lại: ${sec} giây\n`);
  } catch (err) {
    console.error(`\x1b[31mLỗi: Key không hợp lệ (${err.message})\x1b[0m`);
  }
  process.exit(0);
}

// 2. Nếu không truyền tham số: tự động đọc và sinh mã cho tất cả tài khoản trong gmail_live.csv
const csvPath = path.join(__dirname, 'gmail_live.csv');
if (!fs.existsSync(csvPath)) {
  console.error(`Không tìm thấy file ${csvPath}`);
  process.exit(1);
}

const content = fs.readFileSync(csvPath, 'utf-8');
const lines = content.split('\n').filter(l => l.trim().length > 0);

console.log('='.repeat(75));
console.log('            BẢNG SINH MÃ TOTP THỜI GIAN THỰC (GMAIL LIVE)           ');
console.log('='.repeat(75));
console.log(`Chu kỳ TOTP còn lại: ${getSecondsRemaining()} giây (mã đổi mới mỗi 30 giây)\n`);
console.log(`${'STT'.padEnd(4)} | ${'Email'.padEnd(32)} | ${'2FA Secret Key'.padEnd(18)} | ${'Mã OTP'.padEnd(8)}`);
console.log('-'.repeat(75));

let count = 0;
// Bỏ qua header dòng 0
for (let i = 1; i < lines.length; i++) {
  // Parse CSV cơ bản (lưu ý có cột bọc ngoặc kép)
  const line = lines[i];
  // Regex tách ô CSV
  const match = line.match(/(".*?"|[^",\r\n]+)(?=\s*,|\s*$)/g);
  if (!match) continue;

  const row = line.split(',').map(s => s.replace(/^"|"$/g, '').trim());
  const stt = row[0] || String(i);
  const email = row[2] || '';
  const twoFa = row[4] || '';

  if (twoFa && twoFa.length >= 8) {
    try {
      const otp = generateTOTP(twoFa);
      console.log(`${stt.padEnd(4)} | ${email.padEnd(32)} | ${twoFa.padEnd(18)} | \x1b[32m\x1b[1m${otp}\x1b[0m`);
      count++;
    } catch {
      // bỏ qua nếu không phải base32
    }
  }
}

console.log('-'.repeat(75));
console.log(`Đã sinh mã thành công cho ${count} tài khoản có 2FA.`);
console.log('='.repeat(75));
console.log('\nGợi ý: Để lấy mã cho 1 key bất kỳ, gõ:');
console.log('  node get-totp.js <KEY_2FA>');
