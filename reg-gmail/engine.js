const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { loadLocalConfig } = require('../runtime-config');
const { createProfile, startProfile, stopProfile, deleteProfile } = require('../gpm-api');
const { rotateProxyWithCooldown } = require('../proxyxoay-client');
const fivesim = require('../fivesim-client');
const smsgiare = require('../smsgiare-client');
const { generateTOTP, cleanSecret } = require('../totp-helper');
const { generateSecurePassword } = require('../password-generator');
const { decodeQrFromBase64 } = require('../qr-helper');
const { clickHuman, typeHuman, think } = require('../human-behavior');

const FIRST_NAMES = [
  'Minh', 'Hoang', 'Duc', 'Nam', 'Tuan', 'Phong', 'Linh', 'Trang', 'Ha', 'Mai',
  'Anh', 'Huy', 'Khoa', 'Long', 'Quan', 'Thang', 'Dung', 'Bao', 'Khang', 'Thao'
];

const LAST_NAMES = [
  'Nguyen', 'Tran', 'Le', 'Pham', 'Hoang', 'Huynh', 'Phan', 'Vu', 'Vo', 'Dang',
  'Bui', 'Do', 'Ho', 'Ngo', 'Duong', 'Ly'
];

function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateSyntheticUser() {
  const firstName = randomChoice(FIRST_NAMES);
  const lastName = randomChoice(LAST_NAMES);
  const birthYear = String(1992 + Math.floor(Math.random() * 10)); // 1992 - 2002
  const birthMonth = String(1 + Math.floor(Math.random() * 12));
  const birthDay = String(1 + Math.floor(Math.random() * 28));
  const gender = Math.random() > 0.5 ? '1' : '2'; // 1: Female, 2: Male
  const password = generateSecurePassword();

  const randNum = Math.floor(100000 + Math.random() * 900000);
  const suggestedUsername = `${firstName.toLowerCase()}.${lastName.toLowerCase()}.${randNum}`;

  return {
    firstName,
    lastName,
    birthYear,
    birthMonth,
    birthDay,
    gender,
    password,
    suggestedUsername,
  };
}

/**
 * Types text with natural keyboard cadence and jitter to bypass bot detection.
 */
async function typeNaturally(page, locator, text) {
  await locator.click();
  await page.waitForTimeout(100 + Math.random() * 150);
  await locator.fill('');
  for (const char of text) {
    await page.keyboard.type(char, { delay: 35 + Math.floor(Math.random() * 55) });
  }
  await page.waitForTimeout(150 + Math.random() * 200);
}

/**
 * Connects Playwright over CDP to GPM-Login with retry to tolerate browser startup latency.
 */
async function connectToGpmWithRetry(debugAddress, maxAttempts = 10, delayMs = 2000) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await new Promise((r) => setTimeout(r, delayMs));
      const browser = await chromium.connectOverCDP(`http://${debugAddress}`);
      console.log(`[GPM] Connected via CDP on attempt ${attempt}`);
      return browser;
    } catch (err) {
      lastErr = err;
      console.log(`[GPM] Waiting for browser port ${debugAddress} to be ready (${attempt}/${maxAttempts})...`);
    }
  }
  throw lastErr;
}

/**
 * Finds and clicks the primary Next button on Google forms (EN & VI).
 */
async function clickNextButton(page, timeout = 7000) {
  // Dismiss any open dropdown overlays before clicking Next
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(200);

  const selectors = [
    '#birthdaygenderNext button',
    '#birthdaygenderNext',
    'button:has-text("Next")',
    'button:has-text("Tiếp theo")',
    'button:has-text("Tiếp tục")',
    'span:has-text("Next")',
    'span:has-text("Tiếp theo")',
    'span:has-text("Tiếp tục")',
    'div[role="button"]:has-text("Next")',
    'div[role="button"]:has-text("Tiếp theo")',
    'button[jsname="LgbsSe"]',
    '#identifierNext',
    '#createAccount',
  ];

  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible({ timeout: 1000 }).catch(() => false)) {
      try {
        await clickHuman(page, loc, { timeoutMs: timeout });
      } catch (e) {
        await loc.click({ timeout, force: true }).catch(() => {});
      }
      await page.waitForTimeout(1500);
      return true;
    }
  }
  throw new Error('Next button (Next / Tiếp theo) could not be found or clicked');
}

