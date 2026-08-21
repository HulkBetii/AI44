const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { clickHuman, typeHuman, generateRealisticName } = require('../human-behavior.js');

// The onboarding half of finishOnboardingAndKey, lifted out so it can be driven without the
// API-key half (which needs a real ElevenLabs dialog).
const src = fs.readFileSync(path.join(__dirname, '..', 'signup-hotmail.js'), 'utf8');
const whole = src.match(/async function finishOnboardingAndKey\([\s\S]*?\n\}/)[0];
const onboardingOnly = whole.slice(0, whole.indexOf('  // 9. Create API key')) + '\n}';
// Two instances: a generous deadline for the real flows, and a short one for the case
// meant to time out, so the suite does not sit waiting for it.
const build = (deadlineMs) => new Function(
  'step', 'clickHuman', 'typeHuman', 'generateRealisticName',
  'ONBOARDING_TIMEOUT_MS', 'STEP_RENDER_TIMEOUT_MS',
  `return ${onboardingOnly}`,
)(() => {}, clickHuman, typeHuman, generateRealisticName, deadlineMs, 6000);

const finishOnboarding = build(60000);
const finishOnboardingQuick = build(5000);

// Served from the onboarding path so the loop's /app/onboarding check is meaningful.
async function serveOnboarding(page, steps, splashMs = 0, asSpan = false) {
  const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'onboarding.html'), 'utf8');
  await page.route('https://elevenlabs.io/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: html }));
  await page.goto(`https://elevenlabs.io/app/onboarding?steps=${steps}&splash=${splashMs}&span=${asSpan ? 1 : 0}`);
}

(async () => {
  const browser = await chromium.launch();

  // The regression: a "Choose your platform" screen appeared ahead of the name form, and the
  // old fixed sequence walked past it and left onboarding unfinished.
  {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    await serveOnboarding(page, 'platform,name,role,interests,pricing');
    await finishOnboarding(page, 1, 'a@example.com', 'pw');
    assert.ok(!page.url().includes('/app/onboarding'), `still on onboarding: ${page.url()}`);
    const typed = await page.evaluate(() => window.__nameTyped);
    assert.ok(typed && typed.length > 0, 'the name form should have been filled');

    console.log(`✓ walks a platform → name → skip → skip flow to completion (name: ${typed})`);
    await page.close();
  }

  // Order and count must not matter - that is the whole point of looping.
  {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    await serveOnboarding(page, 'role,platform,pricing');
    await finishOnboarding(page, 1, 'a@example.com', 'pw');
    assert.ok(!page.url().includes('/app/onboarding'));
    console.log('✓ handles a different step order and length');
    await page.close();
  }

  // A screen with nothing to press must be reported with its contents, not looped on in
  // silence until the deadline.
  {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    await page.route('https://elevenlabs.io/**', (route) => route.fulfill({
      status: 200, contentType: 'text/html',
      body: '<body><h1>Unexpected screen</h1><p>no buttons here</p></body>',
    }));
    await page.goto('https://elevenlabs.io/app/onboarding');
    await assert.rejects(
      () => finishOnboardingQuick(page, 1, 'a@example.com', 'pw'),
      /did not finish within[\s\S]*Last seen: "Unexpected screen"/,
    );
    console.log('✓ an unrecognised screen is retried to the deadline, then reported with what it showed');
    await page.close();
  }


  // Regression: straight after sign-in the app paints a blank splash for a few seconds. The
  // loop checked for buttons immediately, found none and declared onboarding stuck - on a
  // page that had simply not booted yet.
  {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    await serveOnboarding(page, 'platform,name', 3000);
    await finishOnboarding(page, 1, 'a@example.com', 'pw');
    assert.ok(!page.url().includes('/app/onboarding'), `still on onboarding: ${page.url()}`);
    console.log('✓ waits out the blank splash instead of calling it stuck');
    await page.close();
  }


  // Regression: the "Choose your platform" screen rendered fully but carried no <button> at
  // all - ElevenLabs ships clickable bare spans with no ARIA role. Waiting on <button> timed
  // out and a role lookup found nothing, so a fully-rendered screen was reported as blank.
  {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    await serveOnboarding(page, 'platform,role', 0, true);
    assert.strictEqual(await page.locator('button').count(), 0, 'fixture must contain no <button>');
    await finishOnboarding(page, 1, 'a@example.com', 'pw');
    assert.ok(!page.url().includes('/app/onboarding'), `still on onboarding: ${page.url()}`);
    console.log('✓ advances a screen whose control is a bare span, not a <button>');
    await page.close();
  }


  // The age confirmation gates the Next button, and its hidden input is name="adult" - the
  // previous name*="age" selector matched nothing, so Next stayed disabled forever.
  {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    await serveOnboarding(page, 'name');
    assert.strictEqual(await page.locator('input[type="checkbox"][name*="age"]').count(), 0,
      'fixture must reproduce the real name="adult" input, which name*="age" cannot match');
    await finishOnboarding(page, 1, 'a@example.com', 'pw');
    assert.ok(!page.url().includes('/app/onboarding'), 'Next stayed disabled - checkbox never ticked');
    console.log('✓ ticks the age checkbox despite its input being name="adult"');
    await page.close();
  }

  await browser.close();
  console.log('\nAll assertions passed.');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
