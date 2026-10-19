/**
 * proxyxoay-client.js
 * High-performance, resilient client for ProxyXoay (proxyxoay.shop / topproxy.vn).
 * Features:
 * - Accurate 60s cooldown timer & server-reported cooldown parsing ("Con Xs moi co the doi proxy")
 * - Mutex lock preventing concurrent workers from triggering cooldown collision
 * - Clean proxy string parsing ('IP:PORT::' -> 'IP:PORT')
 * - TCP socket health-check prior to delivering proxy to GPM / Playwright
 * - Exponential backoff & retry mechanism
 */

const net = require('net');
const { loadLocalConfig } = require('./runtime-config');

const API_BASE = 'https://proxyxoay.shop/api/get.php';
const MIN_COOLDOWN_SEC = 60;

let lastRotationTimestamp = 0;
let cachedProxy = null;
let proxyDieTimestamp = 0;
let rotationMutex = Promise.resolve();

/**
 * Parses raw proxy string like '160.250.166.11:10131::' into clean format.
 * @param {string} rawProxy
 * @returns {{ host: string, port: string, user: string, pass: string, proxyString: string, server: string }}
 */
function parseProxyHttp(rawProxy) {
  if (!rawProxy || typeof rawProxy !== 'string') {
    throw new Error(`Invalid or empty proxy string: ${rawProxy}`);
  }

  // Remove trailing colons and whitespace: e.g. "160.250.166.11:10131::" -> "160.250.166.11:10131"
  const cleaned = rawProxy.replace(/[:\s]+$/, '');
  const parts = cleaned.split(':');
  if (parts.length < 2) {
    throw new Error(`Invalid proxy format: ${rawProxy}`);
  }

  const host = parts[0].trim();
  const port = parts[1].trim();
  const user = parts[2]?.trim() || '';
  const pass = parts[3]?.trim() || '';

  const proxyString = user && pass ? `${host}:${port}:${user}:${pass}` : `${host}:${port}`;
  const server = `http://${host}:${port}`;

  return { host, port, user, pass, proxyString, server };
}

/**
 * Parse cooldown seconds from ProxyXoay server response message
 * e.g. "Con 51s moi co the doi proxy" -> 51
 * @param {string} message
 * @returns {number|null}
 */