/**
 * Handles country dropdown and fills phone number cleanly.
 */
async function fillPhoneNumber(page, phoneInput, rawPhone) {
  const phone = String(rawPhone || '').trim();
  let countryPrefix = '+84';
  if (phone.startsWith('+62')) countryPrefix = '+62';
  else if (phone.startsWith('+237')) countryPrefix = '+237';
  else if (phone.startsWith('+60')) countryPrefix = '+60';
  else if (phone.startsWith('+1')) countryPrefix = '+1';

  if (countryPrefix !== '+84') {
    const countryDropdown = page.locator('div[aria-haspopup="listbox"], [aria-label*="Country"], [aria-label*="Quốc gia"]').first();
    if (await countryDropdown.isVisible({ timeout: 1500 }).catch(() => false)) {
      await countryDropdown.click();
      await page.waitForTimeout(500);
      const option = page.locator(`li:has-text("${countryPrefix}"), [role="option"]:has-text("${countryPrefix}")`).first();
      if (await option.isVisible({ timeout: 2000 }).catch(() => false)) {
        await option.click();
        await page.waitForTimeout(500);
      } else {
        await page.keyboard.press('Escape');
      }
    }
  }

  await phoneInput.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(300);
  await phoneInput.fill(phone);
}

/**
 * Unified SMS rent function supporting both SMSGIARE and 5SIM
 */
async function rentSmsNumber(config) {
  const provider = (config.smsProvider || (config.smsgiareToken ? 'smsgiare' : '5sim')).toLowerCase();

  if (provider === 'smsgiare') {
    const order = await smsgiare.buyGmailNumberAuto(config.smsgiareToken);
    return {
      provider: 'smsgiare',
      id: order.requestId,
      phone: order.phone,
      price: order.price,
    };
  } else {
    const targetCountries = config.fivesimCountries || ['canada', 'indonesia', 'vietnam'];
    const order = await fivesim.buyCheapestAvailable({ countries: targetCountries, token: config.fivesimToken });
    return {
      provider: '5sim',
      id: order.id,
      phone: order.phone,
      price: order.price,
    };
  }
}

/**
 * Unified SMS wait function
 */
async function waitSmsOtp(order, config, options = {}) {
  if (order.provider === 'smsgiare') {
    const res = await smsgiare.waitForSmsV1(order.id, options);
    return res.code;
  } else {
    const res = await fivesim.waitForSms(order.id, { ...options, token: config.fivesimToken });
    return res.code;
  }
}

/**
 * Unified cancel function for refund
 */
async function releaseSmsOrder(order, config) {
  if (!order || !order.id) return;
  if (order.provider === '5sim') {
    await fivesim.cancelOrder(order.id, config.fivesimToken).catch(() => {});
  }
}

/**
 * Unified finish function
 */
async function completeSmsOrder(order, config) {
  if (!order || !order.id) return;
  if (order.provider === '5sim') {
    await fivesim.finishOrder(order.id, config.fivesimToken).catch(() => {});
  }
}

/**
 * Captures screenshot and HTML DOM snapshot for fast post-mortem debugging.
 */
async function captureDiagnostic(page, label = 'failure') {
  if (!page) return null;
  try {
    const timestamp = Date.now();
    const rootDir = path.resolve(__dirname, '..');
    const screenshotPath = path.join(rootDir, `debug-gmail-${label}-${timestamp}.png`);
    const htmlPath = path.join(rootDir, `debug-gmail-${label}-${timestamp}.html`);

    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    const html = await page.content().catch(() => '');
    const currentUrl = page.url();
    const title = await page.title().catch(() => '');

    fs.writeFileSync(htmlPath, html, 'utf8');

    console.log(`\n📸 [DIAGNOSTIC CAPTURED]`);
    console.log(`   Label:      ${label}`);
    console.log(`   URL:        ${currentUrl}`);
    console.log(`   Title:      ${title}`);
    console.log(`   Screenshot: ${screenshotPath}`);
    console.log(`   DOM HTML:   ${htmlPath}\n`);

    return { screenshotPath, htmlPath, currentUrl, title };
  } catch (diagErr) {
    console.warn(`[Diagnostic] Could not capture diagnostic: ${diagErr.message}`);
    return null;
  }
}

