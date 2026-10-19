const { registerSingleGmail } = require('./engine');
const fivesim = require('../fivesim-client');
const smsgiare = require('../smsgiare-client');
const { getProxyXoay } = require('../proxyxoay-client');
const { loadLocalConfig } = require('../runtime-config');

function parseArgs(argv) {
  let count = 1;
  let intervalSec = 30;

  for (const arg of argv) {
    if (arg.startsWith('--count=')) {
      count = Math.max(1, parseInt(arg.slice('--count='.length), 10) || 1);
    } else if (arg.startsWith('--interval=')) {
      intervalSec = Math.max(5, parseInt(arg.slice('--interval='.length), 10) || 30);
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Usage: node reg-gmail/index.js [options]

Options:
  --count=N         Number of Gmail accounts to create (default: 1)
  --interval=S      Cooldown in seconds between accounts (default: 30)
  --help, -h        Show this help message
      `);
      process.exit(0);
    }
  }

  return { count, intervalSec };
}

async function main() {
  const { count, intervalSec } = parseArgs(process.argv.slice(2));
  const config = loadLocalConfig();
  const provider = (config.smsProvider || (config.smsgiareToken ? 'smsgiare' : '5sim')).toLowerCase();

  console.log(`\n======================================================`);
  console.log(`🚀 BẮT ĐẦU PIPELINE ĐĂNG KÝ GMAIL (GPM + SMS + 2FA)`);
  console.log(`   Cổng SMS đang dùng: ${provider.toUpperCase()}`);
  console.log(`   Số lượng cần tạo:  ${count}`);
  console.log(`   Thời gian nghỉ:     ${intervalSec}s`);
  console.log(`======================================================\n`);

  // Pre-flight checks
  try {
    if (provider === 'smsgiare') {
      console.log('[Check] Kiểm tra kết nối SMSGIARE.IO.VN...');
      const profile = await smsgiare.getBalance();
      console.log(`   -> SMSGIARE OK: User ${profile.userName} | Số dư: ${Number(profile.balance || 0).toLocaleString()}đ`);
      if ((profile.balance || 0) < 3000) {
        console.warn(`\n⚠️ CẢNH BÁO: Số dư trên SMSGIARE hiện tại là ${profile.balance}đ (cần tối thiểu ~3.000đ để thuê 1 số).`);
      }
    } else {
      console.log('[Check] Kiểm tra kết nối 5SIM.NET...');
      const profile = await fivesim.getProfile();
      console.log(`   -> 5SIM OK: User ${profile.email} | Số dư: ${profile.balance} | Rating: ${profile.rating}`);
      if (profile.balance <= 0) {
        console.warn(`\n⚠️ CẢNH BÁO: Số dư trên 5SIM.NET hiện tại là ${profile.balance}.`);
      }
    }

    if (config.customProxy) {
      console.log(`[Check] Sử dụng Proxy 4G tùy chỉnh: ${config.customProxy}`);
      console.log(`   -> Proxy 4G Mobile Vinaphone OK`);
    } else {
      console.log('[Check] Kiểm tra ProxyXoay...');
      const proxy = await getProxyXoay();
      console.log(`   -> Proxy OK: ${proxy.proxyString} (Public IP: ${proxy.publicIp}, Nhà mạng: ${proxy.isp})`);
    }
  } catch (checkErr) {
    console.error(`[Pre-flight Check Thất Bại]: ${checkErr.message}`);
    process.exit(1);
  }

  let successCount = 0;
  let failCount = 0;

  for (let i = 1; i <= count; i++) {
    console.log(`\n------------------------------------------------------`);
    console.log(`[Tiến độ: ${i}/${count}] Bắt đầu tạo tài khoản...`);
    console.log(`------------------------------------------------------`);

    try {
      const result = await registerSingleGmail();
      if (result) successCount++;
    } catch (err) {
      console.error(`[Thất bại] Lượt ${i}/${count} gặp lỗi: ${err.message}`);
      failCount++;
    }

    if (i < count) {
      console.log(`[Cooldown] Nghỉ ${intervalSec}s trước khi chạy lượt tiếp theo...`);
      await new Promise((r) => setTimeout(r, intervalSec * 1000));
    }
  }

  console.log(`\n======================================================`);
  console.log(`🏁 HOÀN TẤT PIPELINE`);
  console.log(`   Thành công: ${successCount}`);
  console.log(`   Thất bại:   ${failCount}`);
  console.log(`   File lưu kết quả: gmail_accounts.txt & gmail_accounts.json`);
  console.log(`======================================================\n`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[Fatal] ${err.message}`);
    process.exit(1);
  });
}

module.exports = { main };
