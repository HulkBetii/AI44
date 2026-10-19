
const gpm = require('./gpm-api.js');
const { chromium } = require('playwright');
const { initSheets, loadRows, updateStatusByEmail } = require('./sheets.js');
const { loginMicrosoft, pollOutlookInbox } = require('./signup-hotmail.js');

async function verifyOnly(rowIndex) {
  await initSheets();
  const rows = await loadRows();
  const cred = rows.find(r => r.rowIndex === rowIndex);
  if (!cred) return console.log('Row not found');
  
  console.log('\n? Verifying ' + cred.email);
  const profileId = await gpm.createProfile(cred.email);
  const debugPort = await gpm.startProfile(profileId);
  const browser = await chromium.connectOverCDP('http://' + debugPort);
  const ctx = browser.contexts()[0];
  
  try {
    const outlookPage = await loginMicrosoft(ctx, cred.email, cred.password);
    console.log('[MS] Logged in to Outlook');
    
    const verifyUrl = await pollOutlookInbox(outlookPage, 'verifyEmail', 0, 60000);
    console.log('[Verify] URL found:', verifyUrl);
    
    const verifyPage = await ctx.newPage();
    await verifyPage.goto(verifyUrl, { waitUntil: 'domcontentloaded' });
    
    const continueBtn = verifyPage.locator('button:has-text(\Continue\), button:has-text(\Close\)').first();
    await continueBtn.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    if (await continueBtn.isVisible()) {
      await continueBtn.click();
      console.log('[Verify] Clicked continue');
    }
    
    console.log('[Verify] Successfully verified!');
    await updateStatusByEmail(cred.email, 'credentials-rejected'); 
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await browser.close().catch(()=>{});
    await gpm.stopProfile(profileId);
    await gpm.deleteProfile(profileId);
  }
}

(async () => {
  await verifyOnly(85);
  await verifyOnly(86);
})();

