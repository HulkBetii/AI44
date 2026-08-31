// Multi-provider CAPTCHA solving with smart provider selection.
//
// Provider priority: CapSolver → CapBypass → 2captcha → manual fallback.
// Each provider declares which task types it supports. When a CAPTCHA is detected,
// only providers that support that type are tried.
//
// Supported types:
//   - hCaptcha (HCaptchaTaskProxyLess) — ElevenLabs primary verification
//   - Cloudflare Turnstile (AntiTurnstileTaskProxyLess)
//   - reCAPTCHA v2 / v3 (ReCaptchaV2TaskProxyLess / ReCaptchaV3TaskProxyLess)
//   - Arkose Labs / FunCaptcha (FunCaptchaTaskProxyLess)

const { loadRuntimeConfig } = require('./runtime-config');
const { collectSecretValues, redactSecrets } = require('./secret-sanitizer');

const PROVIDERS = [
  {
    name: 'nonecap',
    apiBase: 'https://api.nonecap.com',
    keyField: 'nonecapApiKey',
    dialect: 'nonecap',
    supportedTypes: [
      'AntiTurnstileTaskProxyLess',
      'ReCaptchaV2TaskProxyLess',
      'ReCaptchaV3TaskProxyLess',
      'HCaptchaTaskProxyLess',
      'FunCaptchaTaskProxyLess',
    ],
  },
  {
    name: 'capbypass',
    apiBase: 'https://api.capbypass.pro',
    keyField: 'capbypassApiKey',
    supportedTypes: [
      'ReCaptchaV2TaskProxyLess',
      'ReCaptchaV3TaskProxyLess',
    ],
  },
  {
    name: 'capsolver',
    apiBase: 'https://api.capsolver.com',
    keyField: 'capsolverApiKey',
    supportedTypes: [
      'AntiTurnstileTaskProxyLess',
      'ReCaptchaV2TaskProxyLess',
      'ReCaptchaV3TaskProxyLess',
      'HCaptchaTaskProxyLess',
      'HCaptchaTask',
      'HCaptchaEnterpriseTask',
    ],
  },
  {
    name: '2captcha',
    apiBase: 'https://api.2captcha.com',
    keyField: 'twoCaptchaApiKey',
    supportedTypes: [
      'AntiTurnstileTaskProxyLess',
      'ReCaptchaV2TaskProxyLess',
      'ReCaptchaV3TaskProxyLess',
      'FunCaptchaTaskProxyLess',
      'HCaptchaTaskProxyLess',
      'HCaptchaTask',
      'HCaptchaEnterpriseTask',
    ],
  },
];

const POLL_INTERVAL_MS = 3000;
const MAX_POLLS = 60; // 3s × 60 = 3 min max wait
const CREATE_TASK_TIMEOUT_MS = 15000;
const POLL_TIMEOUT_MS = 10000;
const SOLVER_DEADLINE_MS = 180000;

let _configCache = null;
let _configLoadedAt = 0;
const CONFIG_CACHE_TTL_MS = 30000;

function loadConfig() {
  const now = Date.now();
  if (_configCache && now - _configLoadedAt < CONFIG_CACHE_TTL_MS) return _configCache;
  const result = loadRuntimeConfig();
  _configCache = result;
  _configLoadedAt = now;
  return result;
}

