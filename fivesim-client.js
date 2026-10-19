const { loadLocalConfig } = require('./runtime-config');

const API_BASE = 'https://5sim.net/v1';

function getToken(customToken) {
  if (customToken) return customToken;
  const config = loadLocalConfig();
  if (!config.fivesimToken) {
    throw new Error('5SIM token is missing. Configure fivesimToken in config.local.json');
  }
  return config.fivesimToken;
}

async function apiRequest(endpoint, { token, method = 'GET', body = null } = {}) {
  const authToken = getToken(token);
  const headers = {
    Authorization: `Bearer ${authToken}`,
    Accept: 'application/json',
  };
  if (body) {
    headers['Content-Type'] = 'application/json';
  }

  const options = { method, headers };
  if (body) {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(`${API_BASE}${endpoint}`, options);
  const text = await res.text();

  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // If not JSON, text might be raw error message like "no free phones" or "not enough user balance"
  }

  if (!res.ok) {
    const errorMsg = json?.message || text || `HTTP ${res.status}`;
    throw new Error(`5SIM API Error (${res.status}): ${errorMsg}`);
  }

  return json !== null ? json : text;
}

/**
 * Gets user profile (balance, rating, email).
 */
async function getProfile(token) {
  return await apiRequest('/user/profile', { token });
}

/**
 * Buys an activation phone number for a specific country.
 * @param {object} params
 * @param {string} params.country e.g. 'canada', 'indonesia', 'vietnam'
 * @param {string} [params.operator='any']
 * @param {string} [params.product='google']
 * @param {string} [params.token]
 */
async function buyNumber({ country, operator = 'any', product = 'google', token }) {
  if (!country) throw new Error('Country is required to buy 5SIM number');
  const endpoint = `/user/buy/activation/${encodeURIComponent(country)}/${encodeURIComponent(operator)}/${encodeURIComponent(product)}`;
  return await apiRequest(endpoint, { token });
}

/**
 * Tries buying a number following a priority list of countries.
 * If one country is out of stock ('no free phones'), falls back to the next country in list.
 * @param {object} params
 * @param {string[]} [params.countries=['canada', 'indonesia', 'vietnam']]
 * @param {string} [params.operator='any']
 * @param {string} [params.product='google']
 * @param {string} [params.token]
 */
async function buyCheapestAvailable({
  countries = ['canada', 'indonesia', 'vietnam'],
  operator = 'any',
  product = 'google',
  token,
} = {}) {
  let lastError = null;

  for (const country of countries) {
    try {
      console.log(`[5SIM] Attempting to buy Google number in "${country}"...`);
      const order = await buyNumber({ country, operator, product, token });
      if (order && order.id && order.phone) {
        console.log(`[5SIM] Successfully rented: ${order.phone} (Order ID: ${order.id}, Country: ${country}, Price: ${order.price})`);
        return order;
      }
    } catch (err) {
      console.log(`[5SIM] Could not buy number for "${country}": ${err.message}`);
      lastError = err;
    }
  }

  throw new Error(`[5SIM] Failed to buy number in any of [${countries.join(', ')}]. Last error: ${lastError?.message}`);
}

/**
 * Checks order status and retrieves received SMS.
 * @param {number|string} orderId
 * @param {string} [token]
 */
async function checkOrder(orderId, token) {
  return await apiRequest(`/user/check/${encodeURIComponent(orderId)}`, { token });
}

/**
 * Polls for SMS code until received or timeout.
 * @param {number|string} orderId
 * @param {object} [options]
 * @param {number} [options.timeoutSec=180] Max wait time in seconds (default: 3 minutes)
 * @param {number} [options.pollIntervalMs=3000] Interval between checks
 * @param {Function} [options.onProgress] Callback with remaining seconds
 */
async function waitForSms(orderId, {
  timeoutSec = 180,
  pollIntervalMs = 3000,
  onProgress = null,
  token = null,
} = {}) {
  const startTime = Date.now();
  const maxTime = timeoutSec * 1000;

  while (Date.now() - startTime < maxTime) {
    const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
    const remainingSec = timeoutSec - elapsedSec;
    if (typeof onProgress === 'function') {
      onProgress(remainingSec);
    }

    const order = await checkOrder(orderId, token);

    // Check if SMS list has arrived
    if (order.sms && Array.isArray(order.sms) && order.sms.length > 0) {
      const latest = order.sms[order.sms.length - 1];
      const code = latest.code || extractVerificationCode(latest.text);
      if (code) {
        console.log(`[5SIM] Received SMS OTP: ${code}`);
        return {
          code,
          text: latest.text,
          sender: latest.sender,
          order,
        };
      }
    }

    if (order.status === 'CANCELED' || order.status === 'TIMEOUT' || order.status === 'BANNED') {
      throw new Error(`[5SIM] Order ${orderId} ended with status: ${order.status}`);
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`[5SIM] Timed out waiting for SMS code after ${timeoutSec}s`);
}

/**
 * Helper to parse 6-digit verification code from SMS message text.
 * @param {string} text
 * @returns {string|null}
 */
function extractVerificationCode(text) {
  if (!text) return null;
  // Match standard Google verification code e.g. "G-123456" or "123456"
  const gMatch = /G-(\d{6})/i.exec(text);
  if (gMatch) return gMatch[1];
  const digitsMatch = /\b(\d{6})\b/.exec(text);
  if (digitsMatch) return digitsMatch[1];
  return null;
}

/**
 * Cancels the order and requests refund.
 * @param {number|string} orderId
 * @param {string} [token]
 */
async function cancelOrder(orderId, token) {
  try {
    const res = await apiRequest(`/user/cancel/${encodeURIComponent(orderId)}`, { token });
    console.log(`[5SIM] Order ${orderId} cancelled (refunded).`);
    return res;
  } catch (err) {
    console.warn(`[5SIM] Cancel order ${orderId} notice: ${err.message}`);
    return null;
  }
}

/**
 * Marks order as finished.
 * @param {number|string} orderId
 * @param {string} [token]
 */
async function finishOrder(orderId, token) {
  try {
    const res = await apiRequest(`/user/finish/${encodeURIComponent(orderId)}`, { token });
    console.log(`[5SIM] Order ${orderId} marked as finished.`);
    return res;
  } catch (err) {
    console.warn(`[5SIM] Finish order ${orderId} notice: ${err.message}`);
    return null;
  }
}

/**
 * Marks order as banned (number already used by service).
 * @param {number|string} orderId
 * @param {string} [token]
 */
async function banOrder(orderId, token) {
  try {
    const res = await apiRequest(`/user/ban/${encodeURIComponent(orderId)}`, { token });
    console.log(`[5SIM] Order ${orderId} reported as banned.`);
    return res;
  } catch (err) {
    console.warn(`[5SIM] Ban order ${orderId} notice: ${err.message}`);
    return null;
  }
}

module.exports = {
  getProfile,
  buyNumber,
  buyCheapestAvailable,
  checkOrder,
  waitForSms,
  extractVerificationCode,
  cancelOrder,
  finishOrder,
  banOrder,
};
