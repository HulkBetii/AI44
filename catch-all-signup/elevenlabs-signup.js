/**
 * elevenlabs-signup.js (catch-all-signup)
 * Core automation engine for ElevenLabs registration using Catch-All email and IMAP verification.
 */

const path = require('path');
const fs = require('fs');
const { solveCaptcha } = require('../captcha-solver');
const {
  typeHuman,
  clickHuman,
  think,
  smoothScroll,
  generateRealisticName,
} = require('../human-behavior');
const { waitForElevenLabsVerifyEmail } = require('./imap-client');
const { updateAccountStatus, updateAccountResult } = require('./sheets');
const { collectSecretValues, collectUrlSecrets, redactSecrets } = require('../secret-sanitizer');

const SIGN_IN_EMAIL_SELECTOR = '[data-testid="sign-in-email-input"]';
const SIGN_IN_PASSWORD_SELECTOR = '[data-testid="sign-in-password-input"]';
const SIGN_IN_SUBMIT_SELECTOR = 'button[style*="view-transition-name: submit"]';
const SURVEY_OPTION_SELECTOR = '[data-agent-id^="onboarding-icon-option-"], [data-agent-id^="onboarding-illustration-option-"]';
const ONBOARDING_TIMEOUT_MS = 120000;
const STEP_RENDER_TIMEOUT_MS = 20000;

const SIGN_IN = {
  OK: 'ok',
  UNVERIFIED: 'unverified',
  REJECTED: 'rejected',
};

function safeErrorText(error, secrets = []) {
  const secretList = collectSecretValues({ extra: secrets });
  return redactSecrets(error?.stack || error?.message || error, secretList);
}

async function firstOutcome(candidates, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, timeoutMs);

    for (const { value, promise } of candidates) {
      promise
        .then(() => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(value);
          }
        })
        .catch(() => {});
    }
  });
}

/**
 * Handle sign-in after email verification
 */
