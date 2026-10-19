/**
 * temp-mail.js (reg-museai)
 * Mail.tm REST API client for creating disposable emails and extracting Meta OTPs.
 */

const https = require('https');
const { generateRealisticName } = require('../human-behavior');

function apiRequest(path, method = 'GET', body = null, token = null) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {
      'Accept': 'application/json',
    };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const req = https.request({
      hostname: 'api.mail.tm',
      path,
      method,
      headers,
    }, (res) => {
      let resp = '';
      res.on('data', (c) => { resp += c; });
      res.on('end', () => {
        try {
          const parsed = resp ? JSON.parse(resp) : {};
          resolve({ status: res.statusCode, data: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, raw: resp });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error('mail.tm API timeout'));
    });

    if (data) req.write(data);
    req.end();
  });
}

/**
 * Tạo một tài khoản Mail tạm mới trên mail.tm
 * @returns {Promise<{ email: string, password: string, token: string }>}
 */
async function createTempMailAccount() {
  const domainRes = await apiRequest('/domains');
  const domains = Array.isArray(domainRes.data)
    ? domainRes.data
    : (domainRes.data?.['hydra:member'] || []);
  if (!domains.length) {
    throw new Error('Không có domain khả dụng trên mail.tm');
  }
  const domain = domains[0].domain;

  const { firstName, lastName } = generateRealisticName();
  const num = Math.floor(100 + Math.random() * 900);
  const cleanFirst = firstName.toLowerCase().replace(/[^a-z]/g, '').slice(0, 8);
  const email = `${cleanFirst}${num}@${domain}`;
  const password = `Pass!${Math.random().toString(36).slice(2, 10)}#`;

  console.log(`[temp-mail] Đang tạo hộp thư tạm: ${email}...`);
  const createRes = await apiRequest('/accounts', 'POST', { address: email, password });
  if (createRes.status !== 201) {
    throw new Error(`Tạo mail.tm thất bại (status ${createRes.status}): ${JSON.stringify(createRes.data)}`);
  }

  const tokenRes = await apiRequest('/token', 'POST', { address: email, password });
  if (tokenRes.status !== 200 || !tokenRes.data?.token) {
    throw new Error(`Lấy token mail.tm thất bại (status ${tokenRes.status})`);
  }

  console.log(`[temp-mail] ✅ Đã tạo hộp thư tạm thành công: ${email}`);
  return {
    email,
    password,
    token: tokenRes.data.token,
  };
}

/**
 * Đọc mã OTP 6 số gửi từ Meta tới hộp thư mail.tm
 * @param {string} token 
 * @param {number} timeoutMs 
 * @returns {Promise<{ code: string, subject: string, sender: string }>}
 */
async function fetchMuseOtpFromTempMail(token, timeoutMs = 120000) {
  const startTime = Date.now();
  console.log('[temp-mail] Đang lắng nghe hộp thư tạm chờ mã OTP từ Meta...');

  while (Date.now() - startTime < timeoutMs) {
    try {
      const listRes = await apiRequest('/messages', 'GET', null, token);
      const messages = Array.isArray(listRes.data)
        ? listRes.data
        : (listRes.data?.['hydra:member'] || []);

      if (messages.length > 0) {
        // Duyệt tìm thư từ Meta/Muse
        for (const msg of messages) {
          const from = msg.from?.address || '';
          const subject = msg.subject || '';
          const intro = msg.intro || '';

          if (/meta|muse|confirm|security/i.test(from) || /confirm|code|mã/i.test(subject) || /code|mã/i.test(intro)) {
            // Lấy chi tiết nội dung email
            const detailRes = await apiRequest(`/messages/${msg.id}`, 'GET', null, token);
            const content = `${subject}\n${intro}\n${detailRes.data?.text || ''}\n${detailRes.data?.html || ''}`;

            const otpMatch = content.match(/\b(\d{6})\b/);
            if (otpMatch) {
              const code = otpMatch[1];
              const elapsedSec = Math.round((Date.now() - startTime) / 1000);
              console.log(`[temp-mail] ✅ Đã tìm thấy mã OTP sau ${elapsedSec}s: ${code} (Từ: ${from} | Tiêu đề: "${subject}")`);
              return { code, subject, sender: from };
            }
          }
        }
      }
    } catch (err) {
      console.warn(`[temp-mail] Lỗi khi kiểm tra tin nhắn: ${err.message}`);
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    process.stdout.write(`[temp-mail] Đang đợi email mã xác nhận... (${elapsed}s / ${Math.round(timeoutMs / 1000)}s)\r`);
    await new Promise((r) => setTimeout(r, 3000));
  }

  throw new Error(`[temp-mail] Hết thời gian chờ (${Math.round(timeoutMs / 1000)}s) không nhận được mã xác nhận.`);
}

module.exports = {
  createTempMailAccount,
  fetchMuseOtpFromTempMail,
};
