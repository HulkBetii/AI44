const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const runtimeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-temp-gpm-'));
const previousBase = process.env.GPM_API_BASE;
const previousRuntime = process.env.MAIL_TEMP_RUNTIME_DIR;

(async () => {
  const profiles = [];
  let createRequests = 0;
  let finishInFlightCreate = null;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/v2/profiles') {
      response.end(JSON.stringify({ data: profiles }));
      return;
    }
    if (url.pathname === '/v2/create') {
      createRequests++;
      const name = url.searchParams.get('name');
      if (name === 'inflight@example.com') {
        finishInFlightCreate = () => {
          profiles.push({ id: 'inflight-id', name });
          response.end(JSON.stringify({ profile_id: 'inflight-id' }));
        };
        return;
      }
      if (name === 'recover@example.com') {
        profiles.push({ id: 'recovered-id', name });
        request.socket.destroy();
        return;
      }
      profiles.push({ id: 'uncertain-a', name }, { id: 'uncertain-b', name });
      response.end(JSON.stringify({
        status: false,
        message: `provider error: ${url.searchParams.get('proxy')}`,
      }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    process.env.GPM_API_BASE = `http://127.0.0.1:${server.address().port}`;
    process.env.MAIL_TEMP_RUNTIME_DIR = runtimeDirectory;
    delete require.cache[require.resolve('../gpm-api')];
    const gpm = require('../gpm-api');

    const inFlightCreate = gpm.createProfile('inflight@example.com');
    while (!finishInFlightCreate) await new Promise((resolve) => setImmediate(resolve));
    const inFlightMarkers = gpm.listUncertainCreates({ runtimeDirectory });
    assert.strictEqual(inFlightMarkers.length, 1);
    assert.strictEqual(inFlightMarkers[0].name, 'inflight@example.com');
    finishInFlightCreate();
    assert.strictEqual(await inFlightCreate, 'inflight-id');
    assert.deepStrictEqual(gpm.listUncertainCreates({ runtimeDirectory }), []);
    console.log('✓ GPM create intent exists while the request is in flight and clears only after a definite id');

    assert.strictEqual(await gpm.createProfile('recover@example.com'), 'recovered-id');
    console.log('✓ uncertain create response recovers exactly one newly discovered profile id');

    const proxySecret = '127.0.0.1:1234:user:do-not-record';
    const encodedSecret = encodeURIComponent(proxySecret);
    let uncertainError;
    try {
      await gpm.createProfile('uncertain@example.com', proxySecret);
      assert.fail('ambiguous GPM create should fail');
    } catch (error) {
      uncertainError = error;
    }
    assert.strictEqual(uncertainError.code, gpm.GPM_CREATE_UNCERTAIN);
    assert.match(uncertainError.message, /recovery marker/);
    assert.ok(!uncertainError.message.includes(proxySecret));
    assert.ok(!uncertainError.message.includes(encodedSecret));
    const evidenceDirectory = path.join(runtimeDirectory, 'gpm-create-uncertain');
    const evidenceFiles = fs.readdirSync(evidenceDirectory).filter((file) => file.endsWith('.json'));
    assert.strictEqual(evidenceFiles.length, 1);
    const evidence = fs.readFileSync(path.join(evidenceDirectory, evidenceFiles[0]), 'utf8');
    assert.ok(!evidence.includes(proxySecret));
    assert.ok(!evidence.includes(encodedSecret));
    assert.ok(!evidence.includes('provider error'));
    assert.ok(evidence.includes('uncertain@example.com'));
    console.log('✓ ambiguous create writes secret-free recovery evidence instead of guessing an id');

    const requestCountBeforeBlock = createRequests;
    await assert.rejects(
      () => gpm.createProfile('blocked@example.com', 'another-secret'),
      (error) => error.code === gpm.GPM_CREATE_UNCERTAIN,
    );
    assert.strictEqual(createRequests, requestCountBeforeBlock);
    console.log('✓ unresolved create evidence blocks another remote create');

    const ambiguousId = evidenceFiles[0].slice(0, -5);
    gpm.discardUncertainCreate(ambiguousId, { runtimeDirectory, confirm: true });

    const stopped = [];
    const deleted = [];
    const unique = gpm.recordUncertainCreate('unique@example.com', new Set(['old-id']), { runtimeDirectory });
    const reconciled = await gpm.reconcileUncertainCreate(unique.id, {
      runtimeDirectory,
      getProfilesFn: async () => [
        { id: 'old-id', name: 'unique@example.com' },
        { id: 'new-id', name: 'unique@example.com' },
      ],
      stopProfileFn: (id) => {
        stopped.push(id);
        throw new Error('already stopped');
      },
      deleteProfileFn: async (id) => deleted.push(id),
    });
    assert.deepStrictEqual(reconciled, { id: unique.id, outcome: 'deleted' });
    assert.deepStrictEqual(stopped, ['new-id']);
    assert.deepStrictEqual(deleted, ['new-id']);
    assert.strictEqual(gpm.readUncertainCreate(unique.id, { runtimeDirectory }), null);
    console.log('✓ unique reconcile tolerates stop failure, deletes the profile, then removes evidence');

    const ambiguous = gpm.recordUncertainCreate('many@example.com', new Set(), { runtimeDirectory });
    await assert.rejects(
      () => gpm.reconcileUncertainCreate(ambiguous.id, {
        runtimeDirectory,
        getProfilesFn: async () => [
          { id: 'candidate-a', name: 'many@example.com' },
          { id: 'candidate-b', name: 'many@example.com' },
        ],
      }),
      /found 2 possible GPM profiles/,
    );
    assert.ok(gpm.readUncertainCreate(ambiguous.id, { runtimeDirectory }));
    gpm.discardUncertainCreate(ambiguous.id, { runtimeDirectory, confirm: true });
    console.log('✓ ambiguous reconcile keeps its evidence for operator review');

    const deleteFailure = gpm.recordUncertainCreate('delete-failure@example.com', new Set(), { runtimeDirectory });
    await assert.rejects(
      () => gpm.reconcileUncertainCreate(deleteFailure.id, {
        runtimeDirectory,
        getProfilesFn: async () => [{ id: 'undeleted-id', name: 'delete-failure@example.com' }],
        stopProfileFn: async () => {},
        deleteProfileFn: async () => { throw new Error('delete failed'); },
      }),
      /delete failed/,
    );
    assert.ok(gpm.readUncertainCreate(deleteFailure.id, { runtimeDirectory }));
    gpm.discardUncertainCreate(deleteFailure.id, { runtimeDirectory, confirm: true });
    console.log('✓ failed profile deletion preserves uncertain-create evidence');

    const noSnapshot = gpm.recordUncertainCreate('snapshot@example.com', null, { runtimeDirectory });
    await assert.rejects(
      () => gpm.reconcileUncertainCreate(noSnapshot.id, {
        runtimeDirectory,
        getProfilesFn: async () => [{ id: 'possible-id', name: 'snapshot@example.com' }],
      }),
      /snapshot is unavailable/,
    );
    assert.ok(gpm.readUncertainCreate(noSnapshot.id, { runtimeDirectory }));
    gpm.discardUncertainCreate(noSnapshot.id, { runtimeDirectory, confirm: true });

    const discard = gpm.recordUncertainCreate('discard@example.com', new Set(), { runtimeDirectory });
    assert.throws(
      () => gpm.discardUncertainCreate(discard.id, { runtimeDirectory }),
      /requires confirm=true/,
    );
    const lockFile = path.join(runtimeDirectory, 'automation.lock');
    fs.writeFileSync(lockFile, JSON.stringify({
      pid: process.pid,
      token: 'busy-test-token',
      owner: 'test',
    }));
    await assert.rejects(
      () => gpm.runCli([`--discard=${discard.id}`, '--confirm'], { runtimeDirectory, output: () => {} }),
      /still running/,
    );
    assert.ok(gpm.readUncertainCreate(discard.id, { runtimeDirectory }));
    fs.unlinkSync(lockFile);
    fs.writeFileSync(lockFile, JSON.stringify({
      pid: 0,
      token: 'stale-test-token',
      owner: 'test',
    }));
    await assert.rejects(
      () => gpm.runCli([`--discard=${discard.id}`, '--confirm'], { runtimeDirectory, output: () => {} }),
      /stale automation lock/,
    );
    assert.ok(gpm.readUncertainCreate(discard.id, { runtimeDirectory }));
    fs.unlinkSync(lockFile);
    await gpm.runCli([`--discard=${discard.id}`, '--confirm'], { runtimeDirectory, output: () => {} });
    assert.strictEqual(gpm.readUncertainCreate(discard.id, { runtimeDirectory }), null);
    assert.strictEqual(fs.existsSync(path.join(runtimeDirectory, 'automation.maintenance.lock')), false);
    console.log('✓ explicit discard is guarded against active automation and releases maintenance lock');

    assert.deepStrictEqual(gpm.parseCliArgs(['--list-uncertain']), {
      action: 'list', id: null, confirm: false,
    });
    assert.deepStrictEqual(gpm.parseCliArgs([`--reconcile=${unique.id}`]), {
      action: 'reconcile', id: unique.id, confirm: false,
    });
    assert.throws(() => gpm.parseCliArgs([]), /Choose one/);
    assert.throws(() => gpm.parseCliArgs(['--reset']), /Unknown option/);
    assert.throws(
      () => gpm.parseCliArgs(['--list-uncertain', `--reconcile=${unique.id}`]),
      /Choose exactly one/,
    );
    assert.throws(() => gpm.parseCliArgs([`--discard=${unique.id}`]), /requires --confirm/);
    console.log('✓ GPM maintenance CLI rejects unknown, conflicting, and unconfirmed actions');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previousBase === undefined) delete process.env.GPM_API_BASE;
    else process.env.GPM_API_BASE = previousBase;
    if (previousRuntime === undefined) delete process.env.MAIL_TEMP_RUNTIME_DIR;
    else process.env.MAIL_TEMP_RUNTIME_DIR = previousRuntime;
    fs.rmSync(runtimeDirectory, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error('FAILED:', error.stack || error.message);
  process.exit(1);
});