async function attemptSignIn(page, email, password) {
  console.log('[signin] Entering credentials...');
  await page.waitForTimeout(1000);

  if (page.url().includes('sign-in')) {
    await page.waitForSelector(SIGN_IN_EMAIL_SELECTOR, { timeout: 15000 }).catch(() => {});
  } else {
    await page.goto('https://elevenlabs.io/app/sign-in', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(SIGN_IN_EMAIL_SELECTOR, { timeout: 15000 });
  }

  await page.waitForTimeout(800 + Math.random() * 500);
  await typeHuman(page, SIGN_IN_EMAIL_SELECTOR, email);
  await page.waitForTimeout(300);
  await typeHuman(page, SIGN_IN_PASSWORD_SELECTOR, password);
  await page.waitForTimeout(400);
  await clickHuman(page, SIGN_IN_SUBMIT_SELECTOR);
  await page.waitForTimeout(600);

  if (page.url().includes('sign-in')) {
    await page.keyboard.press('Enter').catch(() => {});
  }

  const rejectionMatcher = page.locator('text=/No user is found|Incorrect email|Incorrect password|Invalid credentials|Wrong password|Invalid email|Unable to sign in/i')
    .or(page.getByText('No user is found', { exact: false }))
    .or(page.getByText('Incorrect email', { exact: false }))
    .or(page.getByText('Incorrect password', { exact: false }))
    .or(page.getByText('Invalid credentials', { exact: false }))
    .or(page.getByText('Unable to sign in', { exact: false }));

  const SETTLE_MS = 30000;
  const outcome = await firstOutcome([
    {
      value: SIGN_IN.OK,
      promise: page.waitForURL((url) => !url.toString().includes('sign-in'), { timeout: SETTLE_MS }),
    },
    {
      value: SIGN_IN.UNVERIFIED,
      promise: page.getByText('verification link', { exact: false }).waitFor({ timeout: SETTLE_MS }),
    },
    {
      value: SIGN_IN.REJECTED,
      promise: rejectionMatcher.first().waitFor({ timeout: SETTLE_MS }),
    },
  ], SETTLE_MS);

  if (!page.url().includes('sign-in')) return SIGN_IN.OK;
  if (!outcome) {
    const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (/No user is found|Incorrect email|Incorrect password|Invalid credentials|Wrong password|Invalid email|Unable to sign in/i.test(bodyText)) {
      return SIGN_IN.REJECTED;
    }
    if (/verification link/i.test(bodyText)) {
      return SIGN_IN.UNVERIFIED;
    }
    throw new Error('Sign-in gave no recognised outcome');
  }
  return outcome;
}

/**
 * Grant all permissions in API key dialog
 */
async function grantAllPermissions(page) {
  const dialog = page.getByRole('dialog');
  const restrictToggle = dialog.getByRole('switch').first();
  if (await restrictToggle.count() === 0) {
    throw new Error('Restrict Key toggle not found in dialog');
  }
  if (await restrictToggle.getAttribute('aria-checked') !== 'true') {
    await clickHuman(page, restrictToggle);
    await page.waitForTimeout(400);
  }

  const groups = dialog.locator('[role="tablist"]');
  const total = await groups.count();
  if (total === 0) throw new Error('No endpoint permission groups found in dialog');

  for (let i = 0; i < total; i++) {
    const group = groups.nth(i);
    const write = group.locator('button[id$="-trigger-write"]');
    const target = (await write.count()) > 0
      ? write.first()
      : group.locator('button[id$="-trigger-access"]').first();

    if (await target.count() === 0) continue;
    if (await target.getAttribute('aria-selected') !== 'true') {
      await clickHuman(page, target);
      await page.waitForTimeout(80);
    }
  }
}

/**
 * Finish onboarding steps and create API key
 */
async function finishOnboardingAndKey(page, account, password) {
  console.log('[onboarding] Navigating onboarding steps...');
  const { firstName } = generateRealisticName();
  const ADVANCE_BUTTONS = ['Continue', 'Next', 'Skip', 'Get started', 'Got it'];
  const onboardingDeadline = Date.now() + ONBOARDING_TIMEOUT_MS;

  while (page.url().includes('/app/onboarding')) {
    if (Date.now() > onboardingDeadline) {
      throw new Error(`Onboarding did not finish within ${ONBOARDING_TIMEOUT_MS}ms.`);
    }

    await page.waitForFunction(() => document.body.innerText.trim().length > 0, {
      timeout: STEP_RENDER_TIMEOUT_MS,
    }).catch(() => {});

    await think(1200, 2500);

    // Randomized survey option click
    if (Math.random() < 0.7) {
      const surveyOptions = page.locator(SURVEY_OPTION_SELECTOR);
      const optCount = await surveyOptions.count().catch(() => 0);
      if (optCount > 0) {
        const randIdx = Math.floor(Math.random() * optCount);
        const opt = surveyOptions.nth(randIdx);
        if (await opt.isVisible().catch(() => false)) {
          await clickHuman(page, opt).catch(() => {});
          await think(500, 1200);
        }
      }
    }

    // Age / Name form if present
    if (await page.$('#firstname')) {
      await typeHuman(page, '#firstname', firstName);
      await page.waitForTimeout(500);
      const ageCheckbox = await page.$('button[role="checkbox"]')
        || await page.$('.checkbox-hitarea')
        || await page.$('input[type="checkbox"][name*="adult"]');
      if (ageCheckbox && await ageCheckbox.getAttribute('aria-checked') !== 'true') {
        await clickHuman(page, ageCheckbox);
        await page.waitForTimeout(400);
      }
    }

    let advanced = false;
    for (const label of ADVANCE_BUTTONS) {
      const byRole = page.getByRole('button', { name: label, exact: true });
      const byText = page.getByText(label, { exact: true });
      let control = null;
      for (const candidate of [byRole, byText]) {
        const first = candidate.first();
        if (await first.count().catch(() => 0) === 0) continue;
        if (!await first.isVisible().catch(() => false)) continue;
        control = first;
        break;
      }
      if (!control) continue;

      await clickHuman(page, control).catch(() => {});
      await page.waitForTimeout(1500);
      advanced = true;
      break;
    }

    if (!advanced) await page.waitForTimeout(1000);
  }

  // Welcome banners
  await page.waitForSelector('button:has-text("Got it")', { timeout: 3000 })
    .then(() => clickHuman(page, 'button:has-text("Got it")'))
    .catch(() => {});

  // Create API Key
  console.log('[apikey] Navigating to API keys page...');
  await page.goto('https://elevenlabs.io/app/developers/api-keys', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  await page.waitForSelector('button:has-text("Got it")', { timeout: 4000 })
    .then(() => page.click('button:has-text("Got it")'))
    .catch(() => {});
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape');

  await page.waitForSelector('button:has-text("Create Key")', { timeout: 15000 });
  await clickHuman(page, 'button:has-text("Create Key")');
  await page.waitForTimeout(1000);

  const keyName = 'Key-' + Math.random().toString(36).slice(2, 8).toUpperCase();
  await page.waitForSelector('input[placeholder="API Key Name"]', { timeout: 10000 });
  await page.fill('input[placeholder="API Key Name"]', keyName);
  await page.waitForTimeout(500);

  await grantAllPermissions(page);

  await page.getByRole('dialog').getByRole('button', { name: 'Create Key', exact: true }).last().click({ timeout: 10000 });
  await page.waitForTimeout(1000);

  // Confirm dialog if shown
  const confirmCreate = page.locator('button[data-agent-protected="true"]', { hasText: 'Create Key' });
  if (await confirmCreate.count() > 0) {
    await clickHuman(page, confirmCreate.last());
    await page.waitForTimeout(1500);
  }

  const keyDialog = page.getByRole('dialog');
  await page.getByRole('button', { name: 'Copy to Clipboard', exact: true }).click({ timeout: 15000 });
  await page.waitForTimeout(500);

  let apiKey = await keyDialog.locator('input[readonly]').first().inputValue().catch(() => '');
  if (!apiKey) {
    await page.bringToFront();
    apiKey = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
  }

  if (!apiKey || !apiKey.startsWith('sk_')) {
    throw new Error('API key was not captured in expected format (sk_...)');
  }

  console.log(`[apikey] ✅ API Key captured: ${apiKey.slice(0, 7)}...`);
  return apiKey;
}

/**
 * Register a single ElevenLabs account using Catch-All email and IMAP verification
 * @param {import('playwright').BrowserContext} ctx
 * @param {Object} account - { rowIndex, email, password, firstName, lastName }
 * @param {string} proxyString
 */
async function registerAccount(ctx, account, proxyString = '') {
  const { rowIndex, email, password } = account;
  console.log(`\n============================================================`);
  console.log(`▶ [Catch-All Signup] Starting: ${email} (row ${rowIndex})`);
  console.log(`============================================================`);

  let currentStep = 'init';
  let activePage = null;

  try {
    // 1. Open ElevenLabs sign-up page
    currentStep = 'navigate-signup';
    await updateAccountStatus(rowIndex, 'processing');
    const page = await ctx.newPage();
    activePage = page;

    await page.goto('https://elevenlabs.io', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }).catch(() => {});

    await page.goto('https://elevenlabs.io/app/sign-up', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="sign-up-email-input"]', { state: 'visible', timeout: 25000 });

    await think(1500, 3000);
    await smoothScroll(page);

    // 2. Type credentials
    currentStep = 'fill-signup-form';
    await page.waitForTimeout(800 + Math.random() * 500);
    await typeHuman(page, '[data-testid="sign-up-email-input"]', email);
    await page.waitForTimeout(400 + Math.random() * 300);
    await typeHuman(page, '[data-testid="sign-up-password-input"]', password);
    await page.waitForTimeout(600 + Math.random() * 400);

    const verificationRequestedAt = Date.now() - 5000; // clock skew padding

    // 3. Submit form and handle CAPTCHA
    currentStep = 'submit-signup';
    console.log('[signup] Submitting registration form...');
    await clickHuman(page, 'button[style*="view-transition-name: submit"]');

    // Function to check if account already exists banner is showing
    const checkAccountExists = async () => {
      return await page.evaluate(() => {
        const body = document.body ? document.body.innerText : '';
        return /already exists|already registered|already in use|Sign in or reset your password/i.test(body);
      }).catch(() => false);
    };

    // Wait up to 2.5s for either "already exists" banner or CAPTCHA modal
    let alreadyExists = false;
    for (let check = 0; check < 5; check++) {
      await page.waitForTimeout(500);
      alreadyExists = await checkAccountExists();
      if (alreadyExists) break;
    }

    if (!alreadyExists && page.url().includes('sign-up')) {
      currentStep = 'solve-captcha';
      await updateAccountStatus(rowIndex, 'captcha-solving');
      let autoResult = await solveCaptcha(page, proxyString, { preferredProvider: '2captcha' }).catch((err) => {
        console.warn(`[captcha] Solver threw: ${safeErrorText(err, [password])}`);
        return { solved: false, reason: err.message };
      });

      if (autoResult?.alreadyRegistered) {
        alreadyExists = true;
      } else if (autoResult?.solved) {
        console.log(`[captcha] Solved via ${autoResult.solver}`);
        await page.waitForTimeout(1500);
        if (page.url().includes('sign-up')) {
          const submitBtn = await page.$('button[style*="view-transition-name: submit"]');
          if (submitBtn) await submitBtn.evaluate((b) => b.click()).catch(() => {});
        }
        await page.waitForTimeout(3000);
      } else if (page.url().includes('sign-up')) {
        alreadyExists = await checkAccountExists();
        if (!alreadyExists) {
          // Retry once: click Sign up again to pop up a fresh CAPTCHA challenge
          console.log('[captcha] First solve attempt timed out/failed. Re-clicking Sign up to refresh CAPTCHA...');
          const submitBtn = await page.$('button[style*="view-transition-name: submit"]');
          if (submitBtn) await submitBtn.evaluate((b) => b.click()).catch(() => {});
          await page.waitForTimeout(2000);

          autoResult = await solveCaptcha(page, proxyString, { preferredProvider: '2captcha' }).catch((err) => ({ solved: false, reason: err.message }));
          if (autoResult?.alreadyRegistered) {
            alreadyExists = true;
          } else if (autoResult?.solved) {
            console.log(`[captcha] Solved on retry via ${autoResult.solver}`);
            await page.waitForTimeout(1500);
            if (page.url().includes('sign-up')) {
              const btn = await page.$('button[style*="view-transition-name: submit"]');
              if (btn) await btn.evaluate((b) => b.click()).catch(() => {});
            }
            await page.waitForTimeout(3000);
          }
        }
      }

      if (!alreadyExists) {
        alreadyExists = await checkAccountExists();
      }
    }

    // Smart Recovery: If account already exists in ElevenLabs, bypass signup and sign in directly
    if (alreadyExists) {
      console.log(`[signup] ℹ️ Account ${email} already exists on ElevenLabs. Switching to Direct Sign-In Recovery...`);
      currentStep = 'direct-signin-recovery';
      const signinPage = await ctx.newPage();
      activePage = signinPage;
      const outcome = await attemptSignIn(signinPage, email, password);

      if (outcome === SIGN_IN.OK) {
        const apiKey = await finishOnboardingAndKey(signinPage, account, password);
        await updateAccountResult(rowIndex, { apiKey, elevenPass: password, status: 'complete' });
        console.log(`\n🎉 RECOVERED & COMPLETED [${email}]: API Key = ${apiKey}`);
        return { success: true, apiKey };
      }

      if (outcome === SIGN_IN.UNVERIFIED) {
        console.log(`[imap] Account unverified. Searching IMAP for existing verification email...`);
        const verifyData = await waitForElevenLabsVerifyEmail(email, {
          sentAfter: 0, // no time limit, search for any verification email for this alias
          timeoutMs: 90000,
        });
        const vPage = await ctx.newPage();
        activePage = vPage;
        await vPage.goto(verifyData.verifyUrl, { waitUntil: 'domcontentloaded' });
        await vPage.waitForSelector('button:has-text("Continue")', { timeout: 20000 });
        await clickHuman(vPage, 'button:has-text("Continue")');
        await vPage.waitForTimeout(2000);

        const outcomeAfterVerify = await attemptSignIn(vPage, email, password);
        if (outcomeAfterVerify === SIGN_IN.OK) {
          const apiKey = await finishOnboardingAndKey(vPage, account, password);
          await updateAccountResult(rowIndex, { apiKey, elevenPass: password, status: 'complete' });
          console.log(`\n🎉 RECOVERED & COMPLETED [${email}]: API Key = ${apiKey}`);
          return { success: true, apiKey };
        }
      }

      if (outcome === SIGN_IN.REJECTED) {
        console.log(`[recovery] Password rejected for ${email}. Triggering automatic Password Reset...`);
        try {
          const resetPage = await ctx.newPage();
          activePage = resetPage;
          await resetPage.goto('https://elevenlabs.io/app/forgot-password', { waitUntil: 'domcontentloaded' });
          await resetPage.waitForSelector('input[type="email"], input[name="email"]', { timeout: 15000 });
          await typeHuman(resetPage, 'input[type="email"], input[name="email"]', email);
          await resetPage.waitForTimeout(500);
          await clickHuman(resetPage, 'button[type="submit"], button:has-text("Send reset link"), button:has-text("Reset Password")');
          await resetPage.waitForTimeout(3000);

          console.log(`[imap] Waiting for password reset email sent to ${email}...`);
          const resetData = await waitForElevenLabsVerifyEmail(email, {
            sentAfter: Date.now() - 30000,
            timeoutMs: 60000,
          });

          console.log(`[recovery] Opening reset password URL: ${resetData.verifyUrl}`);
          await resetPage.goto(resetData.verifyUrl, { waitUntil: 'domcontentloaded' });
          await resetPage.waitForSelector('input[type="password"]', { timeout: 20000 });
          await typeHuman(resetPage, 'input[type="password"]', password);
          await resetPage.waitForTimeout(500);
          const pwInputs = await resetPage.$$('input[type="password"]');
          if (pwInputs.length > 1) {
            await pwInputs[1].fill(password);
          }
          await clickHuman(resetPage, 'button[type="submit"], button:has-text("Save"), button:has-text("Reset password"), button:has-text("Continue")');
          await resetPage.waitForTimeout(3000);

          const postResetOutcome = await attemptSignIn(resetPage, email, password);
          if (postResetOutcome === SIGN_IN.OK) {
            const apiKey = await finishOnboardingAndKey(resetPage, account, password);
            await updateAccountResult(rowIndex, { apiKey, elevenPass: password, status: 'complete' });
            console.log(`\n🎉 PASSWORD RESET & COMPLETED [${email}]: API Key = ${apiKey}`);
            return { success: true, apiKey };
          }
        } catch (resetErr) {
          console.warn(`[recovery] Password reset attempt failed: ${resetErr.message}`);
        }
      }

      const err = new Error(`Email ${email} is already registered on ElevenLabs`);
      err.code = 'ALREADY_REGISTERED';
      throw err;
    }

    // 4. Poll IMAP for verification email
    currentStep = 'wait-imap-verify';
    await updateAccountStatus(rowIndex, 'verify-wait');
    console.log(`[imap] Waiting for verification email sent to ${email}...`);

    const verifyData = await waitForElevenLabsVerifyEmail(email, {
      sentAfter: verificationRequestedAt,
      timeoutMs: 120000,
    });

    const verifyUrl = verifyData.verifyUrl;
    console.log(`[imap] Received verify URL: ${verifyUrl}`);

    // 5. Open verification link
    currentStep = 'open-verify-link';
    const verifyPage = await ctx.newPage();
    activePage = verifyPage;
    await verifyPage.goto(verifyUrl, { waitUntil: 'domcontentloaded' });

    // 6. Click Continue button
    currentStep = 'confirm-verify';
    await verifyPage.waitForSelector('button:has-text("Continue")', { timeout: 20000 });
    await clickHuman(verifyPage, 'button:has-text("Continue")');
    await verifyPage.waitForTimeout(2000);

    // 7. Sign in, complete onboarding, and extract API Key
    currentStep = 'signin-and-create-key';
    const outcome = await attemptSignIn(verifyPage, email, password);
    if (outcome !== SIGN_IN.OK) {
      throw new Error(`Sign-in after verify did not complete (${outcome})`);
    }

    const apiKey = await finishOnboardingAndKey(verifyPage, account, password);

    // 8. Update Google Sheet with complete status and API Key
    await updateAccountResult(rowIndex, {
      apiKey,
      elevenPass: password,
      status: 'complete',
    });

    console.log(`\n🎉 SUCCESS [${email}]: API Key = ${apiKey}`);
    return { success: true, apiKey };
  } catch (err) {
    console.error(`\n❌ FAILED [${email}] at step '${currentStep}': ${safeErrorText(err, [password])}`);

    let failStatus = `failed:${currentStep}`;
    if (err.code === 'ALREADY_REGISTERED') failStatus = 'already-registered';
    else if (err.message && /captcha/i.test(err.message)) failStatus = 'failed:captcha';
    else if (err.message && /timed out waiting for elevenlabs verification email/i.test(err.message)) failStatus = 'failed:verify-timeout';
    else if (/net::ERR_|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up/i.test(err.message)) failStatus = 'failed:network';

    await updateAccountStatus(rowIndex, failStatus).catch(() => {});

    // Save failure screenshot
    if (activePage && !activePage.isClosed()) {
      try {
        const shotPath = path.join(__dirname, '..', `debug-failure-catchall-row${rowIndex}.png`);
        await activePage.screenshot({ path: shotPath, fullPage: true });
        console.log(`[debug] Saved screenshot to ${shotPath}`);
      } catch {}
    }

    throw err;
  }
}

module.exports = {
  SIGN_IN,
  attemptSignIn,
  grantAllPermissions,
  finishOnboardingAndKey,
  registerAccount,
};
