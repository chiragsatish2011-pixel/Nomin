#!/usr/bin/env node
// Online/Production-Condition Runner

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runOnlineEvaluation, analyzeOnlineResults, ONLINE_CONFIG } from "./run.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = process.env.TRION_EVAL_RESULTS_DIR || path.join(HERE, "..", "results");

async function main() {
  const args = process.argv.slice(2);
  const tag = args.find((a) => a.startsWith("--tag="))?.split("=")[1] || "online";
  const concurrent = parseInt(args.find((a) => a.startsWith("--concurrent="))?.split("=")[1] || "5");
  const turns = parseInt(args.find((a) => a.startsWith("--turns="))?.split("=")[1] || "3");
  
  const config = { ...ONLINE_CONFIG, concurrentSessions: concurrent, turnsPerSession: turns };
  
  console.log("\n═══════════════════════════════════════");
  console.log("  ONLINE / PRODUCTION-CONDITION EVALUATION");
  console.log("═══════════════════════════════════════\n");
  
  const { allResults, sessionErrors } = await runOnlineEvaluation(tag, config);
  const analysis = analyzeOnlineResults({ allResults, sessionErrors });
  
  console.log("\n═══════════════════════════════════════");
  console.log("  ONLINE SUMMARY");
  console.log("═══════════════════════════════════════");
  console.log(`  Sessions: ${analysis.totalSessions} (errors: ${analysis.sessionErrors})`);
  console.log(`  Total turns: ${analysis.totalTurns}`);
  console.log(`  Completed: ${analysis.completedTurns} (${(analysis.overallSuccessRate*100).toFixed(1)}%)`);
  console.log(`\n  Speed (plan mode):`);
  console.log(`    Turns: ${analysis.byMode.speed.turns}`);
  console.log(`    Completed: ${analysis.byMode.speed.completed} (${(analysis.byMode.speed.successRate*100).toFixed(1)}%)`);
  console.log(`    Avg latency: ${analysis.byMode.speed.avgLatency.toFixed(0)}ms`);
  console.log(`    Avg tokens: ${analysis.byMode.speed.avgTokens.toFixed(0)}`);
  console.log(`\n  Coding (execute mode):`);
  console.log(`    Turns: ${analysis.byMode.coding.turns}`);
  console.log(`    Completed: ${analysis.byMode.coding.completed} (${(analysis.byMode.coding.successRate*100).toFixed(1)}%)`);
  console.log(`    Avg latency: ${analysis.byMode.coding.avgLatency.toFixed(0)}ms`);
  console.log(`    Avg tokens: ${analysis.byMode.coding.avgTokens.toFixed(0)}`);
  console.log(`\n  Totals:`);
  console.log(`    Model calls: ${analysis.totals.modelCalls}`);
  console.log(`    Tokens: ${analysis.totals.totalTokens}`);
  console.log(`    Cost: $${analysis.totals.totalCostUsd.toFixed(6)}`);
  
  const report = {
    tag,
    at: new Date().toISOString(),
    level: "online",
    config,
    rawResults: allResults,
    analysis,
  };
  
  await fs.mkdir(RESULTS, { recursive: true });
  const out = path.join(RESULTS, `online-${tag}-${Date.now()}.json`);
  await fs.writeFile(out, JSON.stringify(report, null, 2), "utf-8");
  console.log(`\nwritten: ${out}`);
  
  // Exit code based on success rate
  const criticalFail = analysis.overallSuccessRate < 0.5 || analysis.sessionErrors > 0;
  process.exit(criticalFail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