// Detects which CAPTCHA is present on the page and extracts parameters.
// Returns null if no CAPTCHA widget is found.
async function detectCaptcha(page) {
  return page.evaluate(() => {
    // 1. hCaptcha — ElevenLabs primary verification widget
    const hcaptchaIframe = document.querySelector('iframe[src*="hcaptcha.com"], iframe[title*="hCaptcha" i]');
    const hcaptchaScript = document.querySelector('script[src*="hcaptcha.com"]');
    const hcaptchaDiv = document.querySelector('.h-captcha[data-sitekey], [data-hcaptcha-sitekey]');
    const hcaptchaTextarea = document.querySelector('textarea[name="h-captcha-response"]');
    if (hcaptchaIframe || hcaptchaDiv || hcaptchaScript || hcaptchaTextarea || typeof window.hcaptcha !== 'undefined') {
      // Extract sitekey from multiple sources (ElevenLabs uses programmatic HiddenHCaptcha — no data-sitekey in DOM)
      let sitekey = hcaptchaDiv?.getAttribute('data-sitekey')
        || hcaptchaDiv?.getAttribute('data-hcaptcha-sitekey')
        || '';

      // Extract from hcaptcha iframe src (query string OR hash fragment: #sitekey=xxx&...)
      if (!sitekey) {
        const allIframes = document.querySelectorAll('iframe[src*="hcaptcha.com"]');
        for (const iframe of allIframes) {
          const m = iframe.src.match(/[?&#]sitekey=([^&#]+)/);
          if (m) { sitekey = m[1]; break; }
        }
      }

      // Extract from hcaptcha JS API internal state (_hcaptcha config)
      let rqdata = '';
      if (typeof window.__intercepted_rqdata === 'string') {
        rqdata = window.__intercepted_rqdata;
      }
      if (typeof window.hcaptcha !== 'undefined') {
        try {
          const hc = window.hcaptcha;
          if (hc._hcaptcha) {
            const configs = hc._hcaptcha;
            for (const key of Object.keys(configs)) {
              const cfg = configs[key];
              if (!sitekey) {
                if (cfg?.sitekey) { sitekey = cfg.sitekey; }
                else if (cfg?.config?.sitekey) { sitekey = cfg.config.sitekey; }
              }
              if (!rqdata) {
                if (cfg?.req) { rqdata = cfg.req; }
                else if (cfg?.config?.req) { rqdata = cfg.config.req; }
                else if (cfg?.rqdata) { rqdata = cfg.rqdata; }
              }
              if (sitekey && rqdata) break;
            }
          }
        } catch {}
      }

      // Extract from any element with data-sitekey attribute on the page
      if (!sitekey) {
        const anySitekey = document.querySelector('[data-sitekey]');
        if (anySitekey) sitekey = anySitekey.getAttribute('data-sitekey') || '';
      }

      // Extract from hcaptcha containers that may have been rendered programmatically
      if (!sitekey || !rqdata) {
        const containers = document.querySelectorAll('[data-hcaptcha-widget-id], .h-captcha, div[id^="hcaptcha"]');
        for (const el of containers) {
          if (!sitekey) {
            sitekey = el.getAttribute('data-sitekey') || '';
          }
          const childIframe = el.querySelector('iframe[src*="hcaptcha"]');
          if (childIframe) {
            if (!sitekey) {
              const m = childIframe.src.match(/[?&#]sitekey=([^&#]+)/);
              if (m) sitekey = m[1];
            }
            if (!rqdata) {
              const r = childIframe.src.match(/[?&#]req=([^&#]+)/) || childIframe.src.match(/[?&#]rqdata=([^&#]+)/);
              if (r) rqdata = decodeURIComponent(r[1]);
            }
          }
          if (sitekey && rqdata) break;
        }
      }

      // Also check all iframes on page as a last resort for rqdata
      if (!rqdata) {
        const allIframes = document.querySelectorAll('iframe[src*="hcaptcha.com"]');
        for (const iframe of allIframes) {
          const r = iframe.src.match(/[?&#]req=([^&#]+)/) || iframe.src.match(/[?&#]rqdata=([^&#]+)/);
          if (r) {
            rqdata = decodeURIComponent(r[1]);
            break;
          }
        }
      }

      const isInvisible = hcaptchaDiv?.getAttribute('data-size') === 'invisible'
        || hcaptchaDiv?.getAttribute('data-theme') === 'invisible';
      return { type: 'HCaptchaTaskProxyLess', provider: 'hcaptcha', sitekey, rqdata, isInvisible, url: location.href };
    }

    // 2. Cloudflare Turnstile
    const turnstileIframe = document.querySelector('iframe[src*="challenges.cloudflare.com"]');
    const turnstileDiv = document.querySelector('.cf-turnstile[data-sitekey], [data-turnstile-sitekey]');
    if (turnstileIframe || turnstileDiv) {
      const sitekey = turnstileDiv?.getAttribute('data-sitekey')
        || turnstileDiv?.getAttribute('data-turnstile-sitekey')
        || (turnstileIframe?.src?.match(/sitekey=([^&]+)/)?.[1])
        || '';
      return { type: 'AntiTurnstileTaskProxyLess', provider: 'turnstile', sitekey, url: location.href };
    }

    // 3. reCAPTCHA v2
    const recaptchaDiv = document.querySelector('.g-recaptcha[data-sitekey]');
    const recaptchaIframe = document.querySelector('iframe[src*="recaptcha/api2"]');
    if (recaptchaDiv || recaptchaIframe) {
      const sitekey = recaptchaDiv?.getAttribute('data-sitekey')
        || (recaptchaIframe?.src?.match(/k=([^&]+)/)?.[1])
        || '';
      return { type: 'ReCaptchaV2TaskProxyLess', provider: 'recaptcha_v2', sitekey, url: location.href };
    }

    // 4. reCAPTCHA v3 (script-loaded, invisible)
    const recaptchaV3Script = document.querySelector('script[src*="recaptcha/api.js?render="]');
    if (recaptchaV3Script) {
      const sitekey = recaptchaV3Script.src.match(/render=([^&]+)/)?.[1] || '';
      return { type: 'ReCaptchaV3TaskProxyLess', provider: 'recaptcha_v3', sitekey, url: location.href };
    }

    // 5. Arkose Labs / FunCaptcha
    const arkoseIframe = document.querySelector('iframe[src*="arkoselabs.com"], iframe[src*="arkose"], iframe[data-e2e="enforcement-frame"]');
    const arkoseDiv = document.querySelector('#FunCaptcha, [data-callback][data-pkey], [data-pkey], [data-arkose]');
    if (arkoseIframe || arkoseDiv) {
      const pkey = arkoseDiv?.getAttribute('data-pkey')
        || (arkoseIframe?.src?.match(/(?:pk|public_key)=([^&]+)/)?.[1])
        || '';
      const surl = arkoseIframe?.src?.match(/surl=([^&]+)/)?.[1] || '';
      return { type: 'FunCaptchaTaskProxyLess', provider: 'arkose', sitekey: pkey, surl, url: location.href };
    }

    return null;
  });
}

function remainingTime(deadline) {
  return Math.max(0, deadline - Date.now());
}

async function waitWithinDeadline(delayMs, deadline) {
  const remaining = remainingTime(deadline);
  if (remaining <= 0) throw new Error('CAPTCHA solver deadline exceeded');
  await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, remaining)));
}

async function fetchJson(url, options = {}, timeoutMs = POLL_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function apiPost(apiBase, endpoint, body, timeoutLimit = Infinity) {
  const secrets = collectSecretValues({
    extra: [
      body?.clientKey,
      body?.task?.proxy,
      body?.task?.proxyPassword,
      body?.task?.proxypassword,
      body?.task?.websiteURL,
      body?.task?.websiteKey,
      body?.task?.websitePublicKey,
      body?.task?.enterprisePayload?.rqdata,
    ],
  });
  const url = `${apiBase}${endpoint}`;
  const defaultTimeout = endpoint === '/createTask' ? CREATE_TASK_TIMEOUT_MS : POLL_TIMEOUT_MS;
  const timeoutMs = Math.min(defaultTimeout, timeoutLimit);
  if (timeoutMs <= 0) throw new Error('CAPTCHA solver deadline exceeded');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await res.json();
    if (data.errorId === 1 || (data.errorId > 0 && data.errorCode)) {
      const description = redactSecrets(data.errorDescription, secrets);
      const err = new Error(`${endpoint}: ${data.errorCode} — ${description}`);
      err.code = data.errorCode;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function buildTask(providerName, captchaInfo, proxyString) {
  switch (captchaInfo.type) {
    case 'HCaptchaTaskProxyLess': {
      let taskType = 'HCaptchaTaskProxyLess';
      if (proxyString) {
        if (providerName === 'capsolver') {
          taskType = 'HCaptchaTask'; // CapSolver auto-detects or doesn't support Enterprise task name
        } else if (providerName === '2captcha') {
          taskType = 'HCaptchaTask';
        }
      } else {
        if (providerName === '2captcha') {
          taskType = 'HCaptchaTaskProxyless'; // 2captcha expects lowercase l
        }
      }

      const task = {
        type: taskType,
        websiteURL: captchaInfo.url,
        websiteKey: captchaInfo.sitekey,
        isInvisible: captchaInfo.isInvisible || false,
        enterprise: 1, // Required for 2captcha enterprise
      };

      if (captchaInfo.rqdata) {
        task.enterprisePayload = { rqdata: captchaInfo.rqdata };
      }

      if (proxyString && (taskType === 'HCaptchaTask' || taskType === 'HCaptchaEnterpriseTask')) {
        const parts = proxyString.split(':');
        if (parts.length >= 2) {
          if (providerName === 'capsolver') {
            task.proxy = `http:${proxyString}`;
          } else {
            task.proxyType = 'http';
            task.proxytype = 'http';
            task.proxyAddress = parts[0];
            task.proxyaddress = parts[0];
            task.proxyPort = parseInt(parts[1], 10);
            task.proxyport = parseInt(parts[1], 10);
            if (parts.length >= 4) {
              task.proxyLogin = parts[2];
              task.proxylogin = parts[2];
              task.proxyPassword = parts[3];
              task.proxypassword = parts[3];
            }
          }
        }
      }
      return task;
    }
    case 'AntiTurnstileTaskProxyLess':
    case 'ReCaptchaV2TaskProxyLess':
      return {
        type: captchaInfo.type,
        websiteURL: captchaInfo.url,
        websiteKey: captchaInfo.sitekey,
      };
    case 'ReCaptchaV3TaskProxyLess':
      return {
        type: captchaInfo.type,
        websiteURL: captchaInfo.url,
        websiteKey: captchaInfo.sitekey,
        pageAction: 'signup',
      };
    case 'FunCaptchaTaskProxyLess': {
      const task = {
        type: captchaInfo.type,
        websiteURL: captchaInfo.url,
        websitePublicKey: captchaInfo.sitekey,
      };
      if (captchaInfo.surl) task.funcaptchaApiJSSubdomain = decodeURIComponent(captchaInfo.surl);
      return task;
    }
    default:
      return null;
  }
}

async function solveWithProvider(page, provider, captchaInfo, tag, proxyString, deadline) {
  const config = loadConfig();
  const clientKey = config[provider.keyField];
  if (!clientKey) {
    return { solved: false, reason: `Missing ${provider.keyField} in config` };
  }
  const { apiBase } = provider;
  const secrets = collectSecretValues({
    runtimeConfig: config,
    extra: [
      clientKey,
      proxyString,
      captchaInfo.url,
      captchaInfo.sitekey,
      captchaInfo.rqdata,
    ],
  });
  const safe = (value) => redactSecrets(value, secrets);

  let resolvedProxyString = proxyString;
  if (proxyString && provider.name === '2captcha') {
    const parts = proxyString.split(':');
    if (parts.length >= 2 && !/^[\d\.]+$/.test(parts[0])) {
      try {
        const dns = require('dns');
        const ip = (await dns.promises.lookup(parts[0])).address;
        parts[0] = ip;
        resolvedProxyString = parts.join(':');
      } catch (e) {
        console.warn(`[captcha] Failed to resolve proxy domain ${parts[0]} to IP: ${safe(e.message)}`);
      }
    }
  }

  const task = buildTask(provider.name, captchaInfo, resolvedProxyString);
  if (!task) {
    return { solved: false, reason: `Cannot build task for type ${captchaInfo.type}` };
  }

  // --- NoneCap API Dialect ---
  if (provider.dialect === 'nonecap') {
    try {
      const balData = await fetchJson(
        `${apiBase}/v1/me`,
        { headers: { Authorization: `Bearer ${clientKey}` } },
        Math.min(POLL_TIMEOUT_MS, remainingTime(deadline)),
      );
      console.log(`${tag} Balance/Credits: ${balData.credits || balData.balance || 'unknown'}`);
    } catch (error) {
      console.warn(`${tag} Balance check failed: ${safe(error.message)}`);
    }

    try {
      console.log(`${tag} Creating ${captchaInfo.type} task...`);
      const data = await fetchJson(`${apiBase}/v1/solves?wait=30`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${clientKey}` },
        body: JSON.stringify({
          type: captchaInfo.type === 'HCaptchaTaskProxyLess' ? 'hcaptcha' : captchaInfo.type,
          sitekey: captchaInfo.sitekey,
          url: captchaInfo.url,
        }),
      }, Math.min(35000, remainingTime(deadline)));

      if (data.status === 'solved' && data.token) {
        await injectToken(page, captchaInfo, data.token);
        return { solved: true, token: data.token, provider: captchaInfo.provider, solver: provider.name };
      }

      if (data.status === 'pending' && data.id) {
        console.log(`${tag} Polling task ${data.id}...`);
        for (let i = 0; i < MAX_POLLS && remainingTime(deadline) > 0; i++) {
          const pollData = await fetchJson(`${apiBase}/v1/solves/${data.id}?wait=10`, {
            headers: { Authorization: `Bearer ${clientKey}` },
          }, Math.min(POLL_TIMEOUT_MS + 1000, remainingTime(deadline)));
          if (pollData.status === 'solved' && pollData.token) {
            console.log(`${tag} Solved in poll loop`);
            await injectToken(page, captchaInfo, pollData.token);
            return { solved: true, token: pollData.token, provider: captchaInfo.provider, solver: provider.name };
          }
          if (pollData.status === 'failed' || pollData.error) {
            return { solved: false, reason: `${provider.name} task failed: ${safe(pollData.error || pollData.status)}` };
          }
        }
        return { solved: false, reason: `${provider.name} timed out polling` };
      }

      const reason = data.error?.message || data.message || data.status || 'unknown provider error';
      return { solved: false, reason: `${provider.name} error: ${safe(reason)}` };
    } catch (err) {
      return { solved: false, reason: `${provider.name} request failed: ${safe(err.message)}` };
    }
  }
  // --- End NoneCap Dialect ---


  // Check balance
  try {
    const balanceRes = await apiPost(
      apiBase,
      '/getBalance',
      { clientKey },
      remainingTime(deadline),
    );
    const balance = balanceRes.balance;
    console.log(`${tag} Balance: $${balance}`);
    if (balance <= 0) {
      return { solved: false, reason: `${provider.name} balance is zero` };
    }
  } catch (err) {
    return { solved: false, reason: `${provider.name} balance check failed: ${safe(err.message)}` };
  }

  // Create task (with 1 retry for transient network errors)
  let taskId;
  const MAX_CREATE_RETRIES = 1;
  for (let attempt = 0; attempt <= MAX_CREATE_RETRIES; attempt++) {
    try {
      console.log(`${tag} Creating ${task.type} task...`);
      const createRes = await apiPost(
        apiBase,
        '/createTask',
        { clientKey, task },
        remainingTime(deadline),
      );

      // Synchronous result (some providers return immediately)
      if (createRes.status === 'ready' && createRes.solution) {
        const token = extractToken(createRes.solution);
        if (token) {
          await injectToken(page, captchaInfo, token);
          return { solved: true, token, provider: captchaInfo.provider, solver: provider.name };
        }
      }

      taskId = createRes.taskId;
      if (!taskId) {
        return { solved: false, reason: `${provider.name} createTask returned no taskId` };
      }
      break; // success — exit retry loop
    } catch (err) {
      const isTransient = err.name === 'AbortError' || err.name === 'TypeError';
      if (isTransient && attempt < MAX_CREATE_RETRIES) {
        console.warn(`${tag} createTask transient error, retrying... (${safe(err.message)})`);
        await waitWithinDeadline(2000, deadline);
        continue;
      }
      return { solved: false, reason: `${provider.name} createTask failed: ${safe(err.message)}` };
    }
  }

  // Poll for result
  console.log(`${tag} Polling task ${taskId}...`);
  for (let i = 0; i < MAX_POLLS && remainingTime(deadline) > 0; i++) {
    await waitWithinDeadline(POLL_INTERVAL_MS, deadline);

    try {
      const result = await apiPost(
        apiBase,
        '/getTaskResult',
        { clientKey, taskId },
        remainingTime(deadline),
      );

      if (result.status === 'ready') {
        const token = extractToken(result.solution);
        if (!token) {
          return { solved: false, reason: `${provider.name}: solution returned but no token found` };
        }
        console.log(`${tag} Solved in ${(i + 1) * POLL_INTERVAL_MS / 1000}s`);
        await injectToken(page, captchaInfo, token);
        return { solved: true, token, provider: captchaInfo.provider, solver: provider.name };
      }

      if (result.status === 'failed') {
        return { solved: false, reason: `${provider.name} task failed: ${safe(result.errorDescription || 'unknown')}` };
      }
    } catch (err) {
      console.warn(`${tag} Poll error (attempt ${i + 1}): ${safe(err.message)}`);
    }
  }

  return { solved: false, reason: `${provider.name} timed out after ${MAX_POLLS * POLL_INTERVAL_MS / 1000}s` };
}

// Main entry point. Tries each compatible provider in order until one succeeds.
async function solveCaptcha(page, proxyString = '') {
  const config = loadConfig();
  const deadline = Date.now() + SOLVER_DEADLINE_MS;

  // Collect providers that have an API key configured
  const configured = PROVIDERS
    .map((p) => ({ ...p, clientKey: config[p.keyField] }))
    .filter((p) => p.clientKey);

  if (configured.length === 0) {
    return { solved: false, reason: 'No CAPTCHA solver API keys configured' };
  }

  // Poll for CAPTCHA widget dynamically for up to 6 seconds after submission
  let captchaInfo = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (!page.url().includes('sign-up')) {
      return { solved: true, reason: 'Page already navigated away from signup' };
    }
    captchaInfo = await detectCaptcha(page);
    if (captchaInfo) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (!captchaInfo) {
    return { solved: false, reason: 'No CAPTCHA widget detected on page after wait' };
  }

  console.log(`[captcha] Detected: ${captchaInfo.provider} (${captchaInfo.type}), sitekey: ${captchaInfo.sitekey ? 'present' : 'missing'}`);
  if (captchaInfo.rqdata) {
    console.log('[captcha] Found rqdata payload.');
  }

  // Dump DOM context when sitekey is empty to diagnose extraction failure
  if (!captchaInfo.sitekey) {
    const domDump = await page.evaluate(() => {
      const safeLocation = (raw) => {
        try {
          const url = new URL(raw, location.href);
          return `${url.origin}${url.pathname}`;
        } catch {
          return '[invalid URL]';
        }
      };
      const iframes = [...document.querySelectorAll('iframe')].map((f) => ({
        location: safeLocation(f.src),
        title: f.title,
        id: f.id,
      }));
      const scripts = [...document.querySelectorAll('script[src*="hcaptcha"]')]
        .map((script) => safeLocation(script.src));
      return {
        iframes,
        scripts,
        sitekeyElementCount: document.querySelectorAll('[data-sitekey]').length,
        containerCount: document.querySelectorAll(
          '.h-captcha, [data-hcaptcha-widget-id], [data-hcaptcha-sitekey], textarea[name="h-captcha-response"]',
        ).length,
      };
    }).catch(() => ({}));
    console.log('[captcha] DOM dump:', JSON.stringify(domDump, null, 2));
  }

  // Retry detection if sitekey empty (iframe may still be loading)
  if (!captchaInfo.sitekey) {
    console.log('[captcha] Sitekey empty on first detect, retrying...');
    for (let retry = 0; retry < 3; retry++) {
      await page.waitForTimeout(2000);
      let newInfo = await detectCaptcha(page);
      if (newInfo?.sitekey) {
        captchaInfo = newInfo;
        console.log(`[captcha] Sitekey found on retry ${retry + 1}.`);
        break;
      }
    }
  }

  if (!captchaInfo?.sitekey) {
    // Debug: log what DOM elements were found to aid troubleshooting
    const debugInfo = await page.evaluate(() => {
      const iframeLocations = [...document.querySelectorAll('iframe')].slice(0, 5).map((frame) => {
        try {
          const url = new URL(frame.src, location.href);
          return `${url.origin}${url.pathname}`;
        } catch {
          return '[invalid URL]';
        }
      });
      return { iframeLocations, sitekeyElementCount: document.querySelectorAll('[data-sitekey]').length };
    }).catch(() => ({}));
    console.log('[captcha] Debug — iframe locations:', JSON.stringify(debugInfo.iframeLocations));
    console.log('[captcha] Debug — data-sitekey element count:', debugInfo.sitekeyElementCount || 0);
    return { solved: false, reason: `Could not extract sitekey for ${captchaInfo?.provider || 'unknown'}` };
  }

  // Filter to only providers that support the detected CAPTCHA type
  let compatible = [];
  if (captchaInfo.type === 'HCaptchaTaskProxyLess' && proxyString) {
    const tier1 = configured.filter(p => p.supportedTypes.includes('HCaptchaEnterpriseTask') || p.supportedTypes.includes('HCaptchaTask'));
    const tier2 = configured.filter(p => !tier1.includes(p) && p.supportedTypes.includes('HCaptchaTaskProxyLess'));
    compatible = [...tier1, ...tier2]; // try proxy-supported first, fallback to proxyless
  } else {
    compatible = configured.filter((p) => p.supportedTypes.includes(captchaInfo.type));
  }

  if (compatible.length === 0) {
    return { solved: false, reason: `No configured provider supports ${captchaInfo.provider} (${captchaInfo.type})` };
  }

  console.log(`[captcha] Compatible providers: ${compatible.map((p) => p.name).join(', ')}`);

  // Try each compatible provider in priority order
  for (const p of compatible) {
    console.log(`[captcha] Trying ${p.name}...`);
    if (remainingTime(deadline) <= 0) {
      return { solved: false, reason: `CAPTCHA solver deadline exceeded after ${SOLVER_DEADLINE_MS / 1000}s` };
    }
    const result = await solveWithProvider(
      page,
      p,
      captchaInfo,
      `[${p.name}]`,
      proxyString,
      deadline,
    );
    if (result.solved) return result;
    console.log(`[captcha] ${p.name} failed: ${result.reason}`);
  }

  return { solved: false, reason: `All ${compatible.length} compatible providers failed` };
}

function extractToken(solution) {
  if (!solution) return null;
  return solution.token
    || solution.gRecaptchaResponse
    || solution.captcha_response
    || solution.text
    || null;
}

async function injectToken(page, captchaInfo, token) {
  if (captchaInfo.provider === 'hcaptcha') {
    await page.evaluate((tkn) => {
      // 1. Fill all h-captcha-response textareas
      const textareas = document.querySelectorAll('textarea[name="h-captcha-response"], textarea[name="g-recaptcha-response"], [name="h-captcha-response"], [name="g-recaptcha-response"]');
      textareas.forEach((ta) => {
        try {
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
          nativeInputValueSetter.call(ta, tkn);
        } catch {
          ta.value = tkn;
        }
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new Event('change', { bubbles: true }));
      });

      // 2. Use hcaptcha SDK setResponse if available
      if (typeof window.hcaptcha !== 'undefined') {
        try {
          // Get all widget IDs
          const widgetIds = [];
          const containers = document.querySelectorAll('[data-hcaptcha-widget-id]');
          containers.forEach((el) => {
            const wid = el.getAttribute('data-hcaptcha-widget-id');
            if (wid) widgetIds.push(wid);
          });
          // Fallback: get from hcaptcha internal state
          if (widgetIds.length === 0 && window.hcaptcha._hcaptcha) {
            const ids = Object.keys(window.hcaptcha._hcaptcha);
            ids.forEach((id) => { if (/^\d+$/.test(id)) widgetIds.push(id); });
          }
          // Set response for each widget
          for (const wid of widgetIds) {
            try { window.hcaptcha.setResponse(wid, tkn); } catch {}
          }
        } catch {}

        // 3. Walk React fiber tree to find onVerify callback from HiddenHCaptcha
        try {
          const hcaptchaContainers = document.querySelectorAll('.h-captcha, [data-hcaptcha-widget-id], div[id^="hcaptcha"]');
          for (const container of hcaptchaContainers) {
            // Walk up to find React internal instance
            const fiberKey = Object.keys(container).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
            if (!fiberKey) continue;
            let fiber = container[fiberKey];
            // Walk up the fiber tree looking for onVerify prop
            for (let i = 0; i < 20 && fiber; i++) {
              const props = fiber.memoizedProps || fiber.pendingProps;
              if (props?.onVerify && typeof props.onVerify === 'function') {
                props.onVerify(tkn);
                break;
              }
              fiber = fiber.return;
            }
          }
        } catch {}

        // 3.5. Emulate iframe postMessage (mimics human solve for hCaptcha SDK)
        try {
          const iframes = document.querySelectorAll('iframe[src*="hcaptcha.com"]');
          for (const wid of widgetIds) {
            const data = JSON.stringify({
              source: 'hcaptcha',
              label: 'challenge-closed',
              id: wid,
              contents: {
                event: 'challenge-passed',
                response: tkn,
                expiration: 120
              }
            });
            const event = new MessageEvent('message', {
              data: data,
              origin: 'https://newassets.hcaptcha.com',
              source: iframes[0]?.contentWindow || window
            });
            window.dispatchEvent(event);
          }
        } catch {}

        // 4. Fallback: try hcaptcha internal client callbacks
        try {
          const clients = window.hcaptcha._hcaptcha?.cfg?.clients;
          if (clients) {
            for (const wid of Object.keys(clients)) {
              const cb = clients[wid]?.callback;
              if (typeof cb === 'function') cb(tkn);
              else if (typeof cb === 'string' && typeof window[cb] === 'function') window[cb](tkn);
            }
          }
        } catch {}
      }

      // 5. Remove hCaptcha challenge overlay so it doesn't block the page
      // DISABLED: If the token is rejected by ElevenLabs, deleting the iframe breaks the UI
      // and prevents the user from manually solving it as a fallback.
      /*
      try {
        const overlays = document.querySelectorAll('div[style*="z-index"][style*="position"]');
        overlays.forEach((el) => {
          if (el.querySelector('iframe[src*="hcaptcha.com"]')) {
            el.remove();
          }
        });
        document.querySelectorAll('iframe[src*="hcaptcha.com/captcha"]').forEach((iframe) => {
          const parent = iframe.closest('div[style*="position"]') || iframe.parentElement;
          if (parent && parent !== document.body) parent.remove();
          else iframe.remove();
        });
      } catch {}
      */
    }, token);
  } else if (captchaInfo.provider === 'turnstile') {
    await page.evaluate((tkn) => {
      const input = document.querySelector('[name="cf-turnstile-response"]');
      if (input) {
        input.value = tkn;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const widget = document.querySelector('.cf-turnstile[data-sitekey]');
      const cbName = widget?.getAttribute('data-callback');
      if (cbName && typeof window[cbName] === 'function') window[cbName](tkn);
    }, token);
  } else if (captchaInfo.provider === 'recaptcha_v2' || captchaInfo.provider === 'recaptcha_v3') {
    await page.evaluate((tkn) => {
      const textarea = document.querySelector('#g-recaptcha-response, [name="g-recaptcha-response"]');
      if (textarea) {
        textarea.style.display = 'block';
        textarea.value = tkn;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (typeof window.___grecaptcha_cfg !== 'undefined') {
        const clients = window.___grecaptcha_cfg?.clients;
        if (clients) {
          const findCallback = (obj, depth = 0) => {
            if (depth > 4 || !obj || typeof obj !== 'object') return null;
            if (typeof obj.callback === 'function') return obj.callback;
            for (const v of Object.values(obj)) {
              const found = findCallback(v, depth + 1);
              if (found) return found;
            }
            return null;
          };
          for (const c of Object.values(clients)) {
            const cb = findCallback(c);
            if (cb) { cb(tkn); break; }
          }
        }
      }
    }, token);
  } else if (captchaInfo.provider === 'arkose') {
    await page.evaluate((tkn) => {
      const input = document.querySelector('#FunCaptcha-Token, [name="fc-token"], input[name*="funcaptcha"], input[name*="arkose"]');
      if (input) {
        input.value = tkn;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (typeof window.ArkoseEnforcement !== 'undefined') {
        try { window.ArkoseEnforcement.setConfig({ onCompleted: null }); } catch {}
      }
      document.dispatchEvent(new CustomEvent('FunCaptcha.completed', { detail: { token: tkn } }));
    }, token);
  }
}

module.exports = { apiPost, solveCaptcha, detectCaptcha, loadConfig };
