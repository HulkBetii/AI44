const { chromium } = require('playwright');
const http = require('http');

const PROFILE_NAME = 'check-mail';
const SHEET_URL = 'https://docs.google.com/spreadsheets/d/1DaQ0Eq70iCq-_gMV808i8ehGMbvGTXKJNSuxlclvagg/edit?gid=1336071788#gid=1336071788';

async function callGpm(endpoint) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:19995${endpoint}`, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve({ raw: data }); }
      });
    }).on('error', reject);
  });
}

async function connectWithRetry(debugAddress, maxAttempts = 10) {
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      console.log(`[Playwright] Kết nối tới http://${debugAddress} (lần ${i}/${maxAttempts})...`);
      const browser = await chromium.connectOverCDP(`http://${debugAddress}`);
      return browser;
    } catch (err) {
      if (i === maxAttempts) throw err;
      await new Promise(r => setTimeout(r, 1500));
    }
  }
}

async function main() {
  console.log('[GPM] Lấy danh sách profiles...');
  const profilesRes = await callGpm('/api/v3/profiles');
  const profiles = profilesRes.data || [];
  const target = profiles.find(p => p.name === PROFILE_NAME);

  if (!target) {
    console.error(`[GPM] Không tìm thấy profile "${PROFILE_NAME}"!`);
    return;
  }

  console.log(`[GPM] Tìm thấy profile: ${target.name} (ID: ${target.id})`);

  let debugAddress = '';
  console.log('[GPM] Đang khởi chạy profile...');
  let startRes = await callGpm(`/api/v3/profiles/start/${target.id}`);

  if (startRes.message === 'ALREADY_OPEN') {
    console.log('[GPM] Profile đang mở nhưng cần reset cổng debug...');
    await callGpm(`/api/v3/profiles/stop/${target.id}`);
    await new Promise(r => setTimeout(r, 2000));
    startRes = await callGpm(`/api/v3/profiles/start/${target.id}`);
  }

  if (startRes.success && startRes.data) {
    debugAddress = startRes.data.remote_debugging_address;
  }

  if (!debugAddress) {
    console.error('[GPM] Không lấy được remote_debugging_address!', JSON.stringify(startRes));
    return;
  }

  // Đợi Chrome khởi động socket
  await new Promise(r => setTimeout(r, 2500));

  const browser = await connectWithRetry(debugAddress);
  const contexts = browser.contexts();
  const context = contexts[0] || await browser.newContext();
  const pages = context.pages();
  const page = pages[0] || await context.newPage();

  console.log(`[Playwright] Điều hướng tới Google Sheets: ${SHEET_URL}`);
  await page.goto(SHEET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);

  const currentUrl = page.url();
  const title = await page.title();
  console.log(`[Playwright] URL hiện tại: ${currentUrl}`);
  console.log(`[Playwright] Tiêu đề trang: ${title}`);

  await page.screenshot({ path: 'sheet_checkmail_status.png' });
  console.log('[Playwright] Đã chụp ảnh màn hình lưu tại sheet_checkmail_status.png');

  if (currentUrl.includes('accounts.google.com')) {
    console.log('\n⚠️ Google yêu cầu đăng nhập tài khoản. Trình duyệt đã mở sẵn trên màn hình của bạn để bạn thao tác đăng nhập!');
  } else {
    console.log('\n✅ Đã mở thành công Google Sheet!');
  }
}

main().catch(err => {
  console.error('Lỗi:', err.message);
});
