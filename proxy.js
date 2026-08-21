const https = require('https');

function getNewProxy(token, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const url = `https://proxy.mkvn.net/sp07api/get_new?token=${encodeURIComponent(token)}`;

    const req = https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.status === 'SUCCESS' && json.proxy) {
            resolve(json);
          } else {
            const reason = json.message || json.error || JSON.stringify(json);
            reject(new Error(`Proxy API failed with status: ${json.status} - Reason: ${reason}`));
          }
        } catch (e) {
          reject(new Error('Failed to parse proxy API response: ' + data));
        }
      });
    }).on('error', (e) => {
      reject(new Error(`Failed to call proxy API: ${e.message}`));
    });

    // https.get has no default timeout: an unresponsive server hangs this forever, freezing
    // the whole batch with no CAPTCHA-style bell/tick to signal it. destroy() triggers the
    // 'error' handler above, so callers see a normal rejection.
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Proxy API timed out after ${timeoutMs}ms`));
    });
  });
}

// SP07 rate-limits get_new per token (observed ~60s) and reports the exact remaining wait
// when hit, e.g. "Thời gian lấy proxy mới còn 43 giây". Returns that count in seconds, or
// null if the message isn't a cooldown report.
function parseCooldownSeconds(message) {
  const m = /còn\s+(\d+)\s*gi[aâ]y/i.exec(message || '');
  return m ? Number(m[1]) : null;
}

// Some SP07 errors describe account state, not a transient hiccup: retrying an expired order
// or a token the plan doesn't cover can never succeed, and the retry budget just burns ~50s
// (observed while testing an expired Version 5 token) before reporting the same thing.
const PERMANENT_ERROR_PATTERNS = [
  /đơn hàng đã hết hạn/i,          // order expired
  /token không thuộc version/i,     // token not valid for the supported plan
  /token không tồn tại/i,           // unknown token
];

function isPermanentProxyError(message) {
  return PERMANENT_ERROR_PATTERNS.some((re) => re.test(message || ''));
}

// getNewProxy with bounded retries in place. A caller that loops over many rows with no
// delay between them would otherwise turn a single cooldown hit into every subsequent row
// failing within seconds, since each failed attempt returns almost instantly (observed: 9
// rows burned through in under a second, all reporting the same decaying cooldown counter).
// Honors the server-reported wait when the error names one; falls back to a fixed delay for
// other transient errors (e.g. "no live proxy" outages). Still bounded - a genuinely broken
// token or API eventually surfaces as a rejection rather than retrying forever.
async function getNewProxyWithRetry(token, {
  maxAttempts = 3,
  fallbackDelayMs = 20000,
  timeoutMs = 15000,
} = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await getNewProxy(token, timeoutMs);
    } catch (err) {
      lastErr = err;
      if (isPermanentProxyError(err.message)) {
        console.log(`[proxy] Not retrying - this is an account/token problem, not a transient one.`);
        break;
      }
      if (attempt === maxAttempts) break;
      const cooldownSec = parseCooldownSeconds(err.message);
      const waitMs = cooldownSec != null ? (cooldownSec + 2) * 1000 : fallbackDelayMs;
      console.log(`[proxy] Attempt ${attempt}/${maxAttempts} failed (${err.message}); retrying in ${Math.round(waitMs / 1000)}s...`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw lastErr;
}

// Helper to format proxy for Playwright
// Takes 'IP:PORT:USER:PASS' and returns { server, username, password }
function parseProxyString(proxyString) {
  const parts = proxyString.split(':');
  if (parts.length >= 4) {
    return {
      server: `http://${parts[0]}:${parts[1]}`,
      username: parts[2],
      password: parts[3],
    };
  } else if (parts.length === 2) {
    return {
      server: `http://${parts[0]}:${parts[1]}`,
    };
  }
  throw new Error(`Unknown proxy format: ${proxyString}`);
}

const net = require('net');
const tls = require('tls');
const { URL } = require('url');

// Fetches an HTTPS URL through an HTTP proxy via CONNECT tunneling, using only Node's
// built-in net/tls (no new dependency for what is otherwise a one-off diagnostic). Used to
// sanity-check that a proxy actually routes traffic before spending a full Hotmail signup +
// CAPTCHA cycle on it - connectivity failing here means the proxy is dead outright, distinct
// from (and cheaper to rule out than) a proxy that connects fine but gets flagged by CAPTCHA.
function fetchViaProxy(targetUrl, proxy, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    const proxyUrl = new URL(proxy.server);
    const proxyPort = Number(proxyUrl.port) || 80;

    const socket = net.connect(proxyPort, proxyUrl.hostname);
    const timer = setTimeout(() => {
      socket.destroy(new Error(`Proxy connection timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const fail = (err) => { clearTimeout(timer); reject(err); };

    socket.once('error', fail);
    socket.once('connect', () => {
      const auth = proxy.username
        ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}\r\n`
        : '';
      socket.write(
        `CONNECT ${target.hostname}:443 HTTP/1.1\r\nHost: ${target.hostname}:443\r\n${auth}Connection: close\r\n\r\n`,
      );
    });

    let buf = '';
    function onConnectResponse(chunk) {
      buf += chunk.toString('latin1');
      if (!buf.includes('\r\n\r\n')) return;
      socket.removeListener('data', onConnectResponse);
      clearTimeout(timer);

      const statusLine = buf.split('\r\n')[0];
      if (!/^HTTP\/1\.[01] 200/.test(statusLine)) {
        socket.destroy();
        return reject(new Error(`Proxy CONNECT failed: ${statusLine}`));
      }

      // The tunnel is open; upgrade the raw socket to TLS for the actual HTTPS request.
      const tlsSocket = tls.connect({ socket, servername: target.hostname }, () => {
        tlsSocket.write(
          `GET ${target.pathname}${target.search} HTTP/1.1\r\nHost: ${target.hostname}\r\nConnection: close\r\n\r\n`,
        );
      });
      let response = '';
      tlsSocket.on('data', (d) => { response += d.toString(); });
      tlsSocket.on('end', () => {
        const body = response.split('\r\n\r\n').slice(1).join('\r\n\r\n');
        resolve(body);
      });
      tlsSocket.on('error', reject);
    }
    socket.on('data', onConnectResponse);
  });
}

module.exports = {
  getNewProxy,
  getNewProxyWithRetry,
  parseCooldownSeconds,
  isPermanentProxyError,
  parseProxyString,
  fetchViaProxy,
};
