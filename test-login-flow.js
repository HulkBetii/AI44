const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { generateTOTP } = require('./totp-helper');
const { loadRuntimeConfig } = require('./runtime-config');
const { solveCaptcha, detectCaptcha } = require('./captcha-solver');

const CSV_PATH = path.join(__dirname, 'gmail_live.csv');
const PROFILE_NAME = 'check-mail';
const TARGET_URL = 'https://docs.google.com/spreadsheets/d/1DaQ0Eq70iCq-_gMV808i8ehGMbvGTXKJNSuxlclvagg/edit?gid=1336071788#gid=1336071788';

function callGpm(endpoint) {
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

async function getLiveGpmDebugAddress(profileName) {
  console.log(`[GPM] Đang tìm profile "${profileName}" qua GPM API...`);
  const profilesRes = await callGpm('/api/v3/profiles');
  const profiles = profilesRes.data || [];
  const target = profiles.find(p => p.name === profileName);

  if (!target) {
    throw new Error(`Không tìm thấy profile "${profileName}" trong GPM! Hãy chắc chắn GPM đang mở.`);
  }

  console.log(`[GPM] Đã tìm thấy profile: ${target.name} (ID: ${target.id})`);
  let startRes = await callGpm(`/api/v3/profiles/start/${target.id}`);

  if (startRes.message === 'ALREADY_OPEN') {
    console.log('[GPM] Profile đang mở nhưng cần làm mới cổng kết nối debug...');
    await callGpm(`/api/v3/profiles/stop/${target.id}`);
    await new Promise(r => setTimeout(r, 2000));
    startRes = await callGpm(`/api/v3/profiles/start/${target.id}`);
  }

  if (startRes.success && startRes.data?.remote_debugging_address) {
    return startRes.data.remote_debugging_address;
  }

  throw new Error(`Không lấy được cổng debug từ GPM: ${JSON.stringify(startRes)}`);
}

async function connectWithRetry(debugAddress, maxAttempts = 10) {
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      console.log(`[CDP] Kết nối tới http://${debugAddress} (lần ${i}/${maxAttempts})...`);
      const browser = await chromium.connectOverCDP(`http://${debugAddress}`);
      return browser;
    } catch (err) {
      if (i === maxAttempts) throw err;
      await new Promise(r => setTimeout(r, 1500));
    }
  }
}

function loadAccounts() {
  const content = fs.readFileSync(CSV_PATH, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim().length > 0);
  const accounts = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const row = [];
    let inQuotes = false;
    let field = '';
    for (let c = 0; c < line.length; c++) {
      const char = line[c];
      if (char === '"') {
        if (inQuotes && line[c + 1] === '"') {
          field += '"';
          c++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        row.push(field.trim());
        field = '';
      } else {
        field += char;
      }
    }
    row.push(field.trim());

    const email = row[2] || '';
    const pass = row[3] || '';
    const twoFa = row[4] || '';
    const recMail = row[6] || '';

    if (email && pass) {
      accounts.push({
        index: row[0],
        email,
        password: pass,
        twoFa,
        recoveryEmail: recMail
      });
    }
  }
  return accounts;
}

async function solveGoogleImageCaptcha(page) {
  const config = loadRuntimeConfig();
  const captchaImg = await page.$('#captchaimg:visible, img[src*="getimage"]:visible, img[src*="Captcha"]:visible');
  if (!captchaImg) return false;

  console.log('[CAPTCHA] Phát hiện ảnh CAPTCHA ký tự hiển thị! Đang tự động gửi qua API giải mã...');
  try {
    const buffer = await captchaImg.screenshot();
    const base64 = buffer.toString('base64');
    let text = null;

    // 1. Thử giải bằng CapSolver
    if (config.capsolverApiKey) {
      try {
        console.log('[CAPTCHA] Đang gửi tới CapSolver (ImageToTextTask)...');
        const res = await fetch('https://api.capsolver.com/createTask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientKey: config.capsolverApiKey,
            task: { type: 'ImageToTextTask', body: base64 }
          })
        }).then(r => r.json());

        if (res.errorId === 0 && res.solution?.text) {
          text = res.solution.text;
        }
      } catch (e) {
        console.warn('[CAPTCHA] CapSolver gặp lỗi:', e.message);
      }
    }

    // 2. Thử giải bằng 2Captcha nếu CapSolver không ra
    if (!text && config.twoCaptchaApiKey) {
      try {
        console.log('[CAPTCHA] Đang gửi tới 2Captcha...');
        const res = await fetch('https://api.2captcha.com/createTask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientKey: config.twoCaptchaApiKey,
            task: { type: 'ImageToTextTask', body: base64 }
          })
        }).then(r => r.json());

        if (res.errorId === 0) {
          if (res.solution?.text) {
            text = res.solution.text;
          } else if (res.taskId) {
            for (let i = 0; i < 15; i++) {
              await new Promise(r => setTimeout(r, 2000));
              const poll = await fetch('https://api.2captcha.com/getTaskResult', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ clientKey: config.twoCaptchaApiKey, taskId: res.taskId })
              }).then(r => r.json());
              if (poll.status === 'ready' && poll.solution?.text) {
                text = poll.solution.text;
                break;
              }
            }
          }
        }
      } catch (e) {
        console.warn('[CAPTCHA] 2Captcha gặp lỗi:', e.message);
      }
    }

    if (text) {
      console.log(`[CAPTCHA] Giải mã thành công: "${text}"! Đang điền vào ô...`);
      const captchaInput = await page.$('input#ca:visible, input[name="ca"]:visible, input[aria-label*="ký tự" i]:visible, input[aria-label*="characters" i]:visible, input[autocomplete="off"][type="text"]:visible');
      if (captchaInput) {
        await captchaInput.click();
        await captchaInput.fill(text);
        await page.waitForTimeout(500);

        const nextBtn = await page.$('#identifierNext button, #passwordNext button, button:has-text("Tiếp theo"), button:has-text("Next")');
        if (nextBtn) await nextBtn.click();
        else await page.keyboard.press('Enter');

        await page.waitForTimeout(4000);
        return true;
      }
    }
  } catch (err) {
    console.warn('[CAPTCHA] Lỗi trong quá trình xử lý ảnh CAPTCHA:', err.message);
  }
  return false;
}

