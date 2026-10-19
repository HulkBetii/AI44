const fs = require('fs');
let code = fs.readFileSync('signup-hotmail.js', 'utf8');

const startIndex = code.indexOf('    outcome = await attemptSignIn(page, email, newPassword);');
const endIndex = code.indexOf('  // Navigation away from the action URL');

if (startIndex !== -1 && endIndex !== -1) {
  const oldStr = code.substring(startIndex, endIndex);
  const newStr = `    outcome = await attemptSignIn(page, email, newPassword);
    if (outcome === SIGN_IN.OK) break;
    console.log(\`[reset] Sign-in attempt \${attempt}/3 result: \${outcome}\`);

    if (outcome === SIGN_IN.UNVERIFIED && attempt === 1) {
      console.log('[reset] Account is unverified (fresh link auto-sent by ElevenLabs). Polling Outlook...');
      const verifyRequestedAt = Date.now() - 30000;
      step('reset — poll Outlook for verify email');
      const verifyUrl = await pollOutlookInbox(outlookPage, INBOX_TIMEOUT_MS, 'verifyEmail', verifyRequestedAt);
      activeAdditionalSecrets.push(...collectUrlSecrets(verifyUrl));
      
      step('reset — open verify URL');
      await page.goto(verifyUrl, { waitUntil: 'domcontentloaded' });
      
      step('reset — click Continue');
      await page.waitForSelector('button:has-text("Continue")', { timeout: 15000 });
      await clickHuman(page, 'button:has-text("Continue")');
      await page.waitForTimeout(2000);
    } else if (outcome === SIGN_IN.UNVERIFIED) {
      const resendBtn = page.getByRole('button', { name: 'Resend', exact: true }).or(page.locator('button:has-text("Resend")'));
      if (await resendBtn.count() > 0) {
        console.log('[reset] Clicking Resend...');
        const requestedAt = Date.now();
        await clickHuman(page, resendBtn.first());
        step('reset — poll Outlook for resend verify email');
        const verifyUrl = await pollOutlookInbox(outlookPage, INBOX_TIMEOUT_MS, 'verifyEmail', requestedAt);
        activeAdditionalSecrets.push(...collectUrlSecrets(verifyUrl));
        await page.goto(verifyUrl, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('button:has-text("Continue")', { timeout: 15000 });
        await clickHuman(page, 'button:has-text("Continue")');
        await page.waitForTimeout(2000);
      }
    }
  }
  if (outcome !== SIGN_IN.OK) {
    throw new Error(\`Sign-in still failed after password reset (\${outcome})\`);
  }

`;
  fs.writeFileSync('signup-hotmail.js', code.replace(oldStr, newStr));
  console.log('Replaced successfully');
} else {
  console.log('Indices not found');
}
