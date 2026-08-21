const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');
const { clickHuman } = require('../human-behavior.js');

// clickHuman replaced locator.click() across the pipeline, but it drives page.mouse directly.
// Raw mouse events skip every actionability guarantee Playwright's own click provides, and two
// of those guarantees are load-bearing here:
//
//   - ElevenLabs ships sign-in submit, forgot-password Continue and Change Password as
//     `disabled` until their form validates. Clicking early does nothing, and a clickHuman
//     that reports success turns that into a 30s timeout blamed on the wrong step.
//   - grantAllPermissions clicks 28 endpoint tablists inside a scrollable dialog, most of
//     them below the fold.
const url = pathToFileURL(path.join(__dirname, 'fixtures', 'click-targets.html')).href;

(async () => {
  const browser = await chromium.launch();

  // A button that is disabled and never becomes enabled must fail loudly. Reporting success
  // without clicking is the worst outcome: the caller proceeds on a false premise.
  {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    await page.goto(url);
    await assert.rejects(
      () => clickHuman(page, '#gated'),
      /enabled|disabled/i,
      'clicking a permanently disabled button must throw, not report success',
    );
    assert.strictEqual(await page.locator('#gatedState').textContent(), 'not-clicked');
    console.log('✓ a disabled button throws instead of silently doing nothing');
    await page.close();
  }

  // The real case: disabled at first, enabled a moment later. clickHuman must wait it out,
  // exactly as locator.click() did before the refactor.
  {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    await page.goto(url);
    setTimeout(() => {
      page.locator('#gate').fill('x').catch(() => {});
    }, 600);
    await clickHuman(page, '#gated');
    assert.strictEqual(await page.locator('#gatedState').textContent(), 'CLICKED');
    console.log('✓ waits for a button to become enabled, then clicks it');
    await page.close();
  }

  // boundingBox() does not scroll into view and may return off-viewport coordinates, so a
  // below-the-fold target got mouse events at coordinates nothing occupies.
  {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    await page.goto(url);
    const before = await page.locator('#belowFold').boundingBox();
    assert.ok(before.y > 600, `fixture must place the target below the fold (y=${before.y})`);

    await clickHuman(page, '#belowFold');
    assert.strictEqual(
      await page.locator('#belowState').textContent(), 'CLICKED',
      'a below-the-fold element must be scrolled into view and actually clicked',
    );
    console.log('✓ scrolls a below-the-fold element into view before clicking');
    await page.close();
  }

  // clickHuman is called with both selector strings and Locator/ElementHandle objects
  // throughout signup-hotmail.js, so the guarantees must hold for every accepted form.
  {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    await page.goto(url);
    await clickHuman(page, page.locator('#belowFold'));
    assert.strictEqual(await page.locator('#belowState').textContent(), 'CLICKED');
    console.log('✓ same guarantees when passed a Locator');
    await page.close();
  }
  {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    await page.goto(url);
    await clickHuman(page, await page.$('#belowFold'));
    assert.strictEqual(await page.locator('#belowState').textContent(), 'CLICKED');
    console.log('✓ same guarantees when passed an ElementHandle');
    await page.close();
  }


  // Outlook's consent modal covered the message list while the rows underneath stayed
  // present, visible and enabled. Raw mouse events hit the overlay instead, so the click
  // silently did nothing and the run reported finding no mail.
  {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    await page.goto(`${url}?overlay=1`);
    // #belowFold is enabled, so the enabled-wait passes and the occlusion check is what
    // must catch this.
    await assert.rejects(
      () => clickHuman(page, '#belowFold', { timeoutMs: 4000 }),
      /cover|intercept/i,
      'a covered target must be reported, not clicked through',
    );
    console.log('✓ a covered target is reported instead of clicking the overlay');
    await page.close();
  }

  // A transient overlay (spinner, dialog being dismissed) must simply be waited out.
  {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    await page.goto(`${url}?overlay=1&overlayGoesAfter=1500`);
    await clickHuman(page, '#belowFold');
    assert.strictEqual(await page.locator('#belowState').textContent(), 'CLICKED');
    console.log('✓ waits out a transient overlay, then clicks');
    await page.close();
  }


  // Chrome throttles background tabs and defers their layout, so scrollIntoViewIfNeeded,
  // boundingBox and elementFromPoint all go stale if another tab takes the foreground. A live
  // run stalled in the API-key dialog until the operator switched tabs by hand. clickHuman
  // must claim the foreground before it reads any position.
  //
  // Playwright's own browser does not actually background tabs (visibilityState stays
  // "visible"), so this asserts the contract - that bringToFront is called, and before the
  // first mouse event - rather than the browser behaviour it protects against.
  {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    await page.goto(url);

    const calls = [];
    const realBring = page.bringToFront.bind(page);
    page.bringToFront = async () => { calls.push('bringToFront'); return realBring(); };
    const realMove = page.mouse.move.bind(page.mouse);
    page.mouse.move = async (...a) => { calls.push('mouse.move'); return realMove(...a); };

    await clickHuman(page, '#belowFold');

    assert.ok(calls.includes('bringToFront'), 'clickHuman must bring the page to the foreground');
    assert.strictEqual(calls[0], 'bringToFront',
      `foreground must be claimed before any mouse movement, got ${calls.slice(0, 3).join(' -> ')}`);
    assert.strictEqual(await page.locator('#belowState').textContent(), 'CLICKED');
    console.log('✓ claims the foreground before reading any position');
    await page.close();
  }

  await browser.close();
  console.log('\nAll assertions passed.');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