async function checkAndSolveGoogleCaptchas(page) {
  // Thử giải Image CAPTCHA nếu có
  const imgSolved = await solveGoogleImageCaptcha(page);
  if (imgSolved) return true;

  // Thử kiểm tra widget (reCAPTCHA v2 / Enterprise, Turnstile)
  const widget = await detectCaptcha(page).catch(() => null);
  if (widget) {
    console.log(`[CAPTCHA] Phát hiện widget xác minh ${widget.provider} (${widget.type})! Đang tự động giải qua API...`);
    const res = await solveCaptcha(page, '', { skipUrlCheck: true });
    if (res.solved) {
      console.log('[CAPTCHA] Giải widget CAPTCHA thành công!');
      await page.waitForTimeout(2000);

      // Bấm nút Tiếp theo để hoàn tất xác minh nếu nút có sẵn
      const nextBtn = await page.$('#identifierNext button, #passwordNext button, button:has-text("Tiếp theo"), button:has-text("Next")');
      if (nextBtn) {
        console.log('[CAPTCHA] Bấm Tiếp theo sau khi giải CAPTCHA...');
        await nextBtn.click();
        await page.waitForTimeout(4000);
      }
      return true;
    } else {
      console.warn('[CAPTCHA] Giải widget CAPTCHA thất bại:', res.reason);
    }
  }
  return false;
}

async function waitForPasswordInputWithCaptcha(page, maxAttempts = 10) {
  console.log('[Step 2] Đang chờ ô nhập mật khẩu hiển thị (kèm kiểm tra CAPTCHA)...');
  for (let i = 1; i <= maxAttempts; i++) {
    const passInput = await page.$('input[name="Passwd"]:not([aria-hidden="true"])');
    if (passInput && await passInput.isVisible()) {
      return passInput;
    }

    // Nếu gặp trang xác minh / CAPTCHA
    const solved = await checkAndSolveGoogleCaptchas(page);
    if (solved) {
      await page.waitForTimeout(3000);
      const afterPass = await page.$('input[name="Passwd"]:not([aria-hidden="true"])');
      if (afterPass && await afterPass.isVisible()) {
        return afterPass;
      }
    }

    await page.waitForTimeout(2000);
  }
  throw new Error(`Quá thời gian chờ ô mật khẩu sau ${maxAttempts * 2} giây!`);
}

