/**
 * sms-provider.js
 * 5sim.net REST API Client for automated SMS verification.
 */

const { loadRegConfig } = require('./config');
const { collectSecretValues, redactSecrets } = require('../secret-sanitizer');

const FIVE_SIM_BASE = 'https://5sim.net/v1';
const DEFAULT_POLL_INTERVAL_MS = 3000;
const DEFAULT_TIMEOUT_MS = 180000; // 3 minutes

const OrderStatus = {
  PENDING: 'PENDING',
  RECEIVED: 'RECEIVED',
  CANCELED: 'CANCELED',
  TIMEOUT: 'TIMEOUT',
  BANNED: 'BANNED',
  FINISHED: 'FINISHED',
};

function sanitizeError(err, apiKey) {
  const secrets = collectSecretValues({ extra: [apiKey] });
  return redactSecrets(err.message || String(err), secrets);
}

async function request5sim(endpoint, apiKey, options = {}) {
  if (!apiKey) {
    throw new Error('5sim API key is required. Please configure fivesimApiKey in config.local.json or FIVESIM_API_KEY env.');
  }

  const url = `${FIVE_SIM_BASE}${endpoint}`;
  const timeoutMs = options.timeoutMs || 15000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: options.method || 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`5sim API error HTTP ${res.status}: ${text || res.statusText}`);
    }

    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`5sim API request timed out after ${timeoutMs}ms (${endpoint})`);
    }
    throw new Error(`5sim API failed: ${sanitizeError(err, apiKey)}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch current user profile & balance
 */
async function getBalance(customApiKey) {
  const config = loadRegConfig();
  const apiKey = customApiKey || config.fivesimApiKey;
  const data = await request5sim('/user/profile', apiKey);
  return {
    balance: typeof data.balance === 'number' ? data.balance : parseFloat(data.balance || 0),
    rating: data.rating,
    email: data.email,
  };
}

/**
 * Buy an activation phone number
 * @param {Object} opts
 * @param {string} [opts.country] - Country code or name (e.g. 'england', 'indonesia', 'vietnam')
 * @param {string} [opts.operator] - Operator name or 'any'
 * @param {string} [opts.service] - Service name ('hotmail' or 'microsoft')
 * @param {number} [opts.maxPrice] - Max price willing to pay
 * @param {string} [opts.apiKey]
 */
async function buyNumber(opts = {}) {
  const config = loadRegConfig();
  const apiKey = opts.apiKey || config.fivesimApiKey;
  const country = (opts.country || config.fivesimCountry || 'england').toLowerCase();
  const operator = (opts.operator || config.fivesimOperator || 'any').toLowerCase();
  const service = (opts.service || config.fivesimService || 'hotmail').toLowerCase();
  const maxPrice = opts.maxPrice !== undefined ? opts.maxPrice : config.fivesimMaxPrice;

  const endpoint = `/user/buy/activation/${country}/${operator}/${service}`;
  const data = await request5sim(endpoint, apiKey);

  if (!data || !data.id || !data.phone) {
    throw new Error(`Failed to purchase number from 5sim: ${JSON.stringify(data)}`);
  }

  if (maxPrice && data.price && data.price > maxPrice) {
    // Cancel immediately if price exceeds ceiling
    await cancelOrder(data.id, apiKey).catch(() => {});
    throw new Error(`Number price (${data.price}) exceeded maxPrice threshold (${maxPrice})`);
  }

  return {
    id: data.id,
    phone: data.phone.startsWith('+') ? data.phone : `+${data.phone}`,
    rawPhone: data.phone.replace(/^\+/, ''),
    operator: data.operator,
    product: data.product,
    price: data.price,
    status: data.status,
    country: data.country,
    expires: data.expires,
    createdAt: data.created_at,
  };
}

/**
 * Check order status and messages
 */
async function checkOrder(orderId, customApiKey) {
  const config = loadRegConfig();
  const apiKey = customApiKey || config.fivesimApiKey;
  return request5sim(`/user/check/${orderId}`, apiKey);
}

/**
 * Extract OTP code from SMS body text
 */
function extractOtpCode(smsText) {
  if (!smsText) return null;
  const codeMatch = smsText.match(/(?:code|mã|security code|verification code)\s*(?:is|là|:)?\s*(\d{4,8})/i)
    || smsText.match(/\b(\d{4,8})\b/);
  return codeMatch ? codeMatch[1] : null;
}

/**
 * Poll 5sim order until SMS is received or timeout
 */
async function pollForSms(orderId, opts = {}) {
  const config = loadRegConfig();
  const apiKey = opts.apiKey || config.fivesimApiKey;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const intervalMs = opts.intervalMs || DEFAULT_POLL_INTERVAL_MS;
  const onPoll = opts.onPoll || (() => {});

  const startTime = Date.now();
  let attempts = 0;

  while (Date.now() - startTime < timeoutMs) {
    attempts++;
    const order = await checkOrder(orderId, apiKey);
    onPoll({ attempts, elapsedMs: Date.now() - startTime, status: order.status });

    if (order.status === OrderStatus.CANCELED || order.status === OrderStatus.TIMEOUT || order.status === OrderStatus.BANNED) {
      throw new Error(`Order ${orderId} terminated with status: ${order.status}`);
    }

    if (Array.isArray(order.sms) && order.sms.length > 0) {
      const latestSms = order.sms[order.sms.length - 1];
      const code = latestSms.code || extractOtpCode(latestSms.text);
      if (code) {
        return {
          code,
          fullText: latestSms.text,
          sender: latestSms.sender,
          orderId,
        };
      }
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out waiting for SMS after ${Math.round(timeoutMs / 1000)}s (Order ID: ${orderId})`);
}

/**
 * Finish order (confirm success)
 */
async function finishOrder(orderId, customApiKey) {
  const config = loadRegConfig();
  const apiKey = customApiKey || config.fivesimApiKey;
  return request5sim(`/user/finish/${orderId}`, apiKey);
}

/**
 * Cancel order (trigger refund if eligible)
 */
async function cancelOrder(orderId, customApiKey) {
  const config = loadRegConfig();
  const apiKey = customApiKey || config.fivesimApiKey;
  return request5sim(`/user/cancel/${orderId}`, apiKey);
}

/**
 * Ban order (report invalid/used number)
 */
async function banOrder(orderId, customApiKey) {
  const config = loadRegConfig();
  const apiKey = customApiKey || config.fivesimApiKey;
  return request5sim(`/user/ban/${orderId}`, apiKey);
}

/**
 * Buy number with automatic retry for resilience
 */
async function buyNumberWithRetry(opts = {}, maxRetries = 3, baseDelayMs = 2000) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await buyNumber(opts);
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(1.5, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError || new Error(`Failed to purchase number after ${maxRetries} attempts`);
}

module.exports = {
  OrderStatus,
  getBalance,
  buyNumber,
  buyNumberWithRetry,
  checkOrder,
  pollForSms,
  finishOrder,
  cancelOrder,
  banOrder,
  extractOtpCode,
};
