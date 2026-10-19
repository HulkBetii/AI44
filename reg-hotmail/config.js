const path = require('path');
const { loadRuntimeConfig } = require('../runtime-config');

const REG_DEFAULTS = {
  fivesimApiKey: '',
  fivesimCountry: 'england',
  fivesimOperator: 'any',
  fivesimService: 'hotmail', // or 'microsoft'
  fivesimMaxPrice: 0.20,
  regSheetId: '',
  regSheetName: 'reg-hotmail',
  regDomain: 'hotmail.com', // 'hotmail.com' | 'outlook.com'
  defaultPasswordLength: 16,
};

function loadRegConfig(options = {}) {
  const baseConfig = loadRuntimeConfig(options);
  const config = {
    ...REG_DEFAULTS,
    ...baseConfig,
  };

  if (process.env.FIVESIM_API_KEY) config.fivesimApiKey = process.env.FIVESIM_API_KEY;
  if (process.env.FIVESIM_COUNTRY) config.fivesimCountry = process.env.FIVESIM_COUNTRY;
  if (process.env.FIVESIM_OPERATOR) config.fivesimOperator = process.env.FIVESIM_OPERATOR;
  if (process.env.FIVESIM_SERVICE) config.fivesimService = process.env.FIVESIM_SERVICE;
  if (process.env.FIVESIM_MAX_PRICE) config.fivesimMaxPrice = parseFloat(process.env.FIVESIM_MAX_PRICE);
  if (process.env.REG_HOTMAIL_SHEET_ID) config.regSheetId = process.env.REG_HOTMAIL_SHEET_ID;
  if (process.env.REG_HOTMAIL_SHEET_NAME) config.regSheetName = process.env.REG_HOTMAIL_SHEET_NAME;

  return config;
}

module.exports = {
  REG_DEFAULTS,
  loadRegConfig,
};
