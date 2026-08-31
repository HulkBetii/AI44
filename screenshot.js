const path = require('path');
const { chromium } = require('playwright');

const LOCAL_DEBUG_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const DEFAULT_OUTPUT = path.join(process.cwd(), 'debug-browser.png');

function safePageLocation(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '[unknown page]';
  }
}

function missingTabMessage(hasFilter) {
  return hasFilter ? 'No browser tab matched --url-contains' : 'No browser tab was found';
}

function parseArgs(argv) {
  let debugAddress = null;
  let urlContains = '';
  let debugAddressProvided = false;
  let urlContainsProvided = false;

  for (const arg of argv) {
    if (arg.startsWith('--debug-address=')) {
      if (debugAddressProvided) throw new Error('Duplicate option: --debug-address');
      debugAddressProvided = true;
      debugAddress = arg.slice('--debug-address='.length).trim();
    } else if (arg.startsWith('--url-contains=')) {
      if (urlContainsProvided) throw new Error('Duplicate option: --url-contains');
      urlContainsProvided = true;
      urlContains = arg.slice('--url-contains='.length);
    } else {
      throw new Error(`Unknown option: ${arg.split('=', 1)[0]}`);
    }
  }

  if (!debugAddress) {
    throw new Error('Missing --debug-address=host:port');
  }

  const endpoint = new URL(`http://${debugAddress}`);
  if (!LOCAL_DEBUG_HOSTS.has(endpoint.hostname)
    || !endpoint.port
    || endpoint.username
    || endpoint.password
    || endpoint.pathname !== '/'
    || endpoint.search
    || endpoint.hash) {
    throw new Error('--debug-address must be a localhost host:port value');
  }

  const port = Number(endpoint.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('--debug-address must use a valid port');
  }

  return { endpoint: endpoint.origin, urlContains };
}

async function captureScreenshot(options) {
  const browser = await chromium.connectOverCDP(options.endpoint);
  try {
    const pages = browser.contexts().flatMap((context) => context.pages());
    const page = pages.find((candidate) => candidate.url().includes(options.urlContains));
    if (!page) {
      throw new Error(missingTabMessage(Boolean(options.urlContains)));
    }

    await page.screenshot({ path: DEFAULT_OUTPUT, fullPage: true });
    return { output: DEFAULT_OUTPUT, url: safePageLocation(page.url()) };
  } finally {
    await browser.close();
  }
}

async function main(argv = process.argv.slice(2)) {
  const result = await captureScreenshot(parseArgs(argv));
  console.log(`Saved ${result.output} from ${result.url}`);
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (error) => {
      console.error(error.message);
      process.exit(1);
    },
  );
}

module.exports = { captureScreenshot, missingTabMessage, parseArgs, safePageLocation };
