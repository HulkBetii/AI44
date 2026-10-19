/**
 * test-proxyxoay.js
 * Verification script for ProxyXoay integration.
 * Tests:
 * 1. Initial proxy acquisition + metadata parsing (ISP, Location, Lifetime).
 * 2. TCP socket latency & connectivity check.
 * 3. Automatic cooldown countdown handling (60s timer).
 */

const { getNewProxyXoayWithRetry, rotateProxyWithCooldown, checkProxyTcp } = require('./proxyxoay-client');
const { loadLocalConfig } = require('./runtime-config');

async function main() {
  console.log('============================================================');
  console.log('🌐 TESTING PROXYXOAY (proxyxoay.shop / topproxy.vn)');
  console.log('============================================================\n');

  const config = loadLocalConfig();
  const key = config.proxyXoayKey;

  if (!key) {
    console.error('❌ Error: proxyXoayKey is missing in config.local.json');
    process.exit(1);
  }

  console.log(`[Test 1] Acquiring initial rotating proxy...`);
  const t0 = Date.now();
  const proxyInfo = await getNewProxyXoayWithRetry(key);
  const latencyMs = Date.now() - t0;

  console.log('\n--- PROXY DETAILS ---');
  console.log(`• HTTP Proxy:     ${proxyInfo.proxy}`);
  console.log(`• SOCKS5 Proxy:   ${proxyInfo.proxysocks5}`);
  console.log(`• Public IP:      ${proxyInfo.publicIp}`);
  console.log(`• ISP (Nhà Mạng): ${proxyInfo.isp.toUpperCase()}`);
  console.log(`• Location:       ${proxyInfo.location}`);
  console.log(`• Lifetime:       ${proxyInfo.remainingLifetimeSec}s (~${Math.round(proxyInfo.remainingLifetimeSec / 60)} mins)`);
  console.log(`• Key Expiration: ${proxyInfo.tokenExpires}`);
  console.log(`• API Latency:    ${latencyMs}ms`);
  console.log('---------------------\n');

  console.log('[Test 2] Checking TCP connection to proxy port...');
  const tcpOk = await checkProxyTcp(proxyInfo.host, proxyInfo.port, 4000);
  console.log(`• TCP Port Health: ${tcpOk ? '✅ CONNECTED OK' : '❌ FAILED'}`);

  if (!tcpOk) {
    throw new Error('TCP health check failed');
  }

  console.log('\n[Test 3] Testing Cooldown Management (requesting immediate rotation)...');
  console.log('Expectation: Client will catch cooldown countdown, wait safely, and fetch new IP.');
  const t1 = Date.now();
  const proxyInfo2 = await rotateProxyWithCooldown(key);
  const rotationDurationSec = Math.round((Date.now() - t1) / 1000);

  console.log('\n--- ROTATED PROXY DETAILS ---');
  console.log(`• New HTTP Proxy: ${proxyInfo2.proxy}`);
  console.log(`• New Public IP:  ${proxyInfo2.publicIp}`);
  console.log(`• ISP:            ${proxyInfo2.isp.toUpperCase()}`);
  console.log(`• Location:       ${proxyInfo2.location}`);
  console.log(`• Total Wait:     ${rotationDurationSec}s`);
  console.log('-----------------------------\n');

  console.log('🎉 ALL PROXYXOAY TESTS PASSED 100%!');
}

main().catch((err) => {
  console.error('\n❌ Test failed:', err.message);
  process.exit(1);
});
