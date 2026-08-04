#!/usr/bin/env node
// Runtime key-pool verification. It reads the running app's redacted health
// snapshot; it never reads .env.local or prints even a prefix of a secret.

async function main() {
  console.log("\n═══════════════════════════════════════");
  console.log("  KEY-POOL VERIFICATION");
  console.log("═══════════════════════════════════════\n");
  
  const baseUrl = process.env.TRION_BENCH_BASE || "http://127.0.0.1:3000";
  const response = await fetch(`${baseUrl}/api/health`);
  if (!response.ok) {
    console.error("\n✗ Trion is not reachable. Start the app, then run this command again.");
    process.exit(1);
  }
  const health = await response.json();
  const rate = health.rate;
  console.log(`Keys loaded at runtime: ${rate.keyCount}`);
  if (!health.modelProviderConfigured || rate.keyCount === 0) {
    console.error("\n✗ No provider credential is active in the running app.");
    process.exit(1);
  }
  
  // 2. Create pool and verify config
  console.log(`\nShared-pool snapshot:`);
  console.log(`  Configured RPM: ${rate.configuredRpm}`);
  console.log(`  Effective RPM: ${rate.effectiveRpm}`);
  console.log(`  Requests in current minute: ${rate.requestsInWindow}`);
  console.log(`  Tokens in current minute: ${rate.tokensInWindow}`);
  console.log(`  Saturation: ${(rate.saturation * 100).toFixed(1)}%`);
  
  for (const k of rate.keys) {
    console.log(`  ${k.id}: rpm=${k.effectiveRpm}/${k.configuredRpm}, cooling=${k.coolingDown}, inFlight=${k.inFlight}`);
  }
  
  console.log("\n═══════════════════════════════════════");
  console.log("  VERIFICATION COMPLETE");
  console.log("═══════════════════════════════════════");
  console.log(`\nStatus: ✓ runtime pool is configured`);
  console.log("Important: keys improve failover only; this free-tier deployment keeps one shared RPM budget.");
}

main().catch((e) => { console.error(e); process.exit(1); });
