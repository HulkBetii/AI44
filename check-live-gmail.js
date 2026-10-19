const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const gpm = require('./gpm-api');
const { getNewProxyXoayWithRetry } = require('./proxyxoay-client');
const { typeHuman, clickHuman, think, simulateNaturalMouseMovements } = require('./human-behavior');

const INPUT_CSV = path.resolve(__dirname, 'gmail.csv');
const OUTPUT_CSV = path.resolve(__dirname, 'check_live_results.csv');
const OUTPUT_JSON = path.resolve(__dirname, 'check_live_results.json');

// Cấu hình theo yêu cầu: Mỗi proxy chỉ check 2-3 gmail, check từ từ
const MIN_ACCOUNTS_PER_PROXY = 2;
const MAX_ACCOUNTS_PER_PROXY = 3;
let currentMaxForThisProxy = 2;

/**
 * Đọc toàn bộ Gmail từ gmail.csv (trích xuất duy nhất và giữ thông tin đi kèm nếu có)
 */
function extractGmailsFromCsv(filePath = INPUT_CSV) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File không tồn tại: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const emailMap = new Map();

  for (let rowIdx = 0; rowIdx < lines.length; rowIdx++) {
    const line = lines[rowIdx];
    if (!line.trim()) continue;

    const cells = line.split(/[,\t]/).map(c => c.trim().replace(/^["']|["']$/g, ''));
    
    for (let colIdx = 0; colIdx < cells.length; colIdx++) {
      const cell = cells[colIdx];
      const match = cell.match(/[a-zA-Z0-9_.+-]+@gmail\.com/i);
      if (match) {
        const email = match[0].toLowerCase();
        if (!emailMap.has(email)) {
          const nextCell = cells[colIdx + 1] || '';
          emailMap.set(email, {
            row: rowIdx + 1,
            email,
            password: nextCell,
            rawLine: line,
          });
        }
      }
    }
  }

  return Array.from(emailMap.values());
}

/**
 * Đọc kết quả đã hoàn thành trước đó để hỗ trợ resume
 */
function loadExistingResults() {
  const completed = new Map();
  if (!fs.existsSync(OUTPUT_CSV)) {
    fs.writeFileSync(
      OUTPUT_CSV,
      'Index,Email,Status,Detail,Timestamp,ProxyIP\n',
      'utf8'
    );
    return completed;
  }

  const content = fs.readFileSync(OUTPUT_CSV, 'utf8');
  const lines = content.split(/\r?\n/).filter(Boolean);
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',').map(s => s.trim().replace(/^"|"$/g, ''));
    if (parts.length >= 3 && parts[1]) {
      completed.set(parts[1].toLowerCase(), {
        index: parts[0],
        email: parts[1],
        status: parts[2],
        detail: parts[3] || '',
      });
    }
  }
  return completed;
}

/**
 * Ghi kết quả 1 account vào file CSV
 */
function appendResult(index, email, status, detail, proxyIp = '') {
  const now = new Date().toISOString();
  const q = (s) => `"${String(s || '').replace(/"/g, '""')}"`;
  const line = [index, q(email), q(status), q(detail), q(now), q(proxyIp)].join(',') + '\n';
  fs.appendFileSync(OUTPUT_CSV, line, 'utf8');
}

/**
 * Kiểm tra 1 Gmail trên trang Google Sign-In
 */
