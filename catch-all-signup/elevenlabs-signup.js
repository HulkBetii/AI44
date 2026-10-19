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
  warmUpLandingPage,
  warmUpDashboard,
} = require('../human-behavior');
const { waitForElevenLabsVerifyEmail } = require('./imap-client');
const { updateAccountStatus, updateAccountResult } = require('./sheets');
const { collectSecretValues, collectUrlSecrets, redactSecrets } = require('../secret-sanitizer');
const { testElevenLabsTts } = require('./tts-tester');

const SIGN_IN_EMAIL_SELECTOR = '[data-testid="sign-in-email-input"]';
const SIGN_IN_PASSWORD_SELECTOR = '[data-testid="sign-in-password-input"]';
const SIGN_IN_SUBMIT_SELECTOR = 'button[style*="view-transition-name: submit"]';

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
 * Create a Token Sniffer that listens to all outgoing requests in a browser context.
 * Resolves as soon as any request contains an Authorization Bearer header for ElevenLabs.
 */
function createTokenSniffer(ctx) {
  let capturedToken = null;
  const listeners = [];

  const requestListener = (req) => {
    try {
      const url = req.url();
      if (!url.includes('elevenlabs.io')) return;

      const headers = req.headers ? req.headers() : {};
      const auth = headers['authorization'] || headers['Authorization'];
      if (auth && typeof auth === 'string') {
        const clean = auth.replace(/^Bearer\s+/i, '').trim();
        // Valid ElevenLabs Bearer token is non-empty and reasonably long (>20 chars)
        if (clean.length > 20) {
          capturedToken = clean;
          console.log(`[token] ✅ Captured Bearer token (${clean.slice(0, 10)}...${clean.slice(-6)}) from ${url.split('?')[0]}`);
          while (listeners.length > 0) {
            listeners.shift()(clean);
          }
        }
      }
    } catch {
      // Ignore transient errors if context/page closes
    }
  };

  ctx.on('request', requestListener);

  return {
    getToken: () => capturedToken,
    waitForToken: (timeoutMs = 45000) => {
      if (capturedToken) return Promise.resolve(capturedToken);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = listeners.indexOf(onToken);
          if (idx !== -1) listeners.splice(idx, 1);
          reject(new Error(`Timed out waiting for ElevenLabs Bearer token after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);

        const onToken = (token) => {
          clearTimeout(timer);
          resolve(token);
        };
        listeners.push(onToken);
      });
    },
    cleanup: () => {
      try { ctx.off('request', requestListener); } catch {}
    },
  };
}

/**
 * Robustly acquire the Bearer token: return if already sniffed, or wait and trigger speech-synthesis if needed.
 */
async function acquireToken(sniffer, page, timeoutMs = 30000) {
  const token = sniffer.getToken();
  if (token) return token;

  try {
    return await sniffer.waitForToken(8000);
  } catch {
    if (page && !page.isClosed()) {
      console.log('[token] Triggering authenticated requests via speech-synthesis...');
      await page.goto('https://elevenlabs.io/app/speech-synthesis', { waitUntil: 'domcontentloaded' }).catch(() => {});
    }
    return await sniffer.waitForToken(timeoutMs);
  }
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
  const sniffer = createTokenSniffer(ctx);

  try {
    // 1. Warm-up session on landing page and navigate to sign-up
    currentStep = 'navigate-signup';
    await updateAccountStatus(rowIndex, 'processing');
    const page = await ctx.newPage();
    activePage = page;

    // Organic warm-up: visits landing page, scrolls, wanders mouse, clicks Sign Up CTA
    await warmUpLandingPage(page);

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
        return /account already exists|Sign in or reset your password|email is already in use/i.test(body);
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
        currentStep = 'capture-token';
        console.log(`[token] Intercepting Bearer token for ${email}...`);
        const apiKey = await acquireToken(sniffer, signinPage);
        await updateAccountResult(rowIndex, { apiKey, elevenPass: password, status: 'complete' });
        console.log(`\n🎉 RECOVERED & COMPLETED [${email}]: Bearer Token = ${apiKey.slice(0, 10)}...`);
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
          currentStep = 'capture-token';
          console.log(`[token] Intercepting Bearer token for ${email}...`);
          const apiKey = await acquireToken(sniffer, vPage);
          await updateAccountResult(rowIndex, { apiKey, elevenPass: password, status: 'complete' });
          console.log(`\n🎉 RECOVERED & COMPLETED [${email}]: Bearer Token = ${apiKey.slice(0, 10)}...`);
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
            currentStep = 'capture-token';
            console.log(`[token] Intercepting Bearer token for ${email}...`);
            const apiKey = await acquireToken(sniffer, resetPage);

            // Test call API TTS immediately after acquiring key
            console.log(`[tts-test] 🎙️ Testing live Text-to-Speech (TTS) call with acquired key...`);
            let ttsResult = null;
            try {
              ttsResult = await testElevenLabsTts(apiKey);
              if (ttsResult.success) {
                console.log(`[tts-test] ✅ TTS API test SUCCEEDED! Generated ${ttsResult.audioSizeBytes} bytes audio.`);
              } else if (ttsResult.detectedUnusualActivity) {
                console.warn(`[tts-test] ⚠️ TTS API test: detected_unusual_activity (Free tier generation restricted).`);
              } else {
                console.warn(`[tts-test] ⚠️ TTS API test: HTTP ${ttsResult.status} - ${ttsResult.message}`);
              }
            } catch (ttsErr) {
              console.warn(`[tts-test] ⚠️ TTS API test error: ${ttsErr.message}`);
            }

            await updateAccountResult(rowIndex, { apiKey, elevenPass: password, status: 'complete' });
            console.log(`\n🎉 PASSWORD RESET & COMPLETED [${email}]: Bearer Token = ${apiKey.slice(0, 10)}...`);
            return { success: true, apiKey, ttsResult };
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

    // 7. Sign in and intercept Bearer Token
    currentStep = 'capture-token';
    const outcome = await attemptSignIn(verifyPage, email, password);
    if (outcome !== SIGN_IN.OK) {
      throw new Error(`Sign-in after verify did not complete (${outcome})`);
    }

    console.log(`[token] Intercepting Bearer token for ${email}...`);
    const apiKey = await acquireToken(sniffer, verifyPage);

    // 8. Human warm-up on dashboard to establish legitimate session telemetry
    await warmUpDashboard(verifyPage);

    // 9. Test call API TTS immediately after acquiring key
    console.log(`[tts-test] 🎙️ Testing live Text-to-Speech (TTS) call with acquired key...`);
    let ttsResult = null;
    try {
      ttsResult = await testElevenLabsTts(apiKey);
      if (ttsResult.success) {
        console.log(`[tts-test] ✅ TTS API test SUCCEEDED! Generated ${ttsResult.audioSizeBytes} bytes audio.`);
      } else if (ttsResult.detectedUnusualActivity) {
        console.warn(`[tts-test] ⚠️ TTS API test: detected_unusual_activity (Free tier generation restricted).`);
      } else {
        console.warn(`[tts-test] ⚠️ TTS API test: HTTP ${ttsResult.status} - ${ttsResult.message}`);
      }
    } catch (ttsErr) {
      console.warn(`[tts-test] ⚠️ TTS API test error: ${ttsErr.message}`);
    }

    // 9. Update Google Sheet with complete status and Bearer Token
    await updateAccountResult(rowIndex, {
      apiKey,
      elevenPass: password,
      status: 'complete',
    });

    console.log(`\n🎉 SUCCESS [${email}]: Bearer Token = ${apiKey.slice(0, 10)}...`);
    return { success: true, apiKey, ttsResult };
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
  } finally {
    sniffer.cleanup();
  }
}

module.exports = {
  SIGN_IN,
  attemptSignIn,
  createTokenSniffer,
  registerAccount,
  testElevenLabsTts,
};
