const assert = require('assert');
const fs = require('fs');
const path = require('path');

// A GPM profile is not an in-process resource: starting one launches a browser and writes a
// folder to disk, and both survive the process that created them. Every exit path therefore
// has to release it. Two paths used not to:
//
//   - Ctrl+C. gpmProfileId was declared inside the account loop, so the outer .finally could
//     not see it, and a signal kills the process before the loop's own finally runs. Every
//     interrupted run left a started profile and a folder behind - and interrupting mid-run
//     is routine here, not exceptional.
//   - A throw outside the per-account try (proxy setup, sheet init), which skips that finally
//     for the same reason.
//
// Extracted rather than required: signup-hotmail.js calls run() at import time.
const src = fs.readFileSync(path.join(__dirname, '..', 'signup-hotmail.js'), 'utf8');

const releaseSrc = src.match(/let releasing = null;\nfunction releaseProfile\(\) \{[\s\S]*?\n\}/);
assert.ok(releaseSrc, 'releaseProfile not found in signup-hotmail.js');

const signalSrc = src.match(/let shuttingDown = false;\nfor \(const sig of \['SIGINT', 'SIGTERM'\]\) \{[\s\S]*?\n\}/);
assert.ok(signalSrc, 'the SIGINT/SIGTERM handler is missing from signup-hotmail.js');

// gpmProfileId must live at module scope. If it is re-declared inside the loop the handler
// reads a different binding and silently cleans up nothing - the original bug, which looks
// identical to a working run from the outside.
assert.ok(
  /^let gpmProfileId = null;$/m.test(src),
  'gpmProfileId must be declared at module scope',
);
assert.ok(
  !/^\s+let gpmProfileId\b/m.test(src),
  'gpmProfileId must not be re-declared inside the account loop',
);
console.log('✓ gpmProfileId is module-scope, visible to every exit path');

// Both cleanup sites must delegate here, or one of them drifts and starts leaking again.
assert.ok(
  (src.match(/releaseProfile\(\)/g) || []).length >= 3,
  'releaseProfile should be called by the per-account finally, the outer finally and the signal handler',
);
console.log('✓ every cleanup site delegates to releaseProfile');

function build({ onStop, onDelete } = {}) {
  const events = [];
  const gpm = {
    stopProfile: async (id) => { events.push(`stop:${id}`); if (onStop) await onStop(id); },
    deleteProfile: async (id) => { events.push(`delete:${id}`); if (onDelete) await onDelete(id); },
  };
  const quiet = { log() {}, warn() {}, error() {} };
  const harness = new Function('gpm', 'console', 'setTimeout', 'events', `
    let activePage = null;
    let browser = null;
    let gpmProfileId = null;
    function step() {}
    ${releaseSrc[0]}
    return {
      releaseProfile,
      setProfile: (id) => { gpmProfileId = id; },
      getProfile: () => gpmProfileId,
      setBrowser: (b) => { browser = b; },
      getBrowser: () => browser,
    };
  `);
  // The real sleep between stop and delete is 2s of dead time; the ordering under test does
  // not depend on its length.
  return { ...harness(gpm, quiet, (fn) => fn(), events), events };
}