function parseCooldownSeconds(message) {
  if (!message || typeof message !== 'string') return null;
  const match = message.match(/Con\s+(\d+)\s*s/i) || message.match(/doi\s+(\d+)\s*s/i);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Parse proxy lifetime remaining seconds from message
 * e.g. "proxy nay se die sau 1593s" -> 1593
 * @param {string} message
 * @returns {number}
 */
function parseLifetimeSeconds(message) {
  if (!message || typeof message !== 'string') return 1800; // default 30 mins
  const match = message.match(/die\s+sau\s+(\d+)\s*s/i);
  return match ? parseInt(match[1], 10) : 1800;
}

/**
 * Fast TCP health check to ensure proxy server is listening.
 * @param {string} host
 * @param {string|number} port
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
function checkProxyTcp(host, port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    socket.setTimeout(timeoutMs);

    socket.connect(Number(port), host, () => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(true);
      }
    });

    socket.on('timeout', () => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(false);
      }
    });

    socket.on('error', () => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(false);
      }
    });
  });
}

/**
 * Calls ProxyXoay API to get or rotate IP.
 * @param {string} [apiKey]
 * @param {object} [options]
 * @param {string} [options.nhamang='random'] - 'random' | 'viettel' | 'vnpt' | 'fpt'
 * @param {string|number} [options.tinhthanh=0] - 0 for random, or specific province code
 * @returns {Promise<object>}
 */
async function getProxyXoay(apiKey, options = {}) {
  const config = loadLocalConfig();
  const key = apiKey || config.proxyXoayKey;
  if (!key) {
    throw new Error('ProxyXoay API key is missing. Configure proxyXoayKey in config.local.json');
  }

  const nhamang = options.nhamang || 'random';
  const tinhthanh = options.tinhthanh !== undefined ? options.tinhthanh : 0;
  const url = `${API_BASE}?key=${encodeURIComponent(key)}&nhamang=${encodeURIComponent(nhamang)}&tinhthanh=${encodeURIComponent(tinhthanh)}&whitelist=`;

  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    throw new Error(`ProxyXoay HTTP error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  if (data.status !== 100) {
    const errorMsg = data.message || data.comen || JSON.stringify(data);
    const cooldownSec = parseCooldownSeconds(errorMsg);
    const err = new Error(`ProxyXoay error (status ${data.status}): ${errorMsg}`);
    err.status = data.status;
    err.cooldownSec = cooldownSec;
    throw err;
  }

  const parsed = parseProxyHttp(data.proxyhttp);
  const remainingLifetimeSec = parseLifetimeSeconds(data.message);

  lastRotationTimestamp = Date.now();
  proxyDieTimestamp = Date.now() + remainingLifetimeSec * 1000;

  const result = {
    ...parsed,
    proxy: parsed.proxyString,
    proxysocks5: data.proxysocks5 ? parseProxyHttp(data.proxysocks5).proxyString : '',
    publicIp: data.ip || parsed.host,
    isp: data['Nha Mang'] || 'unknown',
    location: data['Vi Tri'] || 'unknown',
    message: data.message || '',
    tokenExpires: data['Token expiration date'] || '',
    dieAt: proxyDieTimestamp,
    remainingLifetimeSec,
  };

  cachedProxy = result;
  return result;
}

/**
 * Ensures cooldown has elapsed, then requests a new IP.
 * Thread-safe across multiple concurrent workers using an internal mutex.
 * @param {string} [apiKey]
 * @param {object} [options]
 * @returns {Promise<object>}
 */
async function rotateProxyWithCooldown(apiKey, options = {}) {
  // Chain through mutex so concurrent workers wait in line
  const executeRotation = async () => {
    const elapsedSec = Math.floor((Date.now() - lastRotationTimestamp) / 1000);
    const remainingWaitSec = MIN_COOLDOWN_SEC - elapsedSec;

    if (lastRotationTimestamp > 0 && remainingWaitSec > 0) {
      console.log(`[ProxyXoay] ⏳ Cooldown active. Waiting ${remainingWaitSec}s before rotating IP...`);
      await new Promise((resolve) => setTimeout(resolve, remainingWaitSec * 1000));
    }

    try {
      return await getProxyXoay(apiKey, options);
    } catch (err) {
      // If server returned status 101/102 with exact remaining cooldown
      if (err.cooldownSec && err.cooldownSec > 0) {
        console.log(`[ProxyXoay] ⏳ Server reported ${err.cooldownSec}s remaining cooldown. Waiting...`);
        await new Promise((resolve) => setTimeout(resolve, (err.cooldownSec + 1) * 1000));
        return await getProxyXoay(apiKey, options);
      }
      throw err;
    }
  };

  // Mutex lock acquisition
  const currentTask = rotationMutex.then(executeRotation, executeRotation);
  rotationMutex = currentTask.catch(() => {});
  return currentTask;
}

/**
 * High-level wrapper with retry and TCP health validation.
 * @param {string} [apiKey]
 * @param {object} [options]
 * @param {number} [maxRetries=3]
 * @returns {Promise<object>}
 */
async function getNewProxyXoayWithRetry(apiKey, options = {}, maxRetries = 3) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[ProxyXoay] Requesting new rotating IP (attempt ${attempt}/${maxRetries})...`);
      const proxyInfo = await rotateProxyWithCooldown(apiKey, options);

      console.log(`[ProxyXoay] ✅ Acquired proxy: ${proxyInfo.proxy} | ISP: ${proxyInfo.isp.toUpperCase()} | Location: ${proxyInfo.location} | IP: ${proxyInfo.publicIp}`);

      // TCP Health Check
      const isListening = await checkProxyTcp(proxyInfo.host, proxyInfo.port, 4000);
      if (!isListening) {
        console.warn(`[ProxyXoay] ⚠️ TCP port ${proxyInfo.port} on ${proxyInfo.host} not responding yet. Waiting 2s...`);
        await new Promise((r) => setTimeout(r, 2000));
        const retryListening = await checkProxyTcp(proxyInfo.host, proxyInfo.port, 5000);
        if (!retryListening) {
          throw new Error(`Proxy port ${proxyInfo.host}:${proxyInfo.port} is unreachable via TCP`);
        }
      }

      return proxyInfo;
    } catch (err) {
      lastError = err;
      console.error(`[ProxyXoay] ❌ Rotation attempt ${attempt} failed: ${err.message}`);
      if (attempt < maxRetries) {
        const backoffMs = (err.cooldownSec ? (err.cooldownSec + 2) : 5) * 1000;
        console.log(`[ProxyXoay] Waiting ${backoffMs / 1000}s before next attempt...`);
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }

  throw new Error(`Failed to obtain healthy ProxyXoay after ${maxRetries} attempts: ${lastError?.message}`);
}

const usedPublicIps = new Set();

/**
 * Acquire a strictly unique ProxyXoay IP for an account.
 * Ensures no two accounts ever share the same public IP.
 * @param {string} [apiKey]
 * @param {object} [options]
 * @param {number} [maxRotationAttempts=5]
 * @returns {Promise<object>}
 */
async function getUniqueProxyXoayForAccount(apiKey, options = {}, maxRotationAttempts = 5) {
  for (let attempt = 1; attempt <= maxRotationAttempts; attempt++) {
    const proxyInfo = await getNewProxyXoayWithRetry(apiKey, options);
    const ip = proxyInfo.publicIp;

    if (usedPublicIps.has(ip)) {
      console.warn(`[ProxyXoay] ⚠️ IP ${ip} has already been used by another account in this session!`);
      console.warn(`[ProxyXoay] [Rule] Each account must run on its own unique IP. Forcing cooldown rotation (attempt ${attempt}/${maxRotationAttempts})...`);
      if (attempt < maxRotationAttempts) {
        const elapsed = Math.floor((Date.now() - lastRotationTimestamp) / 1000);
        const waitTime = Math.max(5, MIN_COOLDOWN_SEC - elapsed + 2);
        console.log(`[ProxyXoay] Waiting ${waitTime}s to trigger next IP rotation...`);
        await new Promise((r) => setTimeout(r, waitTime * 1000));
        continue;
      }
      throw new Error(`Could not obtain a unique ProxyXoay IP after ${maxRotationAttempts} rotations (last IP was repeated: ${ip})`);
    }

    usedPublicIps.add(ip);
    console.log(`[ProxyXoay] 🔒 Unique IP locked for this account: ${ip} (Session unique IPs: ${usedPublicIps.size})`);
    return proxyInfo;
  }
}

module.exports = {
  getProxyXoay,
  rotateProxyWithCooldown,
  getNewProxyXoayWithRetry,
  getUniqueProxyXoayForAccount,
  parseProxyHttp,
  parseCooldownSeconds,
  checkProxyTcp,
  usedPublicIps,
};
