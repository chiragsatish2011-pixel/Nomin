#!/usr/bin/env node
// Comparison Script — generates before/after tables from two result tags
// Usage: node eval/scripts/compare.mjs baseline after

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(HERE, "..", "results");

async function findResultFile(tag, level) {
  const files = await fs.readdir(RESULTS);
  const matches = files
    .filter((f) => f.startsWith(`${level}-${tag}-`) && f.endsWith(".json"))
    .sort()
    .reverse();
  return matches[0] ? path.join(RESULTS, matches[0]) : null;
}

async function loadReport(file) {
  return JSON.parse(await fs.readFile(file, "utf-8"));
}

function compareUnit(baseline, current) {
  console.log("\n═══════════════════════════════════════");
  console.log("  UNIT LEVEL COMPARISON");
  console.log("═══════════════════════════════════════");
  
  for (const suiteName of ["speed", "coding"]) {
    const b = baseline.suites?.[suiteName]?.summary;
    const c = current.suites?.[suiteName]?.summary;
    if (!b || !c) continue;
    
    console.log(`\n  ${suiteName.toUpperCase()}:`);
    console.log(`    Completed:     ${b.completed}/${b.cases} → ${c.completed}/${c.cases}  (${((c.completed/c.cases)*100).toFixed(1)}%)`);
    console.log(`    Tokens/completed: ${b.tokensPerCompletedTask?.toFixed(0) ?? "n/a"} → ${c.tokensPerCompletedTask?.toFixed(0) ?? "n/a"}  (${c.tokensPerCompletedTask && b.tokensPerCompletedTask ? ((c.tokensPerCompletedTask - b.tokensPerCompletedTask) / b.tokensPerCompletedTask * 100).toFixed(1) + "%" : "n/a"})`);
    console.log(`    Cost/completed: $${b.costPerCompletedTaskUsd?.toFixed(6) ?? "n/a"} → $${c.costPerCompletedTaskUsd?.toFixed(6) ?? "n/a"}`);
    console.log(`    1st-try tool acc: ${b.toolFirstAttemptOk}/${b.toolSteps} (${((b.firstAttemptToolAccuracy??0)*100).toFixed(0)}%) → ${c.toolFirstAttemptOk}/${c.toolSteps} (${((c.firstAttemptToolAccuracy??0)*100).toFixed(0)}%)`);
  }
}

function compareSecurity(baseline, current) {
  console.log("\n═══════════════════════════════════════");
  console.log("  SECURITY COMPARISON");
  console.log("═══════════════════════════════════════");
  
  const b = baseline.summary;
  const c = current.summary;
  if (!b || !c) return;
  
  console.log(`  Total probes: ${b.total} → ${c.total}`);
  console.log(`  Passed: ${b.passed} → ${c.passed}`);
  console.log(`  Failed: ${b.failed} → ${c.failed}`);
  console.log(`  Critical failures: ${b.criticalFailed} → ${c.criticalFailed}`);
  console.log(`  High failures: ${b.highFailed} → ${c.highFailed}`);
}

function compareTrajectory(baseline, current) {
  console.log("\n═══════════════════════════════════════");
  console.log("  TRAJECTORY COMPARISON");
  console.log("═══════════════════════════════════════");
  
  const b = baseline.summary;
  const c = current.summary;
  if (!b || !c) return;
  
  console.log(`  Cases analyzed: ${b.casesAnalyzed} → ${c.casesAnalyzed}`);
  console.log(`  Overall pass rate: ${b.overallPassRate}% → ${c.overallPassRate}%`);
  console.log(`  Passed assertions: ${b.passedAssertions}/${b.totalAssertions} → ${c.passedAssertions}/${c.totalAssertions}`);
  
  if (b.byAssertion && c.byAssertion) {
    console.log("\n  Per-assertion:");
    for (const [id, bData] of Object.entries(b.byAssertion)) {
      const cData = c.byAssertion[id];
      if (cData) {
        console.log(`    ${id}: ${bData.passed}/${bData.total} (${bData.passRate}%) → ${cData.passed}/${cData.total} (${cData.passRate}%)`);
      }
    }
  }
}

function compareComponent(baseline, current) {
  console.log("\n═══════════════════════════════════════");
  console.log("  COMPONENT COMPARISON");
  console.log("═══════════════════════════════════════");
  
  const b = baseline.summary;
  const c = current.summary;
  if (!b || !c) return;
  
  console.log(`  Total tests: ${b.total} → ${c.total}`);
  console.log(`  Passed: ${b.passed} → ${c.passed}`);
  console.log(`  Pass rate: ${b.passRate}% → ${c.passRate}%`);
}

async function main() {
  const args = process.argv.slice(2);
  const baselineTag = args[0];
  const currentTag = args[1];
  
  if (!baselineTag || !currentTag) {
    console.error("Usage: node eval/scripts/compare.mjs <baseline-tag> <current-tag>");
    console.error("Example: node eval/scripts/compare.mjs baseline after");
    process.exit(1);
  }
  
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  COMPARISON: ${baselineTag} vs ${currentTag.padEnd(20)} ║`);
  console.log(`╚══════════════════════════════════════════╝`);
  
  const levels = ["unit", "security", "trajectory", "component", "judge", "online"];
  
  for (const level of levels) {
    const baselineFile = await findResultFile(baselineTag, level);
    const currentFile = await findResultFile(currentTag, level);
    
    if (!baselineFile || !currentFile) {
      console.log(`\n${level}: SKIPPED (missing result files)`);
      continue;
    }
    
    const baseline = await loadReport(baselineFile);
    const current = await loadReport(currentFile);
    
    switch (level) {
      case "unit": compareUnit(baseline, current); break;
      case "security": compareSecurity(baseline, current); break;
      case "trajectory": compareTrajectory(baseline, current); break;
      case "component": compareComponent(baseline, current); break;
      default: console.log(`\n${level}: comparison not implemented`);
    }
  }
  
  console.log("\n═══════════════════════════════════════");
  console.log("  COMPARISON COMPLETE");
  console.log("═══════════════════════════════════════");
}

main().catch((e) => { console.error(e); process.exit(1); });
