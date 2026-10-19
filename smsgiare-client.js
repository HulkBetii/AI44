const { loadLocalConfig } = require('./runtime-config');

const API_V1_BASE = 'https://api.smsgiare.io.vn/api/v1';
const API_V2_BASE = 'https://api.smsgiare.io.vn/api/v2';

function getToken(customToken) {
  if (customToken) return customToken;
  const config = loadLocalConfig();
  const token = config.smsgiareToken || config.smsGiaReToken;
  if (!token) {
    throw new Error('SMSGIARE token is missing. Configure smsgiareToken in config.local.json');
  }
  return token;
}

/**
 * Normalizes phone number to international E.164 format (+84...)
 * @param {string} phone
 * @returns {string}
 */
function formatToInternational(phone) {
  let p = String(phone || '').trim().replace(/[^0-9+]/g, '');
  if (p.startsWith('+')) return p;
  if (p.startsWith('84')) return `+${p}`;
  if (p.startsWith('0')) return `+84${p.slice(1)}`;
  return `+${p}`;
}

/**
 * Checks user balance on SMSGIARE (v1 / v2)
 */
async function getBalance(customToken) {
  const token = getToken(customToken);
  const url = `${API_V1_BASE}/balance?token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) {
    throw new Error(`SMSGIARE API error: ${data.error}`);
  }
  return data; // { userName, balance }
}

/**
 * Gets list of v1 services (Kho VN VIP, Kho 1, 2, 3...)
 */
async function getV1Services() {
  const res = await fetch(`${API_V1_BASE}/getservices`);
  return await res.json();
}

/**
 * Buys a Vietnam phone number from v1 (Gmail warehouses 0, 1, 2, 3)
 * @param {object} params
 * @param {number} [params.serviceId=0] 0: Kho VN VIP, 1: Kho 1, 2: Kho 2, 3: Kho 3
 * @param {string} [params.carrier='ALL']
 * @param {string} [params.token]
 */
async function buyNumberV1({ serviceId = 0, carrier = 'ALL', token = null } = {}) {
  const authToken = getToken(token);
  const res = await fetch(`${API_V1_BASE}/buy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: authToken,
      serviceId,
      carrier,
    }),
  });

  const data = await res.json();
  if (data.error) {
    throw new Error(`SMSGIARE buy error: ${data.error}`);
  }
  if (!data.requestId || !data.phoneNum) {
    throw new Error(`SMSGIARE buy failed: ${data.message || JSON.stringify(data)}`);
  }

  return {
    requestId: data.requestId,
    phone: formatToInternational(data.phoneNum),
    rawPhone: data.phoneNum,
    price: data.price,
    ttl: data.ttl || 300,
    serviceId,
    provider: 'smsgiare_v1',
  };
}

/**
 * Tries buying a Gmail number prioritizing highest rate (99%, 90%+) and lowest price.
 * 1. Kho Indo (ID: 4) - 2.700đ (99%)
 * 2. Kho Cameroon (ID: 8) - 3.100đ (99%)
 * 3. Kho Malaysia (ID: 7) - 3.200đ (99%)
 * 4. Kho VN VIP (ID: 0) - 3.300đ (90%+)
 * 5. Kho 2 (ID: 2) - 3.750đ
 * 6. Kho 3 (ID: 3) - 3.750đ
 * 7. Kho 1 (ID: 1) - 3.850đ (90%+)
 */
