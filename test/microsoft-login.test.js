const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const src = fs.readFileSync(path.join(__dirname, '..', 'signup-hotmail.js'), 'utf8');
const detectMicrosoftLoginIssue = new Function(
  `return ${src.match(/async function detectMicrosoftLoginIssue\(page\) \{[\s\S]*?\n\}/)[0]}`,
)();
const activateMicrosoftPasswordRoute = new Function(
  `${src.match(/function normalizeChoiceText\(value\) \{[\s\S]*?\n\}/)[0]};
   ${src.match(/function microsoftLoginError\(code, message\) \{[\s\S]*?\n\}/)[0]};
   ${src.match(/async function findVisiblePasswordChoice\(page\) \{[\s\S]*?\n\}/)[0]};
   ${src.match(/async function activateMicrosoftPasswordRoute\(page, route, click = clickHuman\) \{[\s\S]*?\n\}/)[0]};
   return activateMicrosoftPasswordRoute;`,
)();
const firstOutcome = new Function(
  `${src.match(/function firstOutcome\(candidates, timeoutMs\) \{[\s\S]*?\n\}/)[0]}; return firstOutcome;`,
)();

(async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<input id="iProofEmail" style="width:200px;height:20px">');
    assert.deepStrictEqual(await detectMicrosoftLoginIssue(page), {
      code: 'MS_RECOVERY_REQUIRED',
      message: 'Microsoft requested manual account recovery',
    });
    console.log('✓ visible blank recovery input is classified as manual recovery');

    await page.setContent(`
      <input id="iProofEmail" style="width:200px;height:20px">
      <button id="password-route" style="width:200px;height:20px">Use your password</button>
    `);
    assert.strictEqual(await detectMicrosoftLoginIssue(page), null);
    let passwordRouteClicked = false;
    const route = await activateMicrosoftPasswordRoute(page, 'proof', async (_page, locator) => {
      passwordRouteClicked = true;
      await locator.click();
    });
    assert.strictEqual(route, 'link');
    assert.strictEqual(passwordRouteClicked, true);
    console.log('✓ password route wins when recovery proof and password choice are both visible');

    await page.setContent('<div id="passwordError">Your account or password is incorrect</div>');
    assert.deepStrictEqual(await detectMicrosoftLoginIssue(page), {
      code: 'MS_BAD_CREDENTIALS',
      message: 'Your account or password is incorrect',
    });
    console.log('✓ dedicated Microsoft credential error is typed as bad credentials');

    await page.setContent('<div id="passwordError">You have tried to sign in too many times. Try again later.</div>');
    assert.deepStrictEqual(await detectMicrosoftLoginIssue(page), {
      code: 'MS_UI_CHANGED',
      message: 'You have tried to sign in too many times. Try again later.',
    });
    console.log('✓ generic Microsoft error containers do not mark throttled accounts inactive');

    await page.setContent('<input id="iProofEmail" style="display:none">');
    assert.strictEqual(await detectMicrosoftLoginIssue(page), null);
    console.log('✓ hidden recovery markup does not trigger a false manual status');

    const positive = await firstOutcome([
      { promise: Promise.reject(new Error('not present')), value: 'negative' },
      { promise: new Promise((resolve) => setTimeout(resolve, 10)), value: 'password' },
    ], 100);
    assert.strictEqual(positive, 'password');
    console.log('✓ a rejected route candidate cannot beat a later positive Microsoft route');
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error('FAILED:', error.stack || error.message);
  process.exit(1);
});
