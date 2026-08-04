#!/usr/bin/env node
// Trajectory-Level Runner — executes trajectory assertions on coding suite cases

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTrajectoryAnalysis, TRAJECTORY_ASSERTIONS } from "./assertions.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = process.env.TRION_EVAL_RESULTS_DIR || path.join(HERE, "..", "results");

async function main() {
  const args = process.argv.slice(2);
  const tag = args.find((a) => a.startsWith("--tag="))?.split("=")[1] || "trajectory";
  const cases = args.find((a) => a.startsWith("--cases="))?.split("=")[1]?.split(",") || 
    ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10", "T11"];
  
  console.log("\n═══════════════════════════════════════");
  console.log("  TRAJECTORY-LEVEL ANALYSIS");
  console.log("═══════════════════════════════════════\n");
  
  const results = await runTrajectoryAnalysis(tag, cases);
  
  // Aggregate
  const totalAssertions = results.reduce((sum, r) => sum + r.total, 0);
  const passedAssertions = results.reduce((sum, r) => sum + r.passed, 0);
  const byAssertion = {};
  
  for (const r of results) {
    for (const a of r.assertions) {
      if (!byAssertion[a.assertionId]) byAssertion[a.assertionId] = { name: a.name, passed: 0, total: 0 };
      byAssertion[a.assertionId].total++;
      if (a.passed) byAssertion[a.assertionId].passed++;
    }
  }
  
  console.log("\n═══════════════════════════════════════");
  console.log("  TRAJECTORY SUMMARY");
  console.log("═══════════════════════════════════════");
  console.log(`  Cases analyzed: ${results.length}`);
  console.log(`  Assertions passed: ${passedAssertions}/${totalAssertions} (${Math.round((passedAssertions/totalAssertions)*100)}%)`);
  console.log("\n  Per-assertion:");
  for (const [id, data] of Object.entries(byAssertion)) {
    const pct = Math.round((data.passed / data.total) * 100);
    console.log(`    ${id} (${data.name}): ${data.passed}/${data.total} (${pct}%)`);
  }
  
  const report = {
    tag,
    at: new Date().toISOString(),
    level: "trajectory",
    assertions: TRAJECTORY_ASSERTIONS.map((a) => ({ id: a.id, name: a.name })),
    cases: results,
    summary: {
      casesAnalyzed: results.length,
      totalAssertions,
      passedAssertions,
      overallPassRate: Math.round((passedAssertions / totalAssertions) * 100),
      byAssertion: Object.fromEntries(
        Object.entries(byAssertion).map(([id, d]) => [id, { ...d, passRate: Math.round((d.passed/d.total)*100) }])
      ),
    },
  };
  
  await fs.mkdir(RESULTS, { recursive: true });
  const out = path.join(RESULTS, `trajectory-${tag}-${Date.now()}.json`);
  await fs.writeFile(out, JSON.stringify(report, null, 2), "utf-8");
  console.log(`\nwritten: ${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