async function buyGmailNumberAuto(customToken) {
  let rankedServices = [];
  try {
    const all = await getV1Services();
    rankedServices = all
      .filter((s) => /gmail|google/i.test(s.serviceName) && !/không reg|voice|message/i.test(s.serviceName))
      .sort((a, b) => {
        const rateA = /99%/i.test(a.serviceName) ? 99 : (/90%/i.test(a.serviceName) ? 90 : 80);
        const rateB = /99%/i.test(b.serviceName) ? 99 : (/90%/i.test(b.serviceName) ? 90 : 80);
        if (rateA !== rateB) return rateB - rateA; // Tỉ lệ cao hơn lên trước
        return a.price - b.price; // Rẻ hơn lên trước
      });
  } catch (e) {
    console.warn(`[SMSGIARE] Could not fetch live service list, using default ranking: ${e.message}`);
  }

  // Fallback list if API fetch fails:
  const priorityIds = rankedServices.length > 0 
    ? rankedServices.map((s) => ({ id: s.id, name: s.serviceName, price: s.price }))
    : [
        { id: 4, name: 'Kho Indo (99%)', price: 2700 },
        { id: 8, name: 'Kho Cameroon (99%)', price: 3100 },
        { id: 7, name: 'Kho Malaysia (99%)', price: 3200 },
        { id: 0, name: 'Kho VN VIP (90%+)', price: 3300 },
        { id: 2, name: 'Kho 2 Reg Gmail', price: 3750 },
        { id: 3, name: 'Kho 3', price: 3750 },
        { id: 1, name: 'Kho 1 NEW (90%)', price: 3850 },
      ];

  let lastErr = null;

  for (const s of priorityIds) {
    try {
      console.log(`[SMSGIARE] Trying warehouse: ${s.name} (ID: ${s.id}, Giá: ${s.price}đ)...`);
      const order = await buyNumberV1({ serviceId: s.id, token: customToken });
      console.log(`[SMSGIARE] Successfully rented: ${order.phone} (RequestId: ${order.requestId}, Price: ${order.price}đ)`);
      return order;
    } catch (err) {
      console.log(`[SMSGIARE] Warehouse ${s.id} unavailable: ${err.message}`);
      lastErr = err;
    }
  }

  throw new Error(`[SMSGIARE] Could not rent Gmail number from any warehouse. Last error: ${lastErr?.message}`);
}

/**
 * Polls for SMS OTP on v1 (/getcode)
 * @param {string} requestId
 * @param {object} [options]
 * @param {number} [options.timeoutSec=180]
 * @param {number} [options.pollIntervalMs=3000]
 * @param {Function} [options.onProgress]
 */
async function waitForSmsV1(requestId, {
  timeoutSec = 180,
  pollIntervalMs = 3000,
  onProgress = null,
} = {}) {
  const startTime = Date.now();
  const maxTime = timeoutSec * 1000;

  while (Date.now() - startTime < maxTime) {
    const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
    const remainingSec = timeoutSec - elapsedSec;
    if (typeof onProgress === 'function') {
      onProgress(remainingSec);
    }

    const res = await fetch(`${API_V1_BASE}/getcode?requestId=${encodeURIComponent(requestId)}`);
    const data = await res.json();

    // Success response: { status: 11, code: "123456", message: "OK", phoneNum: "..." }
    if (data.status === 11 && data.code) {
      console.log(`[SMSGIARE] Received OTP: ${data.code}`);
      return {
        code: data.code,
        message: data.message,
        phoneNum: data.phoneNum,
      };
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw new Error(`[SMSGIARE] Timed out waiting for SMS OTP after ${timeoutSec}s`);
}

/**
 * Buys international number from v2 (action=buy)
 */
async function buyNumberV2({ country = 6, service = 'go', token = null } = {}) {
  const authToken = getToken(token);
  const res = await fetch(`${API_V2_BASE}?action=buy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      token: authToken,
      service,
      country: String(country),
    }),
  });

  const data = await res.json();
  if (data.error) {
    throw new Error(`SMSGIARE v2 buy error: ${data.error}`);
  }

  return {
    requestId: data.requestId,
    phone: formatToInternational(data.phoneNum),
    rawPhone: data.phoneNum,
    price: data.price,
    ttl: data.ttl || 1200,
    provider: 'smsgiare_v2',
  };
}

/**
 * Cancels order on v2 and requests refund
 */
async function cancelOrderV2(requestId, customToken) {
  const token = getToken(customToken);
  try {
    const res = await fetch(`${API_V2_BASE}?action=cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, requestId }),
    });
    return await res.json();
  } catch (err) {
    console.warn(`[SMSGIARE] Cancel v2 order notice: ${err.message}`);
    return null;
  }
}

module.exports = {
  getBalance,
  getV1Services,
  buyNumberV1,
  buyGmailNumberAuto,
  waitForSmsV1,
  buyNumberV2,
  cancelOrderV2,
  formatToInternational,
};
