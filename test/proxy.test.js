const assert = require('assert');
const http = require('http');
const {
  getNewProxy, getNewProxyWithRetry, parseCooldownSeconds, isPermanentProxyError, parseProxyString,
} = require('../proxy.js');

// ── parseProxyString: exact fields from the SP07 docs ───────────────────────────────────────
assert.deepStrictEqual(
  parseProxyString('14.162.30.211:41556:ayqlqgd:wjcupxa'),
  { server: 'http://14.162.30.211:41556', username: 'ayqlqgd', password: 'wjcupxa' },
);
console.log('✓ parses the "proxy" field example (4 parts)');

assert.deepStrictEqual(
  parseProxyString('103.62.75.102:11944'),
  { server: 'http://103.62.75.102:11944' },
);
console.log('✓ parses the "proxy_ip_allow" field example (2 parts, no auth)');

assert.throws(() => parseProxyString('not-a-proxy-string'), /Unknown proxy format/);
console.log('✓ rejects an unrecognised format instead of guessing');

// ── parseCooldownSeconds: the exact messages SP07 returns ───────────────────────────────────
assert.strictEqual(parseCooldownSeconds('Proxy API failed with status: ERROR - Reason: Thời gian lấy proxy mới còn 43 giây'), 43);
assert.strictEqual(parseCooldownSeconds('Proxy API failed with status: ERROR - Reason: Không tìm được proxy live'), null);
assert.strictEqual(parseCooldownSeconds(''), null);
assert.strictEqual(parseCooldownSeconds(undefined), null);
console.log('✓ parseCooldownSeconds extracts the reported wait, or null when absent');

// ── isPermanentProxyError: real messages seen from the live SP07 API ────────────────────
assert.strictEqual(isPermanentProxyError('Proxy API failed with status: ERROR - Reason: Đơn hàng đã hết hạn'), true);
assert.strictEqual(isPermanentProxyError('Proxy API failed with status: ERROR - Reason: Token không thuộc version được hỗ trợ'), true);
assert.strictEqual(isPermanentProxyError('Proxy API failed with status: ERROR - Reason: Thời gian lấy proxy mới còn 43 giây'), false);
assert.strictEqual(isPermanentProxyError('Proxy API failed with status: ERROR - Reason: Không tìm được proxy live'), false);
assert.strictEqual(isPermanentProxyError(''), false);
console.log('✓ isPermanentProxyError separates account-state errors from transient ones');

// ── getNewProxy / getNewProxyWithRetry: exercised against a local server ────────────────────
// Both hardcode the proxy.mkvn.net host, so requests are redirected to a local server for
// these tests rather than hitting the real endpoint.
function withServer(handler, fn) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, async () => {
      const port = server.address().port;
      try {
        await fn(port);
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        server.close();
      }
    });
  });
}

function redirectToLocalServer(port) {
  const https = require('https');
  const originalGet = https.get;
  https.get = (url, cb) => http.get(url.replace('https://proxy.mkvn.net', `http://127.0.0.1:${port}`), cb);
  return () => { https.get = originalGet; };
}

async function callAgainstLocalServer(port, token, timeoutMs) {
  const restore = redirectToLocalServer(port);
  try {
    return await getNewProxy(token, timeoutMs);
  } finally {
    restore();
  }
}

async function callRetryAgainstLocalServer(port, token, opts) {
  // Installed for the whole retry window: getNewProxyWithRetry issues multiple requests.
  const restore = redirectToLocalServer(port);
  try {
    return await getNewProxyWithRetry(token, opts);
  } finally {
    restore();
  }
}

