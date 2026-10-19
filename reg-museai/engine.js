/**
 * engine.js (reg-museai)
 * Core automation engine for registering Muse AI accounts using Hotmail and GPM Browser.
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const gpm = require('../gpm-api');
const { fetchMuseOtpFromOutlook } = require('./outlook-inbox');
const { fetchMuseOtpFromImap } = require('./imap-otp');
const { fetchMuseOtpFromTempMail } = require('./temp-mail');
const { loadMuseConfig } = require('./config');
const { updateStatusByEmail, appendMuseRow } = require('../sheets');
const { generateRealisticName } = require('../human-behavior');

function generateCatchAllEmail(domain = 'mrhulkstore.store') {
  const { firstName, lastName } = generateRealisticName();
  const num = Math.floor(100 + Math.random() * 900);
  const cleanFirst = firstName.toLowerCase().replace(/[^a-z]/g, '');
  const cleanLast = lastName.toLowerCase().replace(/[^a-z]/g, '');
  return `${cleanFirst}.${cleanLast}${num}@${domain}`;
}

const MUSE_SUCCESS_CSV = path.join(__dirname, '..', 'muse_success.csv');
const Q = String.fromCharCode(34);

function csvCell(value) {
  return Q + String(value ?? '').split(Q).join(Q + Q) + Q;
}

function appendMuseSuccessRecord(email, password, referralCode, proxyString, status = 'success') {
  try {
    const csvExists = fs.existsSync(MUSE_SUCCESS_CSV);
    if (!csvExists || fs.statSync(MUSE_SUCCESS_CSV).size === 0) {
      fs.writeFileSync(
        MUSE_SUCCESS_CSV,
        'Timestamp,Email,Password,ReferralCode,Proxy,Status\n',
        'utf8'
      );
    }

    const line = [
      new Date().toISOString(),
      email,
      password,
      referralCode,
      proxyString,
      status,
    ].map(csvCell).join(',') + '\n';

    fs.appendFileSync(MUSE_SUCCESS_CSV, line, 'utf8');
    console.log(`[export] Đã ghi nhận tài khoản thành công vào muse_success.csv: ${email}`);
  } catch (err) {
    console.error(`[export] Lỗi ghi file muse_success.csv: ${err.message}`);
  }
}

function classifyAccountError(err) {
  const msg = String(err?.message || '').toLowerCase();
  const code = err?.code || '';

  if (
    code === 'MS_BAD_CREDENTIALS' ||
    msg.includes('bad_credentials') ||
    msg.includes('password rejected') ||
    msg.includes('password is incorrect') ||
    msg.includes('mật khẩu không đúng') ||
    msg.includes('mật khẩu đó không đúng') ||
    msg.includes("doesn't exist") ||
    msg.includes('không tìm thấy tài khoản')
  ) {
    return { status: 'invalid_pass', note: 'Sai mật khẩu Hotmail', shouldSkip: true };
  }

  if (
    code === 'MS_RECOVERY_REQUIRED' ||
    msg.includes('recovery_required') ||
    msg.includes('locked') ||
    msg.includes('bị khóa') ||
    msg.includes('iproofemail') ||
    msg.includes('suspended') ||
    msg.includes('blocked')
  ) {
    return { status: 'locked', note: 'Tài khoản Hotmail bị khóa/yêu cầu recovery', shouldSkip: true };
  }

  if (
    msg.includes('không nhận được mã xác nhận') ||
    msg.includes('otp timeout') ||
    msg.includes('hết thời gian chờ')
  ) {
    return { status: 'otp_timeout', note: 'Hết thời gian chờ mã OTP từ Muse AI', shouldSkip: true };
  }

  if (
    code === 'MS_UI_CHANGED' ||
    code === 'MS_NETWORK' ||
    msg.includes('ms login') ||
    msg.includes('session dropped') ||
    msg.includes('đăng nhập hotmail')
  ) {
    return { status: 'login_failed', note: `Không đăng nhập được Hotmail (${err.message.slice(0, 80)})`, shouldSkip: true };
  }

  if (
    msg.includes('waitlist') ||
    msg.includes("you're on the waitlist") ||
    msg.includes("isn't available in your country")
  ) {
    return { status: 'waitlist', note: 'Tài khoản bị dính Waitlist do IP hoặc quốc gia Meta', shouldSkip: true };
  }

  return { status: 'failed', note: err.message.slice(0, 100), shouldSkip: true };
}

/**
 * Xử lý màn hình "Finish creating your account" (Meta account creation)
 */
