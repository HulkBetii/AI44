/**
 * index.js (reg-museai)
 * Master CLI Entry Point for Muse AI Referral Automation with GPM and US Proxy.
 */

const { loadMuseConfig } = require('./config');
const { registerSingleMuseAccount, generateCatchAllEmail } = require('./engine');
const { createTempMailAccount } = require('./temp-mail');
const { initSheets, loadRows } = require('../sheets');
const gpm = require('../gpm-api');

function parseArgs(argv) {
  let limit = Infinity;
  let row = null;
  let startRow = null;
  let intervalSec = 60;
  let refCodeOverride = null;
  let proxyOverride = null;
  let dryRun = false;
  let catchAll = false;
  let tempMail = false;

  for (const arg of argv) {
    if (arg === '--catch-all') {
      catchAll = true;
    } else if (arg === '--temp-mail') {
      tempMail = true;
    } else if (arg.startsWith('--limit=')) {
      limit = Math.max(1, parseInt(arg.slice('--limit='.length), 10) || 1);
    } else if (arg.startsWith('--row=')) {
      row = parseInt(arg.slice('--row='.length), 10);
    } else if (arg.startsWith('--start-row=')) {
      startRow = parseInt(arg.slice('--start-row='.length), 10);
    } else if (arg.startsWith('--interval=')) {
      intervalSec = Math.max(10, parseInt(arg.slice('--interval='.length), 10) || 60);
    } else if (arg.startsWith('--ref-code=')) {
      refCodeOverride = arg.slice('--ref-code='.length).trim();
    } else if (arg.startsWith('--proxy=')) {
      const val = arg.slice('--proxy='.length).trim();
      proxyOverride = (val === 'none' || val === 'direct' || val === 'no') ? '' : val;
    } else if (arg === '--no-proxy') {
      proxyOverride = '';
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Cách sử dụng: node reg-museai/index.js [options]

Tùy chọn:
  --limit=N         Số lượng tài khoản tối đa cần chạy (mặc định: 1)
  --row=N           Chạy chính xác dòng N trong Google Sheet
  --start-row=N     Bắt đầu chạy từ dòng N trở đi
  --interval=S      Thời gian nghỉ (cooldown) giữa các tài khoản tính bằng giây (mặc định: 60)
  --ref-code=CODE   Ghi đè mã giới thiệu (mặc định: AR8YUP)
  --proxy=STRING    Ghi đè chuỗi proxy (IP:Port:User:Pass)
  --dry-run         Chạy thử nghiệm không cập nhật trạng thái lên Google Sheet
  --help, -h        Hiển thị trợ giúp
      `);
      process.exit(0);
    }
  }

  return { limit, row, startRow, intervalSec, refCodeOverride, proxyOverride, dryRun, catchAll, tempMail };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadMuseConfig({
    referralCode: args.refCodeOverride,
    proxyString: args.proxyOverride,
    useCatchAll: args.catchAll,
  });

  console.log(`\n======================================================`);
  console.log(`🚀 BẮT ĐẦU PIPELINE TỰ ĐỘNG HÓA MUSE AI REFERRAL`);
  console.log(`   Chế độ:         ${args.catchAll ? `Catch-all Domain (@${config.catchAllDomain}) + Gmail IMAP` : 'Hotmail Sheet'}`);
  console.log(`   Mã giới thiệu:  ${config.referralCode}`);
  console.log(`   Proxy Pool (${config.proxyList.length} proxies xoay vòng):`);
  config.proxyList.forEach((p, idx) => console.log(`     [${idx + 1}] ${p}`));
  console.log(`   GPM API Port:   ${config.gpmApiBase}`);
  console.log(`   Giới hạn lượt:  ${args.row ? `Chỉ dòng ${args.row}` : (args.limit === Infinity ? 'Toàn bộ' : args.limit)}`);
  console.log(`   Thời gian nghỉ: ${args.intervalSec}s`);
  console.log(`======================================================\n`);

  // Pre-flight check 1: GPM API
  try {
    process.stdout.write('[Check 1/2] Kiểm tra kết nối GPM-Login... ');
    const profiles = await gpm.getProfiles();
    console.log(`OK (Hiện có ${profiles.length} profiles).`);
  } catch (err) {
    console.log('THẤT BẠI!');
    console.error(`\n❌ Lỗi GPM: Không thể kết nối GPM-Login tại ${config.gpmApiBase}. Vui lòng mở ứng dụng GPM-Login trước.`);
    process.exit(1);
  }

  // Pre-flight check 2: Google Sheets
  let allRows = [];
  try {
    process.stdout.write('[Check 2/2] Kết nối Google Sheets... ');
    await initSheets();
    if (!args.catchAll) {
      allRows = await loadRows();
      console.log(`OK (Tổng cộng ${allRows.length} dòng dữ liệu).`);
    } else {
      console.log(`OK (Sẵn sàng ghi dữ liệu vào tab 'muse').`);
    }
  } catch (err) {
    console.log('THẤT BẠI!');
    console.error(`\n❌ Lỗi Google Sheets: ${err.message}`);
    process.exit(1);
  }

  // Lọc danh sách tài khoản cần chạy
  let targetAccounts = [];
  if (args.tempMail) {
    const runLimit = args.limit === Infinity ? 1 : args.limit;
    console.log(`[temp-mail] 🎯 Chế độ Mail tạm: Đang khởi tạo ${runLimit} tài khoản mail.tm...`);
    for (let k = 1; k <= runLimit; k++) {
      const tempAcc = await createTempMailAccount();
      targetAccounts.push({
        rowIndex: `tempmail_${k}`,
        email: tempAcc.email,
        password: tempAcc.password,
        tempMailToken: tempAcc.token,
        isTempMail: true,
      });
    }
  } else if (args.catchAll) {
    const runLimit = args.limit === Infinity ? 1 : args.limit;
    console.log(`[catch-all] 🎯 Chế độ Catch-all Domain: Tạo ${runLimit} tài khoản ảo @${config.catchAllDomain}...`);
    for (let k = 1; k <= runLimit; k++) {
      const generatedEmail = generateCatchAllEmail(config.catchAllDomain);
      targetAccounts.push({
        rowIndex: `catchall_${k}`,
        email: generatedEmail,
        password: '',
        isCatchAll: true,
      });
    }
  } else if (args.row) {
    const matched = allRows.find((r) => r.rowIndex === args.row);
    if (!matched) {
      console.error(`\n❌ Không tìm thấy dòng ${args.row} trong Google Sheet!`);
      process.exit(1);
    }
    targetAccounts = [matched];
  } else {
    targetAccounts = allRows.filter((r) => {
      if (args.startRow && r.rowIndex < args.startRow) return false;
      // Bỏ qua dải dòng từ 52 đến 151 theo chỉ thị người dùng
      if (r.rowIndex >= 52 && r.rowIndex <= 151) return false;
      // Bỏ qua tài khoản đã hoàn tất hoặc đã đánh dấu lỗi/khóa
      if (['muse_complete', 'invalid_pass', 'locked', 'login_failed', 'complete'].includes(r.status)) return false;
      // Chỉ lấy các tài khoản pending còn nguyên vẹn
      if (r.status !== 'pending') return false;
      return Boolean(r.email && r.password);
    });

    if (args.limit < targetAccounts.length) {
      targetAccounts = targetAccounts.slice(0, args.limit);
    }
  }

  console.log(`\n📋 Tìm thấy ${targetAccounts.length} tài khoản hợp lệ sẵn sàng xử lý.\n`);

  if (targetAccounts.length === 0) {
    console.log('Tất cả tài khoản trong phạm vi đã hoàn tất hoặc không có tài khoản hợp lệ.');
    process.exit(0);
  }

  let successCount = 0;
  let skipCount = 0;
  let failCount = 0;

  for (let i = 0; i < targetAccounts.length; i++) {
    const account = targetAccounts[i];
    console.log(`------------------------------------------------------`);
    console.log(`[Tiến độ: ${i + 1}/${targetAccounts.length}] Dòng ${account.rowIndex}: ${account.email}`);
    console.log(`------------------------------------------------------`);

    try {
      const activeProxy = args.proxyOverride !== null
        ? args.proxyOverride
        : (config.proxyList && config.proxyList.length > 0
          ? config.proxyList[i % config.proxyList.length]
          : config.proxyString);

      const result = await registerSingleMuseAccount(account, {
        referralCode: config.referralCode,
        proxyString: activeProxy,
        dryRun: args.dryRun,
      });

      if (result && result.skipped) {
        skipCount++;
      } else if (result && result.success) {
        successCount++;
      }
    } catch (err) {
      console.error(`[Thất bại] Lượt ${i + 1} gặp lỗi: ${err.message}`);
      failCount++;
    }

    // Cooldown giữa các tài khoản nếu còn lượt tiếp theo
    if (i + 1 < targetAccounts.length) {
      console.log(`\n[Cooldown] Nghỉ ${args.intervalSec}s trước khi chuyển sang tài khoản kế tiếp...`);
      for (let s = args.intervalSec; s > 0; s -= 10) {
        process.stdout.write(`Đếm ngược: ${s}s... `);
        await new Promise((r) => setTimeout(r, Math.min(10, s) * 1000));
      }
      console.log('Tiếp tục!\n');
    }
  }

  console.log(`\n======================================================`);
  console.log(`🏁 HOÀN TẤT PIPELINE MUSE AI`);
  console.log(`   Thành công: ${successCount}`);
  console.log(`   Bỏ qua:     ${skipCount} (sai pass / khóa / lỗi đăng nhập)`);
  console.log(`   Thất bại:   ${failCount}`);
  console.log(`======================================================\n`);
}

// Bắt tín hiệu ngắt an toàn
process.on('SIGINT', () => {
  console.log('\n\n⚠️ Nhận tín hiệu ngắt (Ctrl+C). Đang dừng tiến trình...');
  process.exit(0);
});

main().catch((err) => {
  console.error('\n❌ Lỗi hệ thống:', err.message);
  process.exit(1);
});
