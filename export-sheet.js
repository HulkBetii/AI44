const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const https = require('https');

const SPREADSHEET_ID = process.argv[2] || '1f3JJMMM6608aGAh8lMkxDmipANfwOv8_kiW1E8N_3KE';
const SERVICE_ACCOUNT_PATH = path.join(__dirname, 'service-account.json');

async function tryFetchPublic(sheetId, gid = '0') {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
  return new Promise((resolve) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (res.headers.location.includes('accounts.google.com')) {
          return resolve({ success: false, reason: 'auth_required' });
        }
        https.get(res.headers.location, (redirRes) => {
          let data = '';
          redirRes.on('data', chunk => { data += chunk; });
          redirRes.on('end', () => resolve({ success: true, data }));
        }).on('error', () => resolve({ success: false }));
        return;
      }
      if (res.statusCode === 200) {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ success: true, data }));
      } else {
        resolve({ success: false, statusCode: res.statusCode });
      }
    }).on('error', (err) => resolve({ success: false, error: err.message }));
  });
}

async function tryFetchServiceAccount(sheetId) {
  if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    return { success: false, reason: 'no_service_account_file' };
  }
  const creds = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, 'utf8'));
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
    const sheetsList = meta.data.sheets || [];
    const firstSheetTitle = sheetsList[0]?.properties?.title || 'Sheet1';
    
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${firstSheetTitle}!A:Z`,
    });
    return {
      success: true,
      title: meta.data.properties.title,
      sheetTitle: firstSheetTitle,
      rows: res.data.values || [],
    };
  } catch (err) {
    return {
      success: false,
      code: err.code || err.response?.status,
      message: err.message,
      clientEmail: creds.client_email,
    };
  }
}

function parseCsv(csvText) {
  const lines = csvText.split(/\r?\n/).filter(line => line.trim().length > 0);
  return lines.map(line => {
    const row = [];
    let inQuotes = false;
    let field = '';
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        row.push(field);
        field = '';
      } else {
        field += char;
      }
    }
    row.push(field);
    return row;
  });
}

function processAndSaveRows(rows, outPrefix = 'gmail_accounts') {
  if (!rows || rows.length === 0) {
    console.log('Không có dữ liệu trong bảng.');
    return;
  }

  const header = rows[0].map(h => String(h || '').trim());
  const dataRows = rows.slice(1);

  // Tìm các dòng chứa email hoặc gmail
  const processedData = [];
  for (let idx = 0; idx < dataRows.length; idx++) {
    const row = dataRows[idx];
    const rowObj = { _row: idx + 2 };
    let hasGmail = false;
    header.forEach((colName, colIdx) => {
      const val = row[colIdx] !== undefined ? String(row[colIdx]).trim() : '';
      rowObj[colName || `col_${colIdx + 1}`] = val;
      if (val.toLowerCase().includes('@gmail.com') || val.toLowerCase().includes('@')) {
        hasGmail = true;
      }
    });
    if (hasGmail || row.some(cell => String(cell).trim().length > 0)) {
      processedData.push(rowObj);
    }
  }

  const jsonPath = path.join(__dirname, `${outPrefix}.json`);
  const csvPath = path.join(__dirname, `${outPrefix}.csv`);

  fs.writeFileSync(jsonPath, JSON.stringify(processedData, null, 2), 'utf8');

  // Tạo lại file CSV chuẩn
  const csvLines = [header.map(h => `"${h.replace(/"/g, '""')}"`).join(',')];
  for (const item of processedData) {
    const line = header.map(h => {
      const val = item[h] || '';
      return `"${val.replace(/"/g, '""')}"`;
    }).join(',');
    csvLines.push(line);
  }
  fs.writeFileSync(csvPath, csvLines.join('\n'), 'utf8');

  console.log(`\n========================================`);
  console.log(`[THÀNH CÔNG] Đã xuất ${processedData.length} tài khoản:`);
  console.log(`- File JSON: ${jsonPath}`);
  console.log(`- File CSV:  ${csvPath}`);
  console.log(`========================================\n`);

  console.log('Xem trước 5 bản ghi đầu:');
  console.log(JSON.stringify(processedData.slice(0, 5), null, 2));
}

async function main() {
  console.log(`Đang kiểm tra quyền truy cập bảng tính: ${SPREADSHEET_ID}...`);

  // 1. Thử qua Service Account
  console.log('-> Kiểm tra qua Google Service Account...');
  const saRes = await tryFetchServiceAccount(SPREADSHEET_ID);
  if (saRes.success) {
    console.log(`-> Kết nối thành công tới sheet: "${saRes.title}" [${saRes.sheetTitle}]`);
    processAndSaveRows(saRes.rows);
    return;
  }

  console.log(`-> Service Account thất bại (Mã lỗi: ${saRes.code || 'UNKNOWN'}).`);
  if (saRes.code === 403 || saRes.code === 404) {
    console.log(`   Email Service Account: ${saRes.clientEmail}`);
    console.log(`   LÝ DO: Service Account chưa được cấp quyền truy cập bảng tính này!`);
  }

  // 2. Thử qua tải công khai (Public CSV)
  console.log('-> Kiểm tra truy cập công khai...');
  const pubRes = await tryFetchPublic(SPREADSHEET_ID);
  if (pubRes.success) {
    console.log('-> Tải thành công qua liên kết công khai!');
    const rows = parseCsv(pubRes.data);
    processAndSaveRows(rows);
    return;
  }

  console.log('-> Truy cập công khai cũng bị chặn (Yêu cầu đăng nhập Google).');
  console.log('\n--------------------------------------------------------------');
  console.log('HƯỚNG DẪN ĐỂ XUẤT DỮ LIỆU:');
  console.log('Vui lòng mở Google Sheet và cấp quyền theo 1 trong 2 cách sau:');
  console.log(`1. Cách 1 (Khuyên dùng): Bấm "Chia sẻ" (Share) -> Thêm email Service Account sau với quyền "Người xem":`);
  console.log(`   ${saRes.clientEmail}`);
  console.log(`2. Cách 2: Bấm "Chia sẻ" -> Đổi quyền truy cập chung thành "Bất kỳ ai có đường liên kết" (Anyone with the link).`);
  console.log('--------------------------------------------------------------');
}

main().catch(err => {
  console.error('Lỗi ngoại lệ:', err);
});
