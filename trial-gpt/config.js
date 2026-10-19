/**
 * config.js (trial-gpt)
 * Configuration module for Trial GPT Plus automation.
 */

const path = require('path');
const { loadRuntimeConfig } = require('../runtime-config');

function loadTrialConfig() {
  const baseConfig = loadRuntimeConfig();

  return {
    ...baseConfig,
    sheetId: baseConfig.sheetId || '1nNAzzC34zSvX2S_AJ4jB6njhKnKRWs8KeZ0mJ5oSkTU',
    sourceSheetName: baseConfig.gptSourceSheetName || 'hotmail',
    targetSheetName: baseConfig.gptTargetSheetName || 'trial-gpt',
    startRow: parseInt(process.env.GPT_START_ROW || baseConfig.gptStartRow || 152, 10),
    checkoutUrl: process.env.GPT_CHECKOUT_URL || baseConfig.gptCheckoutUrl || 'https://chatgpt.com/#pricing',
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || baseConfig.telegramBotToken || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || baseConfig.telegramChatId || '',
    serviceAccountPath: baseConfig.serviceAccountPath
      ? path.resolve(baseConfig.serviceAccountPath)
      : path.join(__dirname, '..', 'service-account.json'),
    gpmApiBase: baseConfig.gpmApiBase || 'http://127.0.0.1:19995',
  };
}

module.exports = {
  loadTrialConfig,
};