async function runTest() {
  const accounts = loadAccounts();
  const testAcc = accounts.find(a => a.twoFa && a.twoFa.length >= 8) || accounts[0];

  console.log('='.repeat(55));
  console.log(`[Test] Đang thử tài khoản: ${testAcc.email}`);
  console.log(`[Test] Mật khẩu:           ${testAcc.password}`);
  console.log(`[Test] Khóa 2FA:          ${testAcc.twoFa || '(Không có)'}`);
  console.log('='.repeat(55));

  const debugAddress = await getLiveGpmDebugAddress(PROFILE_NAME);
  await new Promise(r => setTimeout(r, 2000));

  const browser = await connectWithRetry(debugAddress);
  const context = browser.contexts()[0] || await browser.newContext();
  
  // Tạo tab mới hoàn toàn để tránh việc tab mặc định bị GPM đóng đột ngột
  let page = await context.newPage();

  page.setDefaultTimeout(30000);

  console.log('[Step 1] Điều hướng tới trang đăng nhập Google...');
  try {
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
  } catch (err) {
    console.log(`[Cảnh báo] Lỗi khi load trang lần 1 (${err.message}). Đang thử lại với tab mới...`);
    page = await context.newPage();
    page.setDefaultTimeout(30000);
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
  }

  // 1. Chờ ô nhập Email
  console.log('[Step 1] Đang chờ ô nhập email...');
  const emailInput = await page.waitForSelector('input#identifierId, input[type="email"]', { state: 'visible' });
  await emailInput.click();
  await emailInput.fill('');
  await page.waitForTimeout(300);

  console.log(`[Step 1] Đang điền email: ${testAcc.email}`);
  await emailInput.type(testAcc.email, { delay: 40 });
  await page.waitForTimeout(800);

  console.log('[Step 1] Bấm Tiếp theo...');
  const nextEmailBtn = await page.$('#identifierNext button, button:has-text("Tiếp theo"), button:has-text("Next")');
  if (nextEmailBtn) {
    await nextEmailBtn.click();
  } else {
    await page.keyboard.press('Enter');
  }

  // 2. Chờ phản hồi sau khi nhập Email
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'step1_email_submitted.png' });

  // Kiểm tra nếu gặp CAPTCHA sau khi nhập Email
  await checkAndSolveGoogleCaptchas(page);

  const bodyText1 = await page.innerText('body');
  if (bodyText1.includes('Không tìm thấy Tài khoản Google') || bodyText1.includes("Couldn't find your Google Account")) {
    console.log('❌ KẾT QUẢ: FAIL (Tài khoản Google không tồn tại)');
    return;
  }

  // 3. Chờ ô Mật khẩu hiển thị (có giải CAPTCHA tự động nếu bị chặn)
  try {
    const passInput = await waitForPasswordInputWithCaptcha(page);

    console.log('[Step 2] Đang điền mật khẩu...');
    await passInput.click();
    await passInput.type(testAcc.password, { delay: 50 });
    await page.waitForTimeout(1000);

    console.log('[Step 2] Bấm Tiếp theo để xác thực mật khẩu...');
    const nextPassBtn = await page.$('#passwordNext button, button:has-text("Tiếp theo"), button:has-text("Next")');
    if (nextPassBtn) {
      await nextPassBtn.click();
    } else {
      await page.keyboard.press('Enter');
    }

    await page.waitForTimeout(5000);
    await page.screenshot({ path: 'step2_pass_submitted.png' });

    // Kiểm tra CAPTCHA nếu xuất hiện sau khi nhập Mật khẩu
    await checkAndSolveGoogleCaptchas(page);

    // Kiểm tra sai mật khẩu
    const bodyText2 = await page.innerText('body');
    if (bodyText2.includes('Sai mật khẩu') || bodyText2.includes('Wrong password')) {
      console.log('❌ KẾT QUẢ: FAIL (Sai mật khẩu - LOẠI)');
      return;
    }

    // 4. Kiểm tra bước 2FA (TOTP)
    const otpInput = await page.$('input[name="totpPin"], input#totpPin, input[type="tel"]:not([aria-hidden="true"])');
    if (otpInput && testAcc.twoFa) {
      const otpCode = generateTOTP(testAcc.twoFa);
      console.log(`[Step 3] Phát hiện yêu cầu 2FA! Tự động tạo mã từ key: ${testAcc.twoFa} -> Mã: ${otpCode}`);
      await otpInput.click();
      await otpInput.type(otpCode, { delay: 60 });
      await page.waitForTimeout(1000);

      const nextOtpBtn = await page.$('#totpNext button, button:has-text("Tiếp theo"), button:has-text("Next")');
      if (nextOtpBtn) {
        await nextOtpBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }

      await page.waitForTimeout(5000);
      await page.screenshot({ path: 'step3_otp_submitted.png' });
    }

    // 5. Kiểm tra kết quả URL cuối
    const finalUrl = page.url();
    console.log(`[Kết quả] URL hiện tại: ${finalUrl}`);
    if (finalUrl.includes('docs.google.com/spreadsheets') || finalUrl.includes('myaccount.google.com')) {
      console.log('🎉 KẾT QUẢ: PASS (Đăng nhập thành công vào Google Sheet)!');
    } else {
      console.log('[Thông báo] Đã gửi thông tin. Bạn có thể xem trạng thái trên cửa sổ trình duyệt GPM.');
    }
  } catch (err) {
    console.error('❌ Không tìm thấy ô mật khẩu:', err.message);
    await page.screenshot({ path: 'step2_error.png' });
    console.log('Ảnh chụp lỗi đã lưu tại step2_error.png để kiểm tra.');
  }
}

runTest().catch(console.error);
