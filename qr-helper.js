const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

function decodeQrFromBase64(base64Str) {
  try {
    const tmpImg = path.join(__dirname, `tmp-qr-${Date.now()}.png`);
    const cleanB64 = base64Str.includes('base64,') ? base64Str.split('base64,')[1] : base64Str;
    fs.writeFileSync(tmpImg, Buffer.from(cleanB64, 'base64'));
    
    const scriptPath = path.join(__dirname, 'decode-qr.py');
    const result = execSync(`python "${scriptPath}" "${tmpImg}"`, { encoding: 'utf8', timeout: 5000 });
    
    if (fs.existsSync(tmpImg)) {
      try { fs.unlinkSync(tmpImg); } catch {}
    }
    return (result || '').trim();
  } catch (err) {
    console.warn(`[QR] Failed to decode QR: ${err.message}`);
    return '';
  }
}

module.exports = { decodeQrFromBase64 };