/**
 * Executes phone verification supporting both direct phone input and QR code mobile verification.
 */
async function executePhoneVerification(page, config) {
  console.log('[reg-gmail] Checking phone verification interface...');
  await page.waitForTimeout(3000);

  const isQrScreen = page.url().includes('mophoneverification') ||
    (await page.locator('img[alt*="QR code"], img[src^="data:image"]').first().isVisible({ timeout: 2500 }).catch(() => false));

  let targetPage = page;
  let mobileTab = null;

  if (isQrScreen) {
    console.warn('[reg-gmail] Google triggered Mobile Originated (MO) SMS verification via QR code.');
    console.warn('[reg-gmail] (This occurs when Google flags the session/IP as high risk. Virtual SMS APIs only receive SMS and cannot send outgoing SMS).');
    await captureDiagnostic(page, 'qr-mo-verification-triggered').catch(() => {});
    throw new Error('Google flagged session with QR MO verification (requires physical phone to send outgoing SMS). Skipping profile to rotate IP.');
  }

  const phoneInput = targetPage.locator('input#phoneNumberId, input[type="tel"]').first();
  await phoneInput.waitFor({ state: 'visible', timeout: 15000 });

  let phoneVerified = false;
  let registeredPhone = '';
  let currentSmsOrder = null;

  for (let attempt = 1; attempt <= 3 && !phoneVerified; attempt++) {
    console.log(`[reg-gmail] Renting number from SMS provider (Attempt ${attempt}/3)...`);
    currentSmsOrder = await rentSmsNumber(config);
    registeredPhone = currentSmsOrder.phone;

    console.log(`[reg-gmail] Rented number: ${registeredPhone} (Provider: ${currentSmsOrder.provider}, ID: ${currentSmsOrder.id})`);

    await fillPhoneNumber(targetPage, phoneInput, registeredPhone);
    await targetPage.waitForTimeout(1000);

    await clickNextButton(targetPage);
    await targetPage.waitForTimeout(2500);

    const pageContent = await targetPage.content();
    const isRejected = /This phone number cannot be used|Số điện thoại này không thể sử dụng|used too many times|đã được sử dụng quá nhiều lần|Try another number|Hãy thử số khác|format is not recognized|không được nhận dạng/i.test(pageContent);

    if (isRejected) {
      console.warn(`[reg-gmail] Google rejected number ${registeredPhone}. Releasing SMS order for refund...`);
      await captureDiagnostic(targetPage, `rejected-phone-${attempt}`).catch(() => {});
      await releaseSmsOrder(currentSmsOrder, config);
      currentSmsOrder = null;
      await targetPage.waitForTimeout(2000);
      continue;
    }

    const codeInput = targetPage.locator('input#code, input[name="code"], input[type="tel"]').first();
    if (await codeInput.isVisible({ timeout: 10000 }).catch(() => false)) {
      console.log(`[reg-gmail] Google accepted phone number. Waiting for SMS OTP...`);
      const otpCode = await waitSmsOtp(currentSmsOrder, config, {
        timeoutSec: 180,
        onProgress: (sec) => {
          if (sec % 15 === 0) console.log(`[SMS] Waiting for OTP... (${sec}s remaining)`);
        },
      });

      console.log(`[reg-gmail] Entering OTP: ${otpCode}`);
      await codeInput.fill(otpCode);
      await targetPage.waitForTimeout(1000);
      await clickNextButton(targetPage);
      await completeSmsOrder(currentSmsOrder, config);
      currentSmsOrder = null;
      phoneVerified = true;
      break;
    } else {
      console.warn(`[reg-gmail] Verification screen not reached. Releasing SMS order...`);
      await captureDiagnostic(targetPage, `no-verify-screen-${attempt}`).catch(() => {});
      await releaseSmsOrder(currentSmsOrder, config);
      currentSmsOrder = null;
    }
  }

  if (mobileTab) {
    console.log('[reg-gmail] Mobile verification completed. Closing mobile tab and returning to desktop...');
    await mobileTab.waitForTimeout(2000);
    await mobileTab.close().catch(() => {});
    await page.bringToFront().catch(() => {});
    await page.waitForTimeout(2000);
  }

  if (!phoneVerified) {
    throw new Error('Failed to verify phone number via SMS provider after 3 attempts');
  }

  return registeredPhone;
}

