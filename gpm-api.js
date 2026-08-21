const http = require('http');

const API_BASE = 'http://127.0.0.1:19995';

function callApi(endpoint) {
  return new Promise((resolve, reject) => {
    http.get(`${API_BASE}${endpoint}`, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          // Xử lý các endpoint trả về chữ 'OK' hoặc chuỗi không phải JSON
          if (data.trim() === 'OK') {
            resolve({ status: true, message: 'OK' });
            return;
          }
          const json = JSON.parse(data);
          resolve(json);
        } catch (e) {
          resolve({ status: false, raw: data }); // Trả về raw text nếu không parse được
        }
      });
    }).on('error', (e) => {
      reject(new Error(`Failed to call GPM API at ${endpoint}: ${e.message}`));
    });
  });
}

/**
 * Tạo profile tạm thời.
 * @param {string} name Tên profile (ví dụ email)
 * @param {string} proxyChuoi proxy định dạng IP:Port hoặc IP:Port:User:Pass
 * @returns {Promise<string>} Trả về profile_id
 */
async function createProfile(name, proxy = '') {
  // GPM API v2 support proxy parameter: IP:Port:User:Pass
  let proxyParam = '';
  if (proxy) {
    proxyParam = `&proxy=${encodeURIComponent(proxy)}`;
  }
  
  const endpoint = `/v2/create?name=${encodeURIComponent(name)}${proxyParam}&canvas=on&font=on&webrtc=on`;
  const res = await callApi(endpoint);
  
  if (res && res.profile_id) {
    return res.profile_id;
  }
  throw new Error(`Create Profile failed: ${JSON.stringify(res)}`);
}

/**
 * Mở profile và trả về cổng kết nối CDP
 * @param {string} profileId 
 * @returns {Promise<string>} Địa chỉ debug (VD: 127.0.0.1:62561)
 */
async function startProfile(profileId) {
  const endpoint = `/v2/start?profile_id=${encodeURIComponent(profileId)}`;
  const res = await callApi(endpoint);
  
  if (res && res.selenium_remote_debug_address) {
    return res.selenium_remote_debug_address;
  }
  throw new Error(`Start Profile failed: ${JSON.stringify(res)}`);
}

/**
 * Đóng trình duyệt của profile
 */
async function stopProfile(profileId) {
  const endpoint = `/v2/stop?profile_id=${encodeURIComponent(profileId)}`;
  return await callApi(endpoint);
}

/**
 * Xóa vĩnh viễn profile (xóa cả data ổ cứng với mode=2)
 */
async function deleteProfile(profileId) {
  const endpoint = `/v2/delete?profile_id=${encodeURIComponent(profileId)}&mode=2`;
  return await callApi(endpoint);
}

module.exports = {
  createProfile,
  startProfile,
  stopProfile,
  deleteProfile
};
