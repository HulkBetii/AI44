const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

// The onboarding loop randomly answers a survey question so that accounts do not all take an
// identical path. Whatever it clicks has to actually BE a survey answer: the first version
// selected any button whose text was not a navigation label, which on the pricing screen left
// only "Select plan" and "Explore all plans" as candidates, and left "Back" selectable on the
// two question screens.
//
// Bound to the same named constant the onboarding loop uses, so this test tracks the real
// selector rather than a copy that can drift out of step with it.
const src = fs.readFileSync(path.join(__dirname, '..', 'signup-hotmail.js'), 'utf8');
const declaration = src.match(/const SURVEY_OPTION_SELECTOR =[\s\S]*?;/);
assert.ok(declaration, 'SURVEY_OPTION_SELECTOR not found in signup-hotmail.js');
const SELECTOR = new Function(`${declaration[0]} return SURVEY_OPTION_SELECTOR;`)();

const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'onboarding.html'), 'utf8');

async function open(browser, step) {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  await page.route('https://elevenlabs.io/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: fixture }));
  await page.goto(`https://elevenlabs.io/app/onboarding?steps=${step}`);
  await page.waitForSelector('h1', { timeout: 10000 });
  return page;
}

async function candidates(page) {
  const loc = page.locator(SELECTOR);
  const n = await loc.count();
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push((await loc.nth(i).innerText()).replace(/\s+/g, ' ').trim());
  }
  return out;
}

(async () => {
  console.log(`selector under test: ${SELECTOR}`);
  const browser = await chromium.launch();

  // The pricing screen has no survey answer at all - every control on it either starts a paid
  // subscription or leaves onboarding. The randomiser must find nothing to click here.
  {
    const page = await open(browser, 'pricing');
    const found = await candidates(page);
    assert.deepStrictEqual(found, [],
      `pricing screen must offer the randomiser nothing, got ${JSON.stringify(found)}`);
    console.log('✓ pricing screen offers no candidate (never clicks "Select plan")');
    await page.close();
  }

  // "Back" would walk the loop to the previous step, re-rendering a screen it already handled
  // and, on the name step, typing into #firstname a second time.
  for (const step of ['role', 'interests']) {
    const page = await open(browser, step);
    const found = await candidates(page);
    assert.ok(found.length > 0, `${step} screen should offer real survey answers`);
    assert.ok(!found.includes('Back'),
      `"Back" must never be a candidate on the ${step} screen, got ${JSON.stringify(found)}`);
    assert.ok(!found.some((t) => /Skip|Continue|Next/i.test(t)),
      `navigation controls must never be candidates, got ${JSON.stringify(found)}`);
    console.log(`✓ ${step} screen offers only real answers: ${JSON.stringify(found)}`);
    await page.close();
  }

  // Choosing a platform is not a survey answer: ElevenCreative ships pre-selected and is the
  // one the API-key flow needs, so switching to ElevenAgents at random would change the app.
  {
    const page = await open(browser, 'platform');
    const found = await candidates(page);
    assert.deepStrictEqual(found, [],
      `platform screen must not be randomised, got ${JSON.stringify(found)}`);
    console.log('✓ platform screen is left alone (ElevenCreative stays selected)');
    await page.close();
  }

  await browser.close();
  console.log('\nAll assertions passed.');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