(async () => {
  // Baseline: the profile is stopped, then deleted, and the CDP connection is closed.
  {
    const h = build();
    let closed = false;
    h.setBrowser({ close: async () => { closed = true; } });
    h.setProfile('abc-123');

    await h.releaseProfile();

    assert.deepStrictEqual(h.events, ['stop:abc-123', 'delete:abc-123']);
    assert.ok(closed, 'the CDP connection must be closed');
    assert.strictEqual(h.getProfile(), null);
    assert.strictEqual(h.getBrowser(), null);
    console.log('✓ stops, then deletes, then clears the handles');
  }

  // The Ctrl+C race. The signal handler calls process.exit as soon as its releaseProfile
  // settles, so if a release already in flight is skipped rather than joined, exit kills the
  // delete mid-request - the profile survives on disk exactly when the operator is watching
  // for it. The second caller must not settle before the delete has actually run.
  {
    let releaseDelete;
    const h = build({ onDelete: () => new Promise((r) => { releaseDelete = r; }) });
    h.setProfile('race-1');

    const first = h.releaseProfile();
    // Hand control back so the first call reaches the pending deleteProfile.
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(h.events, ['stop:race-1', 'delete:race-1']);

    let secondSettled = false;
    const second = h.releaseProfile().then(() => { secondSettled = true; });

    await new Promise((r) => setImmediate(r));
    assert.strictEqual(secondSettled, false,
      'a second caller must wait for the in-flight delete, not return immediately');

    releaseDelete();
    await Promise.all([first, second]);

    assert.strictEqual(secondSettled, true);
    assert.deepStrictEqual(h.events, ['stop:race-1', 'delete:race-1'],
      'the profile must be deleted exactly once, not twice');
    console.log('✓ a concurrent release joins the in-flight one instead of skipping it');
  }

  // Sequential accounts each get their own release: the shared promise must not be sticky.
  {
    const h = build();
    h.setProfile('first');
    await h.releaseProfile();
    h.setProfile('second');
    await h.releaseProfile();
    assert.deepStrictEqual(h.events,
      ['stop:first', 'delete:first', 'stop:second', 'delete:second']);
    console.log('✓ the next account gets its own release, not the previous result');
  }

  // Nothing to release must be harmless - the outer finally runs on every exit, including
  // ones where no profile was ever created.
  {
    const h = build();
    await h.releaseProfile();
    assert.deepStrictEqual(h.events, []);
    console.log('✓ releasing with no profile does nothing');
  }

  // A failing stop must not abort the delete. GPM returns an error for a profile that is not
  // running, which is exactly the state an interrupted run can leave behind - bailing there
  // would leak the folder in the one case this whole mechanism exists for.
  {
    const h = build({ onStop: () => { throw new Error('profile not running'); } });
    h.setProfile('half-dead');
    await h.releaseProfile();
    assert.deepStrictEqual(h.events, ['stop:half-dead', 'delete:half-dead'],
      'a failed stop must still be followed by the delete');
    console.log('✓ a failed stop does not prevent the delete');
  }

  // A failed delete must keep the profile handle and reject. Starting the next account after
  // this would violate the exclusive-profile invariant and hide the leaked GPM folder.
  {
    const h = build({ onDelete: () => { throw new Error('delete unavailable'); } });
    h.setProfile('leaked');
    await assert.rejects(() => h.releaseProfile(), /cleanup failed/);
    assert.strictEqual(h.getProfile(), 'leaked');
    console.log('✓ a failed delete blocks progress and keeps the profile available for retry');
  }

  // The signal handler itself: registered for both signals, and it must release before it
  // exits rather than after (there is no "after" - process.exit is immediate).
  {
    const handlers = {};
    const order = [];
    let exitCode = null;
    const fakeProcess = {
      on: (sig, fn) => { handlers[sig] = fn; },
      exit: (code) => { order.push('exit'); exitCode = code; },
    };
    const quiet = { log() {}, warn() {}, error() {} };
    const install = new Function('process', 'console', 'releaseProfile', 'gpmProfileId', `
      ${signalSrc[0]}
    `);
    const releaseProfile = async () => {
      await new Promise((r) => setImmediate(r));
      order.push('release');
    };
    install(fakeProcess, quiet, releaseProfile, null);

    assert.deepStrictEqual(Object.keys(handlers).sort(), ['SIGINT', 'SIGTERM'],
      'both signals must be handled - npm and CI send SIGTERM, the operator sends SIGINT');

    handlers.SIGINT();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepStrictEqual(order, ['release', 'exit'],
      'the profile must be released before the process exits');
    assert.strictEqual(exitCode, 130, 'interrupted runs should exit 130, not 0');
    console.log('✓ SIGINT and SIGTERM release the profile before exiting');

    // Pressed twice: the operator has decided to stop waiting, so exit at once rather than
    // hanging on a GPM call that may itself be why the first attempt is slow.
    order.length = 0;
    handlers.SIGINT();
    assert.deepStrictEqual(order, ['exit'],
      'a second signal must exit immediately without waiting for another release');
    console.log('✓ a second signal forces an immediate exit');
  }

  console.log('\nAll assertions passed.');
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
