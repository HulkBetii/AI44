const crypto = require('crypto');

/**
 * Decodes a base32 string into a Buffer.
 * Conforms to RFC 4648 base32 alphabet.
 * @param {string} str
 * @returns {Buffer}
 */
function base32Decode(str) {
  const clean = String(str || '')
    .replace(/=+$/, '')
    .replace(/\s+/g, '')
    .toUpperCase();

  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const output = [];

  for (let i = 0; i < clean.length; i++) {
    const val = alphabet.indexOf(clean[i]);
    if (val === -1) {
      throw new Error(`Invalid Base32 character: "${clean[i]}"`);
    }
    value = (value << 5) | val;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(output);
}

/**
 * Generates a 6-digit TOTP token using HMAC-SHA1 (RFC 6238).
 * @param {string} secret Base32 encoded secret key
 * @param {number} timeStep Time-step in seconds (default: 30)
 * @returns {string} 6-digit zero-padded OTP token
 */
function generateTOTP(secret, timeStep = 30) {
  const key = base32Decode(secret);
  const epoch = Math.floor(Date.now() / 1000);
  const counter = Math.floor(epoch / timeStep);

  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));

  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const otp = binary % 1000000;
  return otp.toString().padStart(6, '0');
}

/**
 * Returns remaining seconds in the current 30s TOTP cycle.
 * @param {number} timeStep
 * @returns {number}
 */
function getSecondsRemaining(timeStep = 30) {
  const epoch = Math.floor(Date.now() / 1000);
  return timeStep - (epoch % timeStep);
}

/**
 * Sanitizes base32 secret string (removes spaces, hyphens, converts to uppercase).
 * @param {string} secret
 * @returns {string}
 */
function cleanSecret(secret) {
  return String(secret || '').replace(/[\s-]+/g, '').toUpperCase();
}

module.exports = {
  base32Decode,
  generateTOTP,
  getSecondsRemaining,
  cleanSecret,
};
