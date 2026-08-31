// Sanity-checks a proxy token without touching Hotmail, ElevenLabs, or the sheet: rotates a
// fresh proxy, confirms traffic actually exits through it, and checks it can reach every host
// the pipeline depends on. Cheap to run, and it rules out the failures that would otherwise
// only surface several minutes into a real signup.
//
// What this CANNOT tell you: whether ElevenLabs' CAPTCHA will accept the IP. The CAPTCHA is a
// JS widget scoring the client, so reaching the page proves nothing about passing it - only a
// real signup run answers that.
//
//   node check-proxy.js

const { getNewProxyWithRetry, getNewTinProxyWithRetry, parseProxyString, fetchViaProxy } = require('./proxy');
const { withAutomationLock } = require('./automation-lock');
const { loadRuntimeConfig, resolveProxyConfig } = require('./runtime-config');

function resolveConfig() {
  const { provider, apiKey } = resolveProxyConfig(loadRuntimeConfig(), { required: true });
  return { provider, token: apiKey };
}

const IP_ECHO_URL = 'https://api.ipify.org/?format=text';

// Every host a signup run actually depends on. A proxy that reaches one of these but not the
// others still fails the pipeline, several minutes in.
const REQUIRED_HOSTS = [
  ['login.live.com', 'https://login.live.com/'],
  ['outlook.live.com', 'https://outlook.live.com/mail/'],
  ['elevenlabs.io', 'https://elevenlabs.io/app/sign-up'],
];

async function main() {
  const { provider, token } = resolveConfig();

  console.log('[1/4] Checking this machine\'s own IP (no proxy)...');
  const directResponse = await fetch(IP_ECHO_URL, { signal: AbortSignal.timeout(15000) });
  if (!directResponse.ok) throw new Error(`Direct IP check failed with HTTP ${directResponse.status}`);
  const directIp = (await directResponse.text()).trim();
  console.log(`      Direct IP: ${directIp}`);

  console.log(`[2/4] Requesting a proxy from ${provider}...`);
  const proxyData = provider === 'tinproxy'
    ? await getNewTinProxyWithRetry(token)
    : await getNewProxyWithRetry(token);
  const proxy = parseProxyString(proxyData.proxy);
  console.log(`      Got: ${proxy.server} (${proxyData.country || '?'}, ${proxyData.type || '?'})`);

  console.log('[3/4] Opening a CONNECT tunnel through it to a public IP-echo service...');
  const exitIp = (await fetchViaProxy(IP_ECHO_URL, proxy)).trim();
  console.log(`      Exit IP: ${exitIp}`);

  console.log('[4/4] Checking the hosts the pipeline needs...');
  const reach = [];
  for (const [name, url] of REQUIRED_HOSTS) {
    try {
      const body = await fetchViaProxy(url, proxy, 15000);
      console.log(`      ✅ ${name.padEnd(18)} reachable (${body.length} bytes)`);
      reach.push({ name, ok: true });
    } catch (e) {
      console.log(`      ❌ ${name.padEnd(18)} ${e.message}`);
      reach.push({ name, ok: false, error: e.message });
    }
  }

  console.log('');

  // The routing check is exit-vs-direct. SP07's ip_real field is the proxy's own exit IP,
  // not this machine's - verified by observing ip_real match the tunnel's exit IP while the
  // machine's direct IP was entirely different.
  if (exitIp === directIp) {
    console.log('      ⚠️  Exit IP equals this machine\'s IP - traffic is NOT going through the proxy.');
  } else {
    console.log(`      ✅ Proxy is routing: traffic exits as ${exitIp}, not ${directIp}.`);
  }

  if (proxyData.ip_real && proxyData.ip_real !== exitIp) {
    console.log(`      ℹ️  SP07 reported ip_real=${proxyData.ip_real}, but the tunnel exited as ${exitIp}.`);
    console.log('         Not necessarily wrong (the pool may rotate), just worth noting.');
  }

  if (proxyData.time_seconds_to_die) {
    console.log(`      ℹ️  SP07 says this proxy lives ~${Math.round(proxyData.time_seconds_to_die / 60)} more minutes.`);
  }

  console.log('');
  const unreachable = reach.filter((r) => !r.ok);
  if (unreachable.length) {
    console.log(`      ⛔ ${unreachable.map((r) => r.name).join(', ')} unreachable - this token cannot`);
    console.log('         run the pipeline. A signup would fail partway through.');
    process.exitCode = 1;
  } else {
    console.log('      All required hosts reachable. Whether ElevenLabs\' CAPTCHA accepts this IP');
    console.log('      is a separate question only a real signup run answers:');
    console.log('        node signup-hotmail.js --row=<n>');
  }
}

withAutomationLock('proxy-check-cli', main).catch((err) => {
  console.error('❌ Failed:', err.message);
  process.exitCode = 1;
});