async function inspectGmail(page, email) {
  const signinUrl = 'https://accounts.google.com/signin/v2/identifier?flowName=GlifWebSignIn&flowEntry=ServiceLogin';
  
  // Xóa sạch cookie của phiên trước để đảm bảo form đăng nhập trắng tinh
  await page.context().clearCookies().catch(() => {});

  // Điều hướng tới trang đăng nhập
  await page.goto(signinUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await think(1000, 2000);

  // Kiểm tra nếu IP bị dính chặn ngay từ trang trắng
  let bodyText = await page.locator('body').innerText().catch(() => '');
  if (
    bodyText.includes('unusual traffic') ||
    bodyText.includes('lưu lượng truy cập bất thường') ||
    bodyText.includes('Too many failed attempts') ||
    bodyText.includes('Quá nhiều lần thử')
  ) {
    return { status: 'IP_BLOCKED', detail: 'IP bị Google chặn từ màn hình khởi tạo' };
  }

  // Chờ ô nhập email
  const emailInput = page.locator('input[type="email"], #identifierId').first();
  await emailInput.waitFor({ state: 'visible', timeout: 15000 });
  
  // Mô phỏng di chuột tự nhiên trước khi gõ
  await simulateNaturalMouseMovements(page, 1).catch(() => {});

  // Click vào ô nhập và gõ email như người thật
  await emailInput.click();
  await page.waitForTimeout(300);
  await typeHuman(page, emailInput, email);
  await think(600, 1400);

  // Tìm nút Tiếp theo / Next để click tự nhiên (hoặc Enter)
  const nextBtn = page.locator('#identifierNext, button:has-text("Next"), button:has-text("Tiếp theo")').first();
  if (await nextBtn.isVisible().catch(() => false)) {
    try {
      await clickHuman(page, nextBtn);
    } catch {
      await page.keyboard.press('Enter');
    }
  } else {
    await page.keyboard.press('Enter');
  }

  // Chờ phản hồi từ Google (tối đa 12 giây)
  const startTime = Date.now();
  while (Date.now() - startTime < 12000) {
    await page.waitForTimeout(700);

    const activeUrl = page.url();
    bodyText = await page.locator('body').innerText().catch(() => '');

    // 1. Ô Password xuất hiện -> LIVE!
    const passwordInput = page.locator('input[type="password"], input[name="Passwd"], #password').first();
    if (await passwordInput.isVisible().catch(() => false)) {
      return { status: 'LIVE', detail: 'Tài khoản tồn tại (xuất hiện ô nhập mật khẩu)' };
    }

    // 2. Không tìm thấy tài khoản -> DIE!
    if (
      bodyText.includes('Không tìm thấy Tài khoản Google') ||
      bodyText.includes("Couldn't find your Google Account") ||
      bodyText.includes('không tìm thấy tài khoản') ||
      bodyText.includes("can't find your account")
    ) {
      return { status: 'DIE', detail: 'Không tìm thấy Tài khoản Google' };
    }

    // 3. Tài khoản bị vô hiệu hóa -> DISABLED!
    if (
      bodyText.includes('bị vô hiệu hóa') ||
      bodyText.includes('account was disabled') ||
      bodyText.includes('disabled')
    ) {
      return { status: 'DISABLED', detail: 'Tài khoản đã bị Google vô hiệu hóa' };
    }

    // 4. Màn hình "Verify it's you" / "Confirm you're not a robot" với tên tài khoản hiển thị
    // Khi màn hình này xuất hiện, Google ĐÃ XÁC NHẬN tài khoản tồn tại (LIVE) và chuyển sang thử thách robot/bảo mật.
    if (
      activeUrl.includes('/challenge/rec') ||
      activeUrl.includes('/challenge/recaptcha') ||
      bodyText.includes("Confirm you're not a robot") ||
      bodyText.includes("Xác nhận bạn không phải là người máy") ||
      (bodyText.includes("Verify it's you") && bodyText.includes('robot')) ||
      (bodyText.includes("Xác minh đó là bạn") && bodyText.includes('người máy'))
    ) {
      // Thử click vào checkbox reCAPTCHA nếu có trên trang
      try {
        const captchaFrame = page.frameLocator('iframe[title*="reCAPTCHA"], iframe[src*="recaptcha"]').first();
        const anchor = captchaFrame.locator('#recaptcha-anchor').first();
        if (await anchor.isVisible({ timeout: 1500 }).catch(() => false)) {
          await anchor.click().catch(() => {});
          await page.waitForTimeout(2000);
        }
      } catch {}

      return { status: 'LIVE', detail: 'Tài khoản tồn tại (Google yêu cầu reCAPTCHA xác minh)' };
    }

    // 5. Yêu cầu xác minh danh tính khác (Phone / Recovery email) -> LIVE!
    if (
      bodyText.includes('Xác minh danh tính') ||
      bodyText.includes("Verify it's you") ||
      bodyText.includes('Số điện thoại') ||
      bodyText.includes('Phone number')
    ) {
      return { status: 'LIVE', detail: 'Tài khoản tồn tại (yêu cầu xác minh danh tính)' };
    }

    // 6. Chặn toàn diện IP
    if (
      bodyText.includes('unusual traffic') ||
      bodyText.includes('lưu lượng truy cập bất thường') ||
      bodyText.includes('Too many failed attempts') ||
      bodyText.includes('Quá nhiều lần thử')
    ) {
      return { status: 'IP_BLOCKED', detail: 'IP bị Google giới hạn tần suất' };
    }
  }

  // Thử kiểm tra password lần cuối
  const finalPass = page.locator('input[type="password"]').first();
  if (await finalPass.isVisible().catch(() => false)) {
    return { status: 'LIVE', detail: 'Tài khoản tồn tại' };
  }

  return { status: 'UNKNOWN', detail: 'Không nhận diện được kết quả sau 12s' };
}

/**
 * Main Runner
 */
async function main() {
  console.log('====================================================');
  console.log('   GMAIL LIVE CHECKER (GPM + PROXY XOAY + HUMAN)    ');
  console.log('====================================================\n');

  // 1. Đọc danh sách email
  console.log(`[1] Đang đọc danh sách từ: ${INPUT_CSV}...`);
  const allAccounts = extractGmailsFromCsv(INPUT_CSV);
  console.log(`-> Tìm thấy tổng cộng: ${allAccounts.length} Gmail duy nhất.\n`);

  if (allAccounts.length === 0) {
    console.error('Không tìm thấy tài khoản Gmail nào trong file csv.');
    return;
  }

  // 2. Tải tiến độ cũ nếu có
  const completedMap = loadExistingResults();
  const pendingAccounts = allAccounts.filter(acc => !completedMap.has(acc.email));
  console.log(`[2] Tiến độ: Đã check ${completedMap.size}/${allAccounts.length} | Còn lại: ${pendingAccounts.length} accounts.`);

  if (pendingAccounts.length === 0) {
    console.log('-> Tất cả tài khoản đã được kiểm tra đầy đủ!');
    return;
  }

  // 3. Khởi tạo luồng xử lý
  let currentProxy = null;
  let accountsCheckedOnCurrentProxy = 0;
  let gpmProfileId = null;
  let browser = null;
  let page = null;

  async function connectToGpmWithRetry(debugAddress, maxAttempts = 12, delayMs = 1500) {
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await new Promise((r) => setTimeout(r, delayMs));
        const b = await chromium.connectOverCDP(`http://${debugAddress}`);
        return b;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

  async function rotateAndLaunchBrowser() {
    // Dọn dẹp browser & profile cũ
    if (browser) {
      await browser.close().catch(() => {});
      browser = null;
    }
    if (gpmProfileId) {
      await gpm.stopProfile(gpmProfileId).catch(() => {});
      await gpm.deleteProfile(gpmProfileId).catch(() => {});
      gpmProfileId = null;
    }

    // Lấy proxy mới qua ProxyXoay
    console.log('\n[Proxy] Đang xoay IP mới qua ProxyXoay...');
    currentProxy = await getNewProxyXoayWithRetry();
    accountsCheckedOnCurrentProxy = 0;
    currentMaxForThisProxy = Math.random() < 0.5 ? 2 : 3;

    // Tạo GPM profile mới với proxy
    console.log(`[GPM] Đang tạo profile mới gắn proxy ${currentProxy.proxy}...`);
    gpmProfileId = await gpm.createProfile('live-checker-' + Date.now(), currentProxy.proxy);
    
    console.log(`[GPM] Đang khởi động profile ${gpmProfileId}...`);
    const debugPort = await gpm.startProfile(gpmProfileId);

    console.log(`[Playwright] Đang chờ và kết nối CDP tới ${debugPort}...`);
    browser = await connectToGpmWithRetry(debugPort);
    const context = browser.contexts()[0] || (await browser.newContext());
    page = await context.newPage();

    console.log(`[Proxy] Định mức kiểm tra cho IP này: ${currentMaxForThisProxy} accounts.`);
    console.log('[Playwright] Trình duyệt sẵn sàng!\n');
  }

  // Bắt đầu với proxy đầu tiên
  await rotateAndLaunchBrowser();

  let liveCount = 0;
  let dieCount = 0;
  let otherCount = 0;

  for (let i = 0; i < pendingAccounts.length; i++) {
    const acc = pendingAccounts[i];
    const currentIndex = allAccounts.indexOf(acc) + 1;
    const progressStr = `[${currentIndex}/${allAccounts.length}]`;

    // Nếu đã check đủ 2-3 tài khoản trên IP này, tự động xoay IP mới
    if (accountsCheckedOnCurrentProxy >= currentMaxForThisProxy) {
      console.log(`-> Đã kiểm tra ${accountsCheckedOnCurrentProxy} tài khoản trên IP hiện tại (đạt hạn mức an toàn ${currentMaxForThisProxy} acc/IP). Đang chủ động xoay IP mới...`);
      await rotateAndLaunchBrowser();
    }

    console.log(`${progressStr} Đang kiểm tra: ${acc.email} ...`);
    
    let result = null;
    let retries = 0;

    while (retries < 2) {
      try {
        result = await inspectGmail(page, acc.email);
        
        // Nếu bị IP Block, xoay IP ngay và thử lại
        if (result.status === 'IP_BLOCKED') {
          console.warn(`⚠️ IP ${currentProxy.publicIp} bị Google chặn tần suất. Đang đổi IP mới ngay lập tức...`);
          await rotateAndLaunchBrowser();
          retries++;
          continue;
        }

        break;
      } catch (err) {
        console.error(`❌ Lỗi khi kiểm tra ${acc.email}: ${err.message}`);
        retries++;
        if (retries < 2) {
          console.log('-> Đang khởi động lại trình duyệt để thử lại...');
          await rotateAndLaunchBrowser();
        } else {
          result = { status: 'ERROR', detail: err.message };
        }
      }
    }

    accountsCheckedOnCurrentProxy++;

    // Format log kết quả
    if (result.status === 'LIVE') {
      liveCount++;
      console.log(`✅ ${progressStr} ${acc.email} -> \x1b[32mLIVE\x1b[0m (${result.detail})`);
    } else if (result.status === 'DIE') {
      dieCount++;
      console.log(`❌ ${progressStr} ${acc.email} -> \x1b[31mDIE\x1b[0m (${result.detail})`);
    } else if (result.status === 'DISABLED') {
      dieCount++;
      console.log(`🚫 ${progressStr} ${acc.email} -> \x1b[33mDISABLED\x1b[0m (${result.detail})`);
    } else {
      otherCount++;
      console.log(`⚠️ ${progressStr} ${acc.email} -> ${result.status} (${result.detail})`);
    }

    // Ghi checkpoint
    appendResult(currentIndex, acc.email, result.status, result.detail, currentProxy?.publicIp || '');

    // Nghỉ từ từ 4 - 7 giây giữa các lượt
    const pauseTime = Math.floor(4000 + Math.random() * 3000);
    console.log(`⏳ Nghỉ ${(pauseTime / 1000).toFixed(1)}s trước tài khoản tiếp theo...\n`);
    await new Promise(r => setTimeout(r, pauseTime));
  }

  // Dọn dẹp profile khi xong
  if (browser) await browser.close().catch(() => {});
  if (gpmProfileId) {
    await gpm.stopProfile(gpmProfileId).catch(() => {});
    await gpm.deleteProfile(gpmProfileId).catch(() => {});
  }

  console.log('\n====================================================');
  console.log('                  KẾT QUẢ TỔNG HỢP                  ');
  console.log('====================================================');
  console.log(`Tổng số đã kiểm tra đợt này: ${pendingAccounts.length}`);
  console.log(`- LIVE (Hoạt động):   ${liveCount}`);
  console.log(`- DIE (Không tồn tại): ${dieCount}`);
  console.log(`- Khác / Lỗi:         ${otherCount}`);
  console.log(`\nKết quả chi tiết được lưu tại:`);
  console.log(`- CSV: ${OUTPUT_CSV}`);
  console.log('====================================================\n');
}

process.on('SIGINT', async () => {
  console.log('\n[SIGINT] Đang dừng tiến trình an toàn và lưu checkpoint...');
  process.exit(0);
});

main().catch(err => {
  console.error('[FATAL] Script error:', err);
  process.exit(1);
});
