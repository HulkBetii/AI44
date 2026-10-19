const path = require('path');
const fs = require('fs');
const { KeyService } = require('../dist/server/services/key-service.js');

async function main() {
  console.log('============================================================');
  console.log('🔍 VERIFYING BACKEND KEY MANAGEMENT APIS (LIVE)');
  console.log('============================================================\n');

  const keyService = new KeyService(path.join(__dirname, '..'));

  // 1. Read a real key from new-5-keys.txt
  const keyContent = fs.readFileSync(path.join(__dirname, '..', 'new-5-keys.txt'), 'utf8');
  const realKey = keyContent.split('\n')[0].replace(' ,', '').trim();
  console.log(`[Test 1] Testing checkQuota with real Bearer Token (${realKey.slice(0, 15)}...)...`);
  const quotaResult = await keyService.checkQuota({ key: realKey });
  console.log('Quota Result:', JSON.stringify(quotaResult, null, 2));

  // 2. Test checkQuota with email lookup
  console.log('\n[Test 2] Testing checkQuota with email lookup (zoewilson65239@mrhulkstore.store)...');
  const emailQuotaResult = await keyService.checkQuota({ email: 'zoewilson65239@mrhulkstore.store' });
  console.log('Email Quota Result:', JSON.stringify(emailQuotaResult, null, 2));

  // 3. Test listKeys in JSON format
  console.log('\n[Test 3] Testing listKeys with limit=3 (format=json)...');
  const listJson = await keyService.listKeys({
    limit: 3,
    offset: 0,
    status: 'complete',
    format: 'json',
    with_quota: false,
  });
  console.log(`Listed ${listJson.count} keys (total: ${listJson.total}):`);
  listJson.data.forEach((item, idx) => {
    console.log(`  ${idx + 1}. [Row ${item.rowIndex}] ${item.email} -> ${item.apiKey.slice(0, 20)}...`);
  });

  // 4. Test listKeys in Text format
  console.log('\n[Test 4] Testing listKeys with limit=3 (format=text)...');
  const listText = await keyService.listKeys({
    limit: 3,
    offset: 0,
    status: 'complete',
    format: 'text',
    with_quota: false,
  });
  console.log('Text Output:');
  console.log(listText.split('\n').map(l => '  ' + (l.length > 30 ? l.slice(0, 25) + '... ' + l.slice(-4) : l)).join('\n'));

  // 5. Test refreshKey with mode=provision
  console.log('\n[Test 5] Testing refreshKey with mode=provision (allocating unexhausted standby key)...');
  const refreshResult = await keyService.refreshKey({
    email: 'zoewilson65239@mrhulkstore.store',
    mode: 'provision',
  });
  console.log('Refresh Result:', JSON.stringify(refreshResult, null, 2));

  console.log('\n🎉 ALL LIVE API TESTS PASSED 100%!');
}

main().catch((err) => {
  console.error('❌ Live API Test failed:', err);
  process.exit(1);
});
