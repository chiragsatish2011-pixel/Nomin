#!/usr/bin/env node
// Component-Level Runner

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = process.env.TRION_EVAL_RESULTS_DIR || path.join(HERE, "..", "results");

// Source modules are TypeScript, so importing fictional .js siblings from a
// bare Node script was never runnable. Use the project's real Vitest suites:
// they exercise the same isolated classifier, governor, pool, and critic code
// with no provider calls.
const GROUPS = {
  classifier: [
    "lib/agent/__tests__/classifier.test.ts",
    "lib/agent/__tests__/classifier-regression.test.ts",
    "lib/agent/__tests__/classifier-override.test.ts",
  ],
  // The multi-key pool was replaced by a single-credential lane, so
  // key-pool.test.ts no longer exists. Rate pacing is still the thing worth
  // measuring here, and it is now the lane's only throughput control.
  rateLane: ["lib/agent/__tests__/rate-governor.test.ts"],
  critics: ["lib/agent/__tests__/quality-chain.test.ts", "lib/agent/__tests__/coherence.test.ts"],
};

async function runGroup(name, files, tag) {
  const output = path.join(RESULTS, `.component-${tag}-${name}.json`);
  await fs.mkdir(RESULTS, { recursive: true });
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [
      "node_modules/vitest/vitest.mjs", "run", ...files,
      "--reporter=json", `--outputFile=${output}`,
    ], { cwd: path.join(HERE, "..", ".."), stdio: "inherit" });
    child.on("close", (value) => resolve(value ?? 1));
    child.on("error", () => resolve(1));
  });
  const report = await fs.readFile(output, "utf-8").then(JSON.parse).catch(() => ({}));
  return {
    name,
    passed: code === 0,
    total: Number(report.numTotalTests ?? 0),
    failed: Number(report.numFailedTests ?? (code === 0 ? 0 : 1)),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const tag = args.find((a) => a.startsWith("--tag="))?.split("=")[1] || "component";
  
  // Run groups sequentially: each Vitest child bundles the same config and
  // concurrent config-loader writes are unreliable on mounted volumes.
  const results = [];
  for (const [name, files] of Object.entries(GROUPS)) results.push(await runGroup(name, files, tag));
  const passed = results.filter((group) => group.passed).length;
  const total = results.length;
  
  console.log("\n═══════════════════════════════════════");
  console.log("  COMPONENT SUMMARY");
  console.log("═══════════════════════════════════════");
  console.log(`  Total tests: ${total}`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${total - passed}`);
  console.log(`  Pass rate: ${Math.round((passed/total)*100)}%`);
  
  for (const group of results) {
    console.log(`  ${group.name}: ${group.passed ? "PASS" : "FAIL"} (${group.total - group.failed}/${group.total} tests)`);
  }
  
  const report = {
    tag,
    at: new Date().toISOString(),
    level: "component",
    groups: results,
    summary: { total, passed, failed: total - passed, passRate: Math.round((passed/total)*100) },
  };
  
  await fs.mkdir(RESULTS, { recursive: true });
  const out = path.join(RESULTS, `component-${tag}-${Date.now()}.json`);
  await fs.writeFile(out, JSON.stringify(report, null, 2), "utf-8");
  console.log(`\nwritten: ${out}`);
  
  process.exit(passed === total ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