(async () => {
  await withServer((req, res) => {
    res.end(JSON.stringify({ status: 'SUCCESS', proxy: '1.2.3.4:5678:u:p' }));
  }, async (port) => {
    const json = await callAgainstLocalServer(port, 'tok');
    assert.strictEqual(json.status, 'SUCCESS');
    assert.strictEqual(json.proxy, '1.2.3.4:5678:u:p');
  });
  console.log('✓ resolves on SUCCESS with a proxy field');

  await withServer((req, res) => {
    res.end(JSON.stringify({ status: 'FAILED', message: 'token expired' }));
  }, async (port) => {
    await assert.rejects(() => callAgainstLocalServer(port, 'tok'), /Proxy API failed.*token expired/);
  });
  console.log('✓ rejects with the API-reported reason on a non-SUCCESS status');

  await withServer((req, res) => {
    res.end('<html>not json</html>');
  }, async (port) => {
    await assert.rejects(() => callAgainstLocalServer(port, 'tok'), /Failed to parse proxy API response/);
  });
  console.log('✓ rejects rather than throwing on an unparseable body');

  // Regression test for the timeout bug found in review: a server that accepts the connection
  // but never responds used to hang getNewProxy forever, freezing the whole batch with no
  // signal.
  await withServer((req, res) => { /* never respond */ }, async (port) => {
    const started = Date.now();
    await assert.rejects(
      () => callAgainstLocalServer(port, 'tok', 300),
      /timed out after 300ms/,
    );
    const waited = Date.now() - started;
    assert.ok(waited < 2000, `expected to reject near the 300ms timeout, took ${waited}ms`);
  });
  console.log('✓ an unresponsive server rejects at the timeout instead of hanging forever');

  // Regression test for the production cascade: a live run hit a per-token cooldown on row 1
  // and then burned through 9 more rows within about a second, since each failed attempt
  // returns almost instantly and the loop had no delay between rows. The fix retries in place,
  // honoring the server-reported wait ("còn N giây") rather than moving on immediately.
  await withServer((() => {
    let calls = 0;
    return (req, res) => {
      calls++;
      const body = calls === 1
        ? { status: 'ERROR', message: 'Thời gian lấy proxy mới còn 1 giây' }
        : { status: 'SUCCESS', proxy: '9.9.9.9:1111:a:b' };
      res.end(JSON.stringify(body));
    };
  })(), async (port) => {
    const started = Date.now();
    const result = await callRetryAgainstLocalServer(port, 'tok', { maxAttempts: 2, fallbackDelayMs: 20000 });
    const waited = Date.now() - started;
    assert.strictEqual(result.proxy, '9.9.9.9:1111:a:b');
    // The reported cooldown is 1s (+2s buffer = ~3s); a wait anywhere near the 20s fallback
    // would mean the reported figure was ignored.
    assert.ok(waited >= 2500 && waited < 10000, `expected a ~3s wait honoring the reported cooldown, got ${waited}ms`);
  });
  console.log('✓ retries after a cooldown hit, honoring the server-reported wait rather than the fallback delay');

  // A non-cooldown error (e.g. "no live proxy") gives up after maxAttempts using the fallback
  // delay, rather than retrying forever - a genuinely broken token/outage must still surface.
  {
    let calls = 0;
    await withServer((req, res) => {
      calls++;
      res.end(JSON.stringify({ status: 'ERROR', message: 'Không tìm được proxy live' }));
    }, async (port) => {
      await assert.rejects(
        () => callRetryAgainstLocalServer(port, 'tok', { maxAttempts: 3, fallbackDelayMs: 50 }),
        /Không tìm được proxy live/,
      );
    });
    assert.strictEqual(calls, 3, 'must attempt exactly maxAttempts times before giving up');
  }
  console.log('✓ gives up after maxAttempts on a non-cooldown error instead of retrying forever');

  // An account-state error must cost exactly one call. Observed while testing an expired
  // Version 5 token: three attempts and ~51s of waiting to report the same "order expired"
  // the first call already gave.
  {
    let calls = 0;
    const started = Date.now();
    await withServer((req, res) => {
      calls++;
      res.end(JSON.stringify({ status: 'ERROR', message: 'Đơn hàng đã hết hạn' }));
    }, async (port) => {
      await assert.rejects(
        () => callRetryAgainstLocalServer(port, 'tok', { maxAttempts: 3, fallbackDelayMs: 20000 }),
        /Đơn hàng đã hết hạn/,
      );
    });
    assert.strictEqual(calls, 1, `an expired order must not be retried (made ${calls} calls)`);
    const waited = Date.now() - started;
    assert.ok(waited < 3000, `must fail fast on a permanent error, took ${waited}ms`);
  }
  console.log('✓ a permanent account error fails after one call instead of burning the retry budget');

  console.log('\nAll assertions passed.');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
