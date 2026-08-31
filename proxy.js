const https = require('https');
const { collectSecretValues, redactSecrets } = require('./secret-sanitizer');

function getNewProxy(token, timeoutMs = 15000) {
  const secrets = collectSecretValues({ extra: [token] });
  const safe = (value) => redactSecrets(value, secrets);
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
            const reason = json.message || json.error || 'Unknown proxy API error';
            const safeReason = safe(reason);
            reject(new Error(`Proxy API failed with status: ${json.status} - Reason: ${safeReason}`));
          }
        } catch (e) {
          reject(new Error('Failed to parse proxy API response'));
        }
      });
    }).on('error', (e) => {
      reject(new Error(`Failed to call proxy API: ${safe(e.message)}`));
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
  const secrets = collectSecretValues({ extra: [token] });
  const safe = (value) => redactSecrets(value, secrets);
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await getNewProxy(token, timeoutMs);
    } catch (err) {
      const safeMessage = safe(err.message);
      lastErr = new Error(safeMessage);
      if (isPermanentProxyError(safeMessage)) {
        console.log(`[proxy] Not retrying - this is an account/token problem, not a transient one.`);
        break;
      }
      if (attempt === maxAttempts) break;
      const cooldownSec = parseCooldownSeconds(safeMessage);
      const waitMs = cooldownSec != null ? (cooldownSec + 2) * 1000 : fallbackDelayMs;
      console.log(`[proxy] Attempt ${attempt}/${maxAttempts} failed (${safeMessage}); retrying in ${Math.round(waitMs / 1000)}s...`);
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
  throw new Error('Unknown proxy format');
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
    let tlsSocket = null;
    let settled = false;
    const timer = setTimeout(() => {
      const error = new Error(`Proxy request timed out after ${timeoutMs}ms`);
      if (tlsSocket) tlsSocket.destroy(error);
      else socket.destroy(error);
    }, timeoutMs);
    const finish = (error, body) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(body);
    };
    const fail = (error) => finish(error);

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

      const statusLine = buf.split('\r\n')[0];
      if (!/^HTTP\/1\.[01] 200/.test(statusLine)) {
        socket.destroy();
        return fail(new Error(`Proxy CONNECT failed: ${statusLine}`));
      }

      // The tunnel is open; upgrade the raw socket to TLS for the actual HTTPS request.
      tlsSocket = tls.connect({ socket, servername: target.hostname }, () => {
        tlsSocket.write(
          `GET ${target.pathname}${target.search} HTTP/1.1\r\nHost: ${target.hostname}\r\nConnection: close\r\n\r\n`,
        );
      });
      let response = '';
      tlsSocket.on('data', (d) => { response += d.toString(); });
      tlsSocket.on('end', () => {
        const body = response.split('\r\n\r\n').slice(1).join('\r\n\r\n');
        finish(null, body);
      });
      tlsSocket.on('error', fail);
    }
    socket.on('data', onConnectResponse);
  });
}

// --------------- TinProxy residential FPT ---------------

const TINPROXY_API_BASE = 'https://api.tinproxy.com';

// Parse TinProxy FPT response into { proxy: "host:port:user:pass", nextChangeIP, publicIp }
function parseTinProxyData(data) {
  if (!data || !data.ipv4) throw new Error('TinProxy: missing ipv4 in response');
  const [host, port] = data.ipv4.split(':');
  const user = data.credential?.username;
  const pass = data.credential?.password;
  if (!host || !port || !user || !pass) {
    throw new Error(`TinProxy: incomplete proxy data (${data.ipv4})`);
  }
  return {
    proxy: `${host}:${port}:${user}:${pass}`,
    nextChangeIP: data.nextChangeIP || 0,
    publicIp: data.public_ipv4 || 'unknown',
  };
}

async function tinproxyFetch(endpoint, secrets = []) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${TINPROXY_API_BASE}${endpoint}`, { signal: controller.signal });
    let json;
    try {
      json = await res.json();
    } catch {
      throw new Error(res.ok ? 'TinProxy returned invalid JSON' : `TinProxy HTTP ${res.status}`);
    }
    if (!res.ok) {
      const reason = json?.message || json?.error;
      throw new Error(`TinProxy HTTP ${res.status}${reason ? `: ${reason}` : ''}`);
    }
    if (json.code !== 1) {
      const reason = json.message || `code ${json.code || 'unknown'}`;
      throw new Error(`TinProxy API error: ${redactSecrets(reason, secrets)}`);
    }
    return json.data;
  } catch (error) {
    throw new Error(redactSecrets(error.message, secrets));
  } finally {
    clearTimeout(timer);
  }
}

async function getNewTinProxy(apiKey) {
  const secrets = collectSecretValues({ extra: [apiKey] });
  const data = await tinproxyFetch(`/proxy-fpt/get-new?key=${encodeURIComponent(apiKey)}`, secrets);
  const result = parseTinProxyData(data);
  console.log(`[proxy] TinProxy new: IP ${result.publicIp} (${data.ipv4}), next change in ${result.nextChangeIP}s`);
  return result;
}

// Cooldown-aware retry: if the API says "wait N seconds", sleep and retry.
async function getNewTinProxyWithRetry(apiKey, { maxAttempts = 3 } = {}) {
  const secrets = collectSecretValues({ extra: [apiKey] });
  const safe = (value) => redactSecrets(value, secrets);
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await getNewTinProxy(apiKey);
    } catch (err) {
      // Extract a localized cooldown duration when the provider includes one.
      const safeMessage = safe(err.message);
      lastErr = new Error(safeMessage);
      const cooldownMatch = /(?:còn|đợi|wait)?\s*(\d+)\s*(?:s|gi[aâ]y|seconds?)/i.exec(safeMessage);
      const waitSec = cooldownMatch ? Number(cooldownMatch[1]) + 2 : null;
      const permanentHttpError = /^TinProxy HTTP 4\d\d\b/.test(safeMessage)
        && !/^TinProxy HTTP 429\b/.test(safeMessage)
        && waitSec == null;

      if (attempt === maxAttempts || permanentHttpError) break;

      if (waitSec) {
        console.log(`[proxy] TinProxy cooldown: waiting ${waitSec}s before retry ${attempt + 1}/${maxAttempts}...`);
        await new Promise((r) => setTimeout(r, waitSec * 1000));
      } else {
        console.log(`[proxy] TinProxy error (${safeMessage}); retrying in 10s (${attempt + 1}/${maxAttempts})...`);
        await new Promise((r) => setTimeout(r, 10000));
      }
    }
  }
  throw lastErr;
}

module.exports = {
  getNewProxy,
  getNewProxyWithRetry,
  parseCooldownSeconds,
  isPermanentProxyError,
  parseProxyString,
  fetchViaProxy,
  getNewTinProxyWithRetry,
};