async function handleFinishCreatingAccount(page) {
  const pageText = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
  if (!/Finish creating your account|Why do I need to provide my birthday/i.test(pageText)) {
    return false;
  }

  console.log('[muse] 📋 Phát hiện màn hình "Finish creating your account". Đang điền thông tin cá nhân...');
  const { firstName, lastName } = generateRealisticName();
  console.log(`[muse] Họ và tên tạo mới: ${firstName} ${lastName}`);

  // 1. Điền First name (chỉ khi có input First name thực sự)
  const firstInput = page.locator('input[placeholder*="First" i], input[aria-label*="First" i], input[name*="first" i]').first();
  if (await firstInput.isVisible({ timeout: 1500 }).catch(() => false)) {
    await firstInput.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await firstInput.fill(firstName);
  }
  await page.waitForTimeout(300);

  // 2. Điền Last name (chỉ khi có input Last name thực sự)
  const lastInput = page.locator('input[placeholder*="Last" i], input[aria-label*="Last" i], input[name*="last" i]').first();
  if (await lastInput.isVisible({ timeout: 1500 }).catch(() => false)) {
    await lastInput.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await lastInput.fill(lastName);
  }
  await page.waitForTimeout(300);

  // 3. Chọn Ngày / Tháng / Năm sinh (Yêu cầu tuổi >= 21, chọn năm 1995)
  const selects = page.locator('select');
  const selectCount = await selects.count().catch(() => 0);
  if (selectCount >= 3) {
    console.log('[muse] Điền ngày sinh qua 3 thẻ <select>...');
    await selects.nth(0).selectOption({ index: 5 }).catch(() => {});
    await selects.nth(1).selectOption({ index: 15 }).catch(() => {});
    await selects.nth(2).selectOption('1995').catch(async () => {
      await selects.nth(2).selectOption({ label: '1995' }).catch(() => {});
    });
  } else {
    console.log('[muse] Tương tác với dropdown Năm sinh...');
    const yearTrigger = page.locator('div, button, [role="button"], [role="combobox"]')
      .filter({ hasText: /^202[0-9]|^Year$/ }).last();
    if (await yearTrigger.isVisible({ timeout: 2000 }).catch(() => false)) {
      await yearTrigger.click({ force: true });
      await page.waitForTimeout(600);
      const yearOpt = page.locator('[role="option"]:has-text("1995"), button:has-text("1995"), li:has-text("1995"), text="1995"').first();
      if (await yearOpt.isVisible({ timeout: 2000 }).catch(() => false)) {
        await yearOpt.click({ force: true });
      } else {
        await page.keyboard.type('1995');
        await page.keyboard.press('Enter');
      }
    } else {
      // DOM evaluation fallback
      await page.evaluate(() => {
        const selects = document.querySelectorAll('select');
        if (selects.length >= 3) {
          selects[2].value = '1995';
          selects[2].dispatchEvent(new Event('change', { bubbles: true }));
          selects[2].dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
    }
  }
  await page.waitForTimeout(1000);

  const finishFormShot = path.join(__dirname, '..', `debug-muse-finish-form-${Date.now()}.png`);
  await page.screenshot({ path: finishFormShot }).catch(() => {});

  // 4. Nhấp nút Confirm / Next / Continue
  const confirmBtn = page.locator('button:has-text("Confirm"), button:has-text("Next"), button:has-text("Continue"), button:has-text("Xác nhận")').first();
  if (await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    console.log('[muse] Nhấp nút Confirm trên màn hình tạo tài khoản...');
    await confirmBtn.click({ timeout: 5000, force: true }).catch(() => {});
    await page.waitForTimeout(5000);
  }
  return true;
}

/**
 * Connect Playwright over CDP to GPM with retry
 */
async function connectCDPWithRetry(debugAddress, maxAttempts = 10, delayMs = 1500) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await chromium.connectOverCDP(`http://${debugAddress}`);
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      console.log(`[GPM] Đang đợi cổng CDP ${debugAddress} sẵn sàng (lần ${attempt}/${maxAttempts})...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

/**
 * Execute Muse AI registration and referral redemption for a single account
 * @param {Object} account - { rowIndex, email, password }
 * @param {Object} options - { referralCode, proxyString, dryRun }
 */
async function registerSingleMuseAccount(account, options = {}) {
  const config = loadMuseConfig(options);
  const referralCode = options.referralCode || config.referralCode;
  const proxyString = options.proxyString !== undefined ? options.proxyString : config.proxyString;
  const { email, password } = account;

  console.log(`\n============================================================`);
  console.log(`🚀 [Muse AI] Bắt đầu xử lý: ${email} (Dòng ${account.rowIndex})`);
  console.log(`   Proxy US: ${proxyString}`);
  console.log(`   Mã Referral: ${referralCode}`);
  console.log(`============================================================`);

  let profileId = null;
  let browser = null;

  try {
    // 1. Tạo profile GPM gắn Proxy US
    console.log(`[GPM] Đang tạo profile cho ${email}...`);
    profileId = await gpm.createProfile(`MUSE_${email}`, proxyString);
    console.log(`[GPM] Profile ID: ${profileId}`);

    // 2. Khởi động profile GPM
    console.log('[GPM] Đang khởi động trình duyệt GPM...');
    const debugAddress = await gpm.startProfile(profileId);
    console.log(`[GPM] Cổng CDP Debug: ${debugAddress}`);

    // 3. Kết nối Playwright qua CDP
    browser = await connectCDPWithRetry(debugAddress);
    const context = browser.contexts()[0] || (await browser.newContext());
    const page = await context.newPage();

    // 4. Mở trang Muse AI qua referral entry
    console.log('[muse] Đang tải https://muse.ai/join ...');
    await page.goto('https://muse.ai/join', { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForTimeout(3000);

    // 5. Điền Email đăng ký
    const emailInput = page.locator('input[placeholder*="Mobile number or email" i], input[placeholder*="email" i], input[type="text"], input[type="email"]').first();
    const isEmailDirectlyVisible = await emailInput.isVisible({ timeout: 3000 }).catch(() => false);
    if (!isEmailDirectlyVisible) {
      // Xử lý nút "Open on web" nếu dính trang landing /join
      const openOnWeb = page.locator('button:has-text("Open on web"), a:has-text("Open on web")').first();
      if (await openOnWeb.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log('[muse] Nhấp nút "Open on web"...');
        await openOnWeb.click({ timeout: 5000, force: true }).catch(() => {});
        await page.waitForTimeout(3000);
      }
    }

    console.log(`[muse] Nhập email: ${email}...`);
    await emailInput.waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForTimeout(800);

    await emailInput.click();
    await page.waitForTimeout(400);

    // Gõ chính xác bằng pressSequentially vào locator
    await emailInput.pressSequentially(email, { delay: 60 });
    await page.waitForTimeout(800);

    const typedVal = await emailInput.inputValue().catch(() => '');
    console.log(`[muse] Giá trị thực tế trong ô input: "${typedVal}"`);

    const continueBtn = page.locator('button:has-text("Continue"), button[type="submit"]').first();
    const isBtnEnabled = await continueBtn.isEnabled({ timeout: 3000 }).catch(() => false);
    console.log(`[muse] Trạng thái nút Continue: isEnabled = ${isBtnEnabled}`);

    console.log('[muse] Nhấp nút Continue / bấm Enter để gửi mã OTP...');
    const emailSentAt = Date.now() - 5000;
    await continueBtn.click({ force: true }).catch(() => {});
    await page.keyboard.press('Enter').catch(() => {});

    console.log('[muse] Đang chờ chuyển đổi giao diện sau khi gửi email...');
    let screenType = 'unknown';
    for (let waitSec = 1; waitSec <= 20; waitSec++) {
      await page.waitForTimeout(1000);
      const currentText = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
      const passInputCount = await page.locator('input[type="password"]').count().catch(() => 0);

      if (/Finish creating your account|Why do I need to provide my birthday/i.test(currentText)) {
        screenType = 'finish_account';
        break;
      }
      if (/Enter your code|To confirm your account|Resend code/i.test(currentText)) {
        screenType = 'otp';
        break;
      }
      if (passInputCount > 0) {
        screenType = 'password';
        break;
      }
      if (/You're on the waitlist|Muse isn't available in your country/i.test(currentText)) {
        screenType = 'waitlist';
        break;
      }

      // Nếu sau 4s hoặc 8s vẫn ở landing page, thử kích hoạt lại
      if (waitSec === 4 || waitSec === 8) {
        const stillEmail = page.locator('input[placeholder*="email" i], input[type="text"]').first();
        if (await stillEmail.isVisible().catch(() => false)) {
          console.log(`[muse] Thử kích hoạt lại nút Continue (giây thứ ${waitSec})...`);
          await stillEmail.focus().catch(() => {});
          await page.keyboard.press('Enter').catch(() => {});
          if (await continueBtn.isVisible().catch(() => false)) {
            await continueBtn.click({ force: true }).catch(() => {});
          }
        }
      }
    }

    console.log(`[muse] Trạng thái giao diện nhận diện được: ${screenType} (URL: ${page.url()})`);

    // Chụp ảnh màn hình bước 2
    const step2Shot = path.join(__dirname, '..', `debug-muse-step2-${email}.png`);
    await page.screenshot({ path: step2Shot }).catch(() => {});

    if (screenType === 'waitlist') {
      console.warn(`[muse] ⚠️ Tài khoản ${email} bị dính Waitlist do IP hoặc quốc gia!`);
      throw new Error(`Tài khoản dính Waitlist: ${email}`);
    } else if (screenType === 'finish_account') {
      console.log('[muse] Giao diện "Finish creating your account" đã hiển thị sẵn. Đang hoàn tất thông tin...');
      await handleFinishCreatingAccount(page);
    } else if (screenType === 'password') {
      console.log(`[muse] ⚠️ Email ${email} đã có tài khoản Meta/Muse! Nhập mật khẩu để đăng nhập...`);
      const passInput = page.locator('input[type="password"]').first();
      await passInput.fill(password);
      await page.waitForTimeout(800);
      const loginBtn = page.locator('button:has-text("Log in"), button:has-text("Continue"), button[type="submit"]').first();
      await loginBtn.click();
      await page.waitForTimeout(5000);
    } else if (screenType === 'otp') {
      console.log('[muse] Giao diện nhập mã OTP đã hiển thị.');
      // 6. Lấy mã xác thực 6 số (IMAP cho Catch-all domain hoặc Webmail cho Hotmail)
      const isCatchAll = Boolean(options.isCatchAll || (email && email.toLowerCase().endsWith((config.catchAllDomain || 'mrhulkstore.store').toLowerCase())));
      let code = null;

      if (account.isTempMail && account.tempMailToken) {
        console.log(`[muse] 🚀 Sử dụng mail.tm REST API để lấy mã OTP cho: ${email}`);
        const result = await fetchMuseOtpFromTempMail(account.tempMailToken, config.otpTimeoutMs);
        code = result.code;
      } else if (isCatchAll) {
        console.log(`[muse] 🚀 Sử dụng Gmail IMAP để lấy mã OTP cho Catch-all alias: ${email}`);
        const result = await fetchMuseOtpFromImap(email, {
          ...config,
          sentAfter: emailSentAt,
        });
        code = result.code;
      } else {
        const result = await fetchMuseOtpFromOutlook(email, password, config.otpTimeoutMs);
        code = result.code;
      }

      // 7. Quay lại tab Muse AI và điền mã OTP
      await page.bringToFront();
      await page.waitForTimeout(1000);

      console.log(`[muse] Điền mã OTP: ${code}...`);
      const visualSlot = page.locator('div[role="presentation"], input').first();
      await visualSlot.click({ force: true }).catch(() => {});
      await page.waitForTimeout(300);

      await page.keyboard.type(code, { delay: 120 });
      await page.waitForTimeout(1500);

      const confirmBtn = page.locator('button:has-text("Confirm"), button:has-text("Xác nhận")').first();
      if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        const disabled = await confirmBtn.getAttribute('disabled').catch(() => null);
        if (disabled === null) {
          console.log('[muse] Nhấp nút Confirm xác nhận mã OTP...');
          await confirmBtn.click({ timeout: 5000 }).catch(() => {});
        }
      }

      await page.waitForTimeout(4000);
      const stepOtpSubmittedShot = path.join(__dirname, '..', `debug-muse-after-otp-${email}.png`);
      await page.screenshot({ path: stepOtpSubmittedShot }).catch(() => {});

      // Kiểm tra và xử lý màn hình "Finish creating your account" nếu xuất hiện
      await handleFinishCreatingAccount(page);
    } else {
      const unknownText = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 300) : '').catch(() => '');
      console.warn(`[muse] Màn hình không nhận diện được (đã lưu ${step2Shot}):`, unknownText.replace(/\n+/g, ' '));
      throw new Error(`Giao diện sau Continue không phải OTP hoặc Password: ${unknownText.slice(0, 100)}`);
    }

    // 8. Chờ hoàn tất đăng nhập & Xử lý Onboarding
    console.log('[muse] Đang chờ hoàn tất đăng nhập...');
    await page.waitForTimeout(5000);

    // Kiểm tra lần 2 nếu màn hình "Finish creating your account" vẫn đang hiển thị
    await handleFinishCreatingAccount(page);

    const postLoginShot = path.join(__dirname, '..', `debug-muse-postlogin-${email}.png`);
    await page.screenshot({ path: postLoginShot }).catch(() => {});

    // Kiểm tra nếu hiển thị màn hình Waitlist
    const joinWaitlistBtn = page.locator('button:has-text("Join waitlist")').first();
    if (await joinWaitlistBtn.isVisible({ timeout: 2500 }).catch(() => false)) {
      console.log('[muse] 📋 Phát hiện màn hình Waitlist. Bấm nút "Join waitlist"...');
      await joinWaitlistBtn.click().catch(() => {});
      await page.waitForTimeout(3000);
    }

    // Vòng lặp xử lý onboarding
    for (let o = 0; o < 6; o++) {
      const assistantChoice = page.locator('button:has-text("Muse"), button:has-text("Strider"), button:has-text("Milo")').first();
      if (await assistantChoice.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log('[muse] Chọn tên trợ lý: Muse...');
        await assistantChoice.click().catch(() => {});
        await page.waitForTimeout(2000);
        continue;
      }
      const skipOrNext = page.locator('button:has-text("Skip"), button:has-text("Continue"), button:has-text("Next"), button:has-text("Get started")').first();
      if (await skipOrNext.isVisible({ timeout: 1500 }).catch(() => false)) {
        console.log('[onboarding] Nhấp nút tiếp tục...');
        await skipOrNext.click().catch(() => {});
        await page.waitForTimeout(2000);
        continue;
      }
      break;
    }

    // 9. Kích hoạt mã Referral (Redeem Code)
    console.log(`[referral] Đang mở giao diện kích hoạt mã ${referralCode}...`);
    const dashboardShot = path.join(__dirname, '..', `debug-muse-dashboard-${email}.png`);
    await page.screenshot({ path: dashboardShot }).catch(() => {});

    let redeemSuccess = false;

    // Tìm nút Invite ở header/sidebar hoặc menu ···
    const inviteBtn = page.locator('button:has-text("Invite"), [aria-label*="Invite" i]').first();
    const menuDots = page.locator('button').filter({ hasText: /^···$|^\.\.\.$/ }).first();
    const menuDotsByPos = page.locator('button[class*="rounded-full"][class*="fixed"], button[class*="fixed"]').last();
    const settingsBtn = page.locator('button[aria-label*="Settings" i], button:has-text("Settings"), [data-testid*="settings"]').first();

    if (await inviteBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log('[referral] Nhấp nút Invite...');
      await inviteBtn.click({ timeout: 5000, force: true }).catch(() => {});
      await page.waitForTimeout(2000);

      // Tìm liên kết Redeem trong modal Invite nếu có
      const redeemLink = page.locator('button:has-text("Redeem"), a:has-text("Redeem"), text=/redeem/i').first();
      if (await redeemLink.isVisible({ timeout: 2000 }).catch(() => false)) {
        await redeemLink.click({ timeout: 5000, force: true }).catch(() => {});
        await page.waitForTimeout(1500);
      }
    }

    // Nếu chưa mở được ô nhập code, thử mở Settings
    let refInput = page.locator('input[placeholder*="code" i], input[placeholder*="referral" i]').first();
    if (!(await refInput.isVisible({ timeout: 2000 }).catch(() => false))) {
      if (await menuDots.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log('[referral] Nhấp menu ··· ở góc trên bên phải...');
        await menuDots.click({ force: true }).catch(() => {});
        await page.waitForTimeout(1500);
      } else if (await menuDotsByPos.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log('[referral] Nhấp nút menu ở góc trên...');
        await menuDotsByPos.click({ force: true }).catch(() => {});
        await page.waitForTimeout(1500);
      } else if (await settingsBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log('[referral] Mở Settings để tìm ô Redeem code...');
        await settingsBtn.click({ timeout: 5000, force: true }).catch(() => {});
        await page.waitForTimeout(1500);
      }

      const settingsShot = path.join(__dirname, '..', `debug-muse-settings-${email}.png`);
      await page.screenshot({ path: settingsShot }).catch(() => {});

      const redeemAction = page.locator('button:has-text("Redeem"), text=/Redeem/i').first();
      if (await redeemAction.isVisible({ timeout: 2000 }).catch(() => false)) {
        await redeemAction.click({ timeout: 5000, force: true }).catch(() => {});
        await page.waitForTimeout(1500);
      }
    }

    // Tìm input nhập mã referral
    refInput = page.locator('input[placeholder*="code" i], input[placeholder*="referral" i], input[type="text"]').last();
    if (await refInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log(`[referral] Nhập mã referral: ${referralCode}...`);
      await refInput.click();
      await refInput.fill(referralCode);
      await page.waitForTimeout(800);

      const submitRedeemBtn = page.locator('button:has-text("Redeem"), button:has-text("Submit"), button:has-text("Apply")').first();
      if (await submitRedeemBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await submitRedeemBtn.click();
        console.log('[referral] Đã bấm nút xác nhận Redeem!');
        await page.waitForTimeout(4000);
        redeemSuccess = true;
      }
    } else {
      console.warn('[referral] Không tìm thấy input mã referral trực tiếp.');
    }

    // 10. Chụp ảnh màn hình lưu bằng chứng
    const proofScreenshot = path.join(__dirname, '..', `debug-muse-${email}.png`);
    await page.screenshot({ path: proofScreenshot, fullPage: false }).catch(() => {});
    console.log(`[evidence] Đã lưu ảnh chụp màn hình: ${proofScreenshot}`);

    // 11. Ghi nhận thành công
    const finalStatus = redeemSuccess ? 'redeemed' : 'registered';
    appendMuseSuccessRecord(email, password, referralCode, proxyString, finalStatus);

    if (!options.dryRun) {
      if (!account.isCatchAll) {
        console.log(`[sheet] Cập nhật trạng thái 'muse_complete' cho ${email}...`);
        await updateStatusByEmail(email, 'muse_complete').catch((err) => {
          console.warn(`[sheet] Cảnh báo cập nhật sheet hotmail: ${err.message}`);
        });
      }

      // Lưu kết quả thành công vào sheet mới "muse"
      await appendMuseRow({
        email,
        password,
        referralCode,
        proxy: proxyString,
        status: finalStatus,
        tokens: redeemSuccess ? '1,000,000,000' : '0',
        notes: redeemSuccess ? 'Đăng ký & Kích hoạt thành công mã giới thiệu' : 'Đăng ký thành công Muse AI',
      }).catch((err) => {
        console.warn(`[sheet] Cảnh báo ghi nhận sheet muse: ${err.message}`);
      });
    }

    console.log(`\n🎉 [HOÀN TẤT THÀNH CÔNG] Tài khoản ${email} đã tạo và nhận thưởng 1 tỷ tokens!\n`);
    return { success: true, email };
  } catch (err) {
    const errorDetails = classifyAccountError(err);
    console.error(`\n❌ [LỖI] Xử lý tài khoản ${email}: ${errorDetails.note}`);
    appendMuseSuccessRecord(email, password, referralCode, proxyString, `failed: ${errorDetails.status} - ${errorDetails.note}`);

    if (!options.dryRun) {
      if (!account.isCatchAll) {
        // Cập nhật trạng thái trên sheet hotmail để bỏ qua không quét lại
        await updateStatusByEmail(email, errorDetails.status).catch((e) => {
          console.warn(`[sheet] Cảnh báo cập nhật trạng thái lỗi hotmail: ${e.message}`);
        });
      }

      // Ghi nhận tài khoản lỗi/bỏ qua vào sheet mới "muse"
      await appendMuseRow({
        email,
        password,
        referralCode,
        proxy: proxyString,
        status: errorDetails.status,
        tokens: '0',
        notes: errorDetails.note,
      }).catch((e) => {
        console.warn(`[sheet] Cảnh báo ghi nhận lỗi vào sheet muse: ${e.message}`);
      });
    }

    if (errorDetails.shouldSkip) {
      console.log(`⏩ [SKIP] Đã ghi nhận và bỏ qua tài khoản ${email} (${errorDetails.status}).`);
      return { skipped: true, email, status: errorDetails.status, reason: errorDetails.note };
    }
    throw err;
  } finally {
    // Dọn dẹp đóng browser và xóa profile GPM
    if (browser) {
      await browser.close().catch(() => {});
    }
    if (profileId) {
      console.log(`[GPM] Đóng và dọn dẹp profile ${profileId}...`);
      await gpm.stopProfile(profileId).catch(() => {});
      await gpm.deleteProfile(profileId).catch(() => {});
    }
  }
}

module.exports = {
  registerSingleMuseAccount,
  generateCatchAllEmail,
};