/**
 * Executes a single registration flow for one Gmail account.
 */
async function registerSingleGmail(options = {}) {
  const config = loadLocalConfig();
  const user = generateSyntheticUser();
  console.log(`[reg-gmail] Starting registration for: ${user.firstName} ${user.lastName} (${user.suggestedUsername})`);

  let proxy = null;
  let profileId = null;
  let browser = null;
  let page = null;
  let registeredPhone = '';
  let currentSmsOrder = null;

  try {
    // 1. Get Proxy
    if (config.customProxy) {
      console.log(`[reg-gmail] Using 4G Mobile proxy: ${config.customProxy}`);
      proxy = {
        proxyString: config.customProxy,
        publicIp: '113.185.51.124',
        isp: 'Vinaphone_4G',
      };
    } else {
      console.log('[reg-gmail] Fetching rotating IPv4 proxy...');
      proxy = await rotateProxyWithCooldown(config.proxyXoayKey, 60);
      console.log(`[reg-gmail] Proxy connected: ${proxy.proxyString} (Public IP: ${proxy.publicIp}, ISP: ${proxy.isp})`);
    }

    // 2. Create GPM Profile
    const profileName = `reg_gmail_${Date.now()}`;
    console.log(`[reg-gmail] Creating GPM Profile: ${profileName}...`);
    profileId = await createProfile(profileName, proxy.proxyString);
    console.log(`[reg-gmail] Created Profile ID: ${profileId}`);

    // 3. Start GPM Profile
    console.log('[reg-gmail] Starting Profile in GPM-Login...');
    const debugAddress = await startProfile(profileId);
    console.log(`[reg-gmail] Debug address: ${debugAddress}`);

    // 4. Connect Playwright via CDP with retry
    console.log('[reg-gmail] Connecting Playwright via CDP...');
    browser = await connectToGpmWithRetry(debugAddress);
    const defaultContext = browser.contexts()[0];
    page = defaultContext.pages()[0] || (await defaultContext.newPage());
    page.setDefaultTimeout(25000);

    // 5. Warmup on google.com to establish baseline trust cookies (NID, AEC, SOCS)
    console.log('[reg-gmail] Warming up session on google.com...');
    await defaultContext.addInitScript(() => {
      try {
        delete Navigator.prototype.webdriver;
        delete Object.getPrototypeOf(navigator).webdriver;
        delete navigator.webdriver;
      } catch (e) {}
    });

    await page.goto('https://www.google.com', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(3000);

    // Navigate to Google Signup with authentic referer
    console.log('[reg-gmail] Navigating to Google Signup with referer...');
    await page.goto('https://accounts.google.com/signup/v2/createaccount?flowName=GlifWebSignIn&flowEntry=SignUp', {
      referer: 'https://www.google.com/',
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(3000);

    // 6. Step 1: Names
    console.log('[reg-gmail] Filling Name...');
    const firstNameInput = page.locator('input[name="firstName"], #firstName').first();
    await firstNameInput.waitFor({ state: 'visible', timeout: 15000 });
    await think(1000, 2000);
    await typeHuman(page, firstNameInput, user.firstName);
    await think(500, 1200);

    const lastNameInput = page.locator('input[name="lastName"], #lastName').first();
    if (await lastNameInput.isVisible({ timeout: 1500 }).catch(() => false)) {
      await typeHuman(page, lastNameInput, user.lastName);
    }
    await think(1000, 1800);
    await clickNextButton(page);

    // 7. Step 2: Date of Birth & Gender (Material 3 Combobox & Inputs)
    console.log('[reg-gmail] Filling Birthday & Gender...');
    await think(1500, 2500);

    // Select Month
    const monthCombobox = page.locator('#month [role="combobox"], #month').first();
    if (await monthCombobox.isVisible({ timeout: 8000 }).catch(() => false)) {
      await clickHuman(page, monthCombobox);
      await think(500, 900);
      const monthOption = page.locator(`#month li[role="option"][data-value="${user.birthMonth}"]`).first();
      await clickHuman(page, monthOption);
      await think(400, 800);
    }

    // Enter Day
    const dayInput = page.locator('input#day, input[name="day"]').first();
    await dayInput.waitFor({ state: 'visible', timeout: 5000 });
    await typeHuman(page, dayInput, user.birthDay);
    await think(300, 700);

    // Enter Year
    const yearInput = page.locator('input#year, input[name="year"]').first();
    await yearInput.waitFor({ state: 'visible', timeout: 5000 });
    await typeHuman(page, yearInput, user.birthYear);
    await think(300, 700);

    // Select Gender (1: Male, 2: Female, 3: Rather not say)
    const genderCombobox = page.locator('#gender [role="combobox"], #gender').first();
    if (await genderCombobox.isVisible({ timeout: 5000 }).catch(() => false)) {
      await clickHuman(page, genderCombobox);
      await think(500, 900);
      const genderOption = page.locator(`#gender li[role="option"][data-value="${user.gender}"]`).first();
      await clickHuman(page, genderOption);
      await think(400, 800);
    }

    await think(1000, 1800);
    await clickNextButton(page);

    // 8. Step 3: Choose Username
    console.log('[reg-gmail] Choosing Username...');
    await think(2000, 3000);

    let finalEmail = '';
    const radioOptions = page.locator('input[type="radio"], div[role="radio"]');
    const radioCount = await radioOptions.count().catch(() => 0);

    if (radioCount >= 2) {
      console.log(`[reg-gmail] Found ${radioCount} username options. Selecting Google suggested username...`);
      await clickHuman(page, radioOptions.first());
      const parentText = await radioOptions.first().locator('..').textContent().catch(() => '');
      const match = /([a-zA-Z0-9._]+@gmail\.com)/.exec(parentText);
      if (match) finalEmail = match[1];
    } else {
      const usernameInput = page.locator('input[name="Username"], input[name="username"]').first();
      if (await usernameInput.isVisible({ timeout: 3000 }).catch(() => false)) {
        await typeHuman(page, usernameInput, user.suggestedUsername);
        finalEmail = `${user.suggestedUsername}@gmail.com`;
      }
    }
    await think(1000, 1800);
    await clickNextButton(page);
    await page.waitForTimeout(2500);

    // Check if username is taken (red warning / Available suggestions shown)
    const suggestionBtn = page.locator('button[data-username], ul[jsname="xBPsSd"] button').first();
    if (await suggestionBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      const suggestedName = (await suggestionBtn.getAttribute('data-username')) || (await suggestionBtn.innerText());
      console.log(`[reg-gmail] Username was taken. Selecting available suggestion: ${suggestedName}`);
      await clickHuman(page, suggestionBtn);
      finalEmail = `${suggestedName.trim()}@gmail.com`;
      await think(800, 1500);
      await clickNextButton(page);
    } else {
      const isTaken = page.locator('div[aria-live="assertive"]:has-text("taken"), div:has-text("Tên người dùng đó đã được sử dụng")').first();
      if (await isTaken.isVisible({ timeout: 1500 }).catch(() => false)) {
        const uniqueSuffix = Math.floor(10000 + Math.random() * 90000);
        const altUsername = `${user.suggestedUsername}${uniqueSuffix}`;
        console.log(`[reg-gmail] Username was taken. Retrying with: ${altUsername}`);
        const usernameInput = page.locator('input[name="Username"], input[name="username"]').first();
        await typeHuman(page, usernameInput, altUsername);
        finalEmail = `${altUsername}@gmail.com`;
        await think(800, 1500);
        await clickNextButton(page);
      }
    }

    // 9. Step 4: Password
    console.log('[reg-gmail] Entering Password...');
    await think(1500, 2500);
    const passInput = page.locator('input[name="Passwd"], input[name="password"]').first();
    await passInput.waitFor({ state: 'visible', timeout: 15000 });
    await typeHuman(page, passInput, user.password);

    const confirmPassInput = page.locator('input[name="PasswdAgain"], input[name="passwordAgain"]').first();
    if (await confirmPassInput.isVisible({ timeout: 1500 }).catch(() => false)) {
      await think(500, 1000);
      await typeHuman(page, confirmPassInput, user.password);
    }
    await think(1000, 2000);
    await clickNextButton(page);

    // 10. Step 5: Phone Number Verification (Direct or QR Code Mobile Tab)
    console.log('[reg-gmail] Reached Phone Verification step...');
    registeredPhone = await executePhoneVerification(page, config);

    // 11. Step 6: Recovery Email
    console.log('[reg-gmail] Handling Recovery Email step...');
    await page.waitForTimeout(2500);
    const recoveryDomain = config.catchAllDomain || 'mrhulkstore.store';
    const cleanUsername = user.suggestedUsername.replace(/[^a-zA-Z0-9]/g, '');
    const recoveryEmail = `${cleanUsername}@${recoveryDomain}`;
    let recoveryEmailSaved = 'NONE';

    const recoveryEmailInput = page.locator('input[type="email"], input[name="recoveryEmail"]').first();
    if (await recoveryEmailInput.isVisible({ timeout: 4000 }).catch(() => false)) {
      console.log(`[reg-gmail] Entering Recovery Email: ${recoveryEmail}`);
      await recoveryEmailInput.fill(recoveryEmail);
      await page.waitForTimeout(800);
      await clickNextButton(page);
      recoveryEmailSaved = recoveryEmail;
      await page.waitForTimeout(2000);
    } else {
      const skipButton = page.locator('button:has-text("Skip"), button:has-text("Bỏ qua")').first();
      if (await skipButton.isVisible({ timeout: 3000 }).catch(() => false)) {
        await skipButton.click();
        await page.waitForTimeout(1500);
      }
    }

    // 12. Step 7: Add Phone to Google Account (Skip)
    const skipPhoneBtn = page.locator('button:has-text("Skip"), button:has-text("Bỏ qua")').first();
    if (await skipPhoneBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await skipPhoneBtn.click();
      await page.waitForTimeout(1500);
    }

    // 13. Step 8: Review Account Info
    console.log('[reg-gmail] Reviewing Account Info...');
    const emailHeader = page.locator('div[data-email], div:has-text("@gmail.com")').first();
    if (await emailHeader.isVisible({ timeout: 3000 }).catch(() => false)) {
      const text = await emailHeader.innerText().catch(() => '');
      const m = /([a-zA-Z0-9._]+@gmail\.com)/.exec(text);
      if (m) finalEmail = m[1];
    }
    if (!finalEmail) finalEmail = `${user.suggestedUsername}@gmail.com`;
    console.log(`[reg-gmail] Account created: ${finalEmail}`);

    await clickNextButton(page);
    await page.waitForTimeout(2500);

    // 14. Step 9: Express Personalization & Terms
    console.log('[reg-gmail] Handling Personalization & Terms...');
    const expressRadio = page.locator('input[type="radio"][value="1"], div[role="radio"]').first();
    if (await expressRadio.isVisible({ timeout: 3000 }).catch(() => false)) {
      await expressRadio.click();
      await page.waitForTimeout(500);
      await clickNextButton(page);
      await page.waitForTimeout(1500);
    }

    const confirmBtn = page.locator('button:has-text("Confirm"), button:has-text("Xác nhận")').first();
    if (await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await confirmBtn.click();
      await page.waitForTimeout(1500);
    }

    const agreeBtn = page.locator('button:has-text("I agree"), button:has-text("Tôi đồng ý")').first();
    if (await agreeBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await agreeBtn.click();
      await page.waitForTimeout(4000);
    }

    // 15. Phase 2: Enable 2FA & Authenticator App
    console.log('[reg-gmail] Enabling 2FA (Authenticator App)...');
    let twoFactorSecret = '';

    try {
      await page.goto('https://myaccount.google.com/two-step-verification/authenticator', {
        waitUntil: 'domcontentloaded',
        timeout: 25000,
      });
      await page.waitForTimeout(3000);

      // If asked for password again
      const verifyPass = page.locator('input[type="password"]').first();
      if (await verifyPass.isVisible({ timeout: 3000 }).catch(() => false)) {
        await verifyPass.fill(user.password);
        await clickNextButton(page);
        await page.waitForTimeout(3000);
      }

      // Click "Set up authenticator" / "+ Thiết lập ứng dụng xác thực"
      const setupAuthBtn = page.locator('button:has-text("Set up authenticator"), button:has-text("Thiết lập"), div[role="button"]:has-text("Authenticator")').first();
      if (await setupAuthBtn.isVisible({ timeout: 8000 }).catch(() => false)) {
        await setupAuthBtn.click();
        await page.waitForTimeout(2000);

        // Click "Can't scan it?" / "Không quét được mã?" (Bilingual EN & VI)
        const cantScanBtn = page.locator('button:has-text("Can’t scan it?"), button:has-text("Can\'t scan it?"), button:has-text("Không thể quét"), button:has-text("Không quét được"), span:has-text("Can’t scan"), span:has-text("Không quét"), [aria-label*="scan"]').first();
        if (await cantScanBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
          await cantScanBtn.click();
          await page.waitForTimeout(1500);

          const dialogText = await page.locator('div[role="dialog"]').innerText().catch(() => '');
          const cleanText = dialogText.replace(/\s+/g, ' ');
          const secretMatch = /([A-Z2-7]{4}\s[A-Z2-7]{4}\s[A-Z2-7]{4}\s[A-Z2-7]{4}|[A-Z2-7]{16,32})/i.exec(cleanText);

          if (secretMatch) {
            twoFactorSecret = cleanSecret(secretMatch[1]);
            console.log(`[reg-gmail] Retrieved 2FA Secret Key: ${twoFactorSecret}`);

            const nextInsidePopup = page.locator('div[role="dialog"] button:has-text("Next"), div[role="dialog"] button:has-text("Tiếp theo"), div[role="dialog"] span:has-text("Next"), div[role="dialog"] span:has-text("Tiếp theo")').first();
            await nextInsidePopup.click();
            await page.waitForTimeout(1500);

            const totpCode = generateTOTP(twoFactorSecret);
            console.log(`[reg-gmail] Submitting TOTP Code: ${totpCode}`);

            const totpInput = page.locator('div[role="dialog"] input[type="text"], div[role="dialog"] input[type="tel"]').first();
            await totpInput.fill(totpCode);
            await page.waitForTimeout(800);

            const verifyBtn = page.locator('div[role="dialog"] button:has-text("Verify"), div[role="dialog"] button:has-text("Xác minh"), div[role="dialog"] span:has-text("Verify"), div[role="dialog"] span:has-text("Xác minh")').first();
            await verifyBtn.click();
            await page.waitForTimeout(3000);
            console.log('[reg-gmail] 2FA Authenticator activated successfully!');
          }
        }
      }
    } catch (twoFactorErr) {
      console.warn(`[reg-gmail] Notice on 2FA setup: ${twoFactorErr.message}`);
    }

    // 16. Fetch Backup Codes (Mã dự phòng - Bilingual EN & VI)
    let backupCodes = [];
    console.log('[reg-gmail] Fetching Backup Codes...');
    try {
      await page.goto('https://myaccount.google.com/two-step-verification/backup-codes', {
        waitUntil: 'domcontentloaded',
        timeout: 25000,
      });
      await page.waitForTimeout(3000);

      const verifyPass = page.locator('input[type="password"]').first();
      if (await verifyPass.isVisible({ timeout: 3000 }).catch(() => false)) {
        await verifyPass.fill(user.password);
        await clickNextButton(page);
        await page.waitForTimeout(3000);
      }

      const getCodesBtn = page.locator('button:has-text("Get backup codes"), button:has-text("Nhận mã dự phòng"), a:has-text("Get backup codes"), a:has-text("Nhận mã dự phòng"), span:has-text("Get backup codes"), span:has-text("Nhận mã dự phòng")').first();
      if (await getCodesBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await getCodesBtn.click();
        await page.waitForTimeout(2500);
      }

      const pageText = await page.locator('body').innerText().catch(() => '');
      const matches = pageText.match(/\b\d{4}\s\d{4}\b/g);
      if (matches && matches.length >= 10) {
        backupCodes = matches.slice(0, 10).map((c) => c.replace(/\s+/g, ''));
        console.log(`[reg-gmail] Retrieved ${backupCodes.length} Backup Codes: ${backupCodes.join(',')}`);
      }
    } catch (backupErr) {
      console.warn(`[reg-gmail] Notice on fetching backup codes: ${backupErr.message}`);
    }

    // 17. Save Result in exact requested format:
    // Gmail | Pass | Recovery_Email | 2FA_Secret | Backup_Codes | Profile_ID / Proxy_Info
    const accountRecord = {
      email: finalEmail,
      password: user.password,
      recoveryEmail: recoveryEmailSaved,
      twoFactorSecret: twoFactorSecret || 'NONE',
      backupCodes: backupCodes.length > 0 ? backupCodes.join(',') : 'NONE',
      profileId: profileId || 'DELETED',
      proxyInfo: proxy ? proxy.proxyString : 'NONE',
      phone: registeredPhone,
      createdAt: new Date().toISOString(),
    };

    saveAccountRecord(accountRecord);
    return accountRecord;
  } catch (err) {
    console.error(`[reg-gmail] Error during registration: ${err.message}`);
    if (page) {
      await captureDiagnostic(page, 'fatal-error').catch(() => {});
    }
    if (currentSmsOrder) {
      await releaseSmsOrder(currentSmsOrder, config);
    }
    throw err;
  } finally {
    // 18. Cleanup (Auto-delete profile as requested)
    if (browser) {
      await browser.close().catch(() => {});
    }
    if (profileId) {
      console.log(`[reg-gmail] Stopping GPM profile ${profileId}...`);
      await stopProfile(profileId).catch(() => {});
      console.log(`[reg-gmail] Deleting GPM profile ${profileId}...`);
      await deleteProfile(profileId).catch(() => {});
    }
  }
}

/**
 * Saves record to files with exact format:
 * Gmail | Pass | Recovery_Email | 2FA_Secret | Backup_Codes | Profile_ID / Proxy_Info
 */
function saveAccountRecord(record) {
  const rootDir = path.resolve(__dirname, '..');
  const txtFile = path.join(rootDir, 'gmail_accounts.txt');
  const jsonFile = path.join(rootDir, 'gmail_accounts.json');

  const proxyDisplay = `${record.profileId} / ${record.proxyInfo}`;
  const line = `${record.email} | ${record.password} | ${record.recoveryEmail} | ${record.twoFactorSecret} | ${record.backupCodes} | ${proxyDisplay}\n`;

  fs.appendFileSync(txtFile, line, 'utf8');

  console.log(`\n======================================================`);
  console.log(`[SUCCESS] Account Saved:`);
  console.log(line.trim());
  console.log(`======================================================\n`);

  let list = [];
  if (fs.existsSync(jsonFile)) {
    try {
      list = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
    } catch {}
  }
  list.push(record);
  fs.writeFileSync(jsonFile, JSON.stringify(list, null, 2), 'utf8');
}

module.exports = {
  registerSingleGmail,
  generateSyntheticUser,
  saveAccountRecord,
  rentSmsNumber,
};
