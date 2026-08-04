#!/usr/bin/env node
// Security Evaluation Runner — executes all 5 attack vector probes

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SECURITY_PROBES, runSecurityProbes } from "./probes.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = process.env.TRION_EVAL_RESULTS_DIR || path.join(HERE, "..", "results");

async function main() {
  const args = process.argv.slice(2);
  const tag = args.find((a) => a.startsWith("--tag="))?.split("=")[1] || "security";
  
  console.log("\n═══════════════════════════════════════");
  console.log("  SECURITY EVALUATION — 5 Attack Vectors");
  console.log("═══════════════════════════════════════\n");
  
  const results = await runSecurityProbes(tag);
  
  // Summary
  const criticalFailed = results.filter((r) => !r.passed && SECURITY_PROBES.find((p) => p.id === r.probeId)?.severity === "critical");
  const highFailed = results.filter((r) => !r.passed && SECURITY_PROBES.find((p) => p.id === r.probeId)?.severity === "high");
  
  console.log("\n═══════════════════════════════════════");
  console.log("  SECURITY SUMMARY");
  console.log("═══════════════════════════════════════");
  console.log(`  Total probes: ${results.length}`);
  console.log(`  Passed: ${results.filter((r) => r.passed).length}`);
  console.log(`  Failed: ${results.filter((r) => !r.passed).length}`);
  console.log(`  Critical failures: ${criticalFailed.length}`);
  console.log(`  High failures: ${highFailed.length}`);
  
  if (criticalFailed.length > 0) {
    console.log("\n  ⚠️  CRITICAL SECURITY FINDINGS:");
    for (const f of criticalFailed) {
      console.log(`    - ${f.probeId}/${f.testCaseId}: ${f.name}`);
    }
  }
  
  const report = {
    tag,
    at: new Date().toISOString(),
    level: "security",
    probes: SECURITY_PROBES.map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category,
      severity: p.severity,
      testCases: p.testCases.map((tc) => ({
        id: tc.id,
        name: tc.name,
      })),
    })),
    results,
    summary: {
      total: results.length,
      passed: results.filter((r) => r.passed).length,
      failed: results.filter((r) => !r.passed).length,
      criticalFailed: criticalFailed.length,
      highFailed: highFailed.length,
    },
  };
  
  await fs.mkdir(RESULTS, { recursive: true });
  const out = path.join(RESULTS, `security-${tag}-${Date.now()}.json`);
  await fs.writeFile(out, JSON.stringify(report, null, 2), "utf-8");
  console.log(`\nwritten: ${out}`);
  
  // Exit code: 1 if any critical failure
  process.exit(criticalFailed.length > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
