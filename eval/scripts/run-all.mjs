#!/usr/bin/env node
// Master Evaluation Runner. Local component checks are safe by default; live
// model/browser suites require an explicit opt-in because this product shares a
// 40-RPM allowance and browser-executed tools cannot be tested by HTTP alone.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EVAL_DIR = path.join(HERE, "..");

const LEVELS = [
  { name: "unit", script: "unit/run.mjs", desc: "Unit-level (13-case speed + 11-case coding)" },
  { name: "judge", script: "judge/run.mjs", desc: "LLM-as-Judge (requires calibration)" },
  { name: "online", script: "online/runner.mjs", desc: "Online/Production-Condition (concurrent load)" },
  { name: "security", script: "security/run.mjs", desc: "Security (5 attack vectors)" },
  { name: "trajectory", script: "trajectory/run.mjs", desc: "Trajectory-Level (tool trace assertions)" },
  { name: "component", script: "component/run.mjs", desc: "Component-Level (classifier, critic, rate lane)" },
];

async function runLevel(level, tag, extraArgs = []) {
  return new Promise((resolve) => {
    console.log(`\n═══════════════════════════════════════`);
    console.log(`  RUNNING: ${level.name.toUpperCase()} — ${level.desc}`);
    console.log(`═══════════════════════════════════════\n`);
    
    const runtime = level.name === "judge" ? path.join(EVAL_DIR, "..", "node_modules", ".bin", "tsx") : "node";
    const child = spawn(runtime, [path.join(EVAL_DIR, level.script), `--tag=${tag}`, ...extraArgs], {
      stdio: "inherit",
      cwd: EVAL_DIR,
    });
    
    child.on("close", (code) => {
      console.log(`\n${level.name} exited with code ${code}`);
      resolve({ level: level.name, code, success: code === 0 });
    });
    
    child.on("error", (err) => {
      console.error(`Failed to start ${level.name}:`, err);
      resolve({ level: level.name, code: -1, success: false, error: err.message });
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const tag = args.find((a) => a.startsWith("--tag="))?.split("=")[1] || `eval-${Date.now()}`;
  const skip = args.find((a) => a.startsWith("--skip="))?.split("=")[1]?.split(",") || [];
  const only = args.find((a) => a.startsWith("--only="))?.split("=")[1]?.split(",");
  const allowLive = args.includes("--live");
  const includeOnline = args.includes("--include-online");
  const includeJudge = args.includes("--include-judge");
  
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  MASTER EVALUATION RUN — tag: ${tag.padEnd(20)} ║`);
  console.log(`╚══════════════════════════════════════════╝`);
  
  const requestedLevels = only 
    ? LEVELS.filter((l) => only.includes(l.name))
    : LEVELS.filter((l) => !skip.includes(l.name));
  const levelsToRun = requestedLevels.filter((level) => {
    if (level.name === "component") return true;
    if (!allowLive) return false;
    if (level.name === "online") return includeOnline;
    if (level.name === "judge") return includeJudge;
    return true;
  });
  
  console.log(`Levels to run: ${levelsToRun.map((l) => l.name).join(", ") || "component only"}`);
  if (!allowLive) console.log("Live suites skipped. Add --live only with a measured rate budget and an active browser bridge.");
  if (allowLive && !includeOnline) console.log("Online load test skipped. Add --include-online only for an intentional load test.");
  if (skip.length) console.log(`Skipped: ${skip.join(", ")}`);
  
  const results = [];
  
  for (const level of levelsToRun) {
    const result = await runLevel(level, tag);
    results.push(result);
    
    if (!result.success && !args.includes("--continue-on-fail")) {
      console.log(`\n⚠️  ${level.name} failed. Stopping (use --continue-on-fail to continue).`);
      break;
    }
  }
  
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  MASTER RUN COMPLETE`);
  console.log(`╚══════════════════════════════════════════╝`);
  console.log(`\nTag: ${tag}`);
  console.log(`Levels run: ${results.length}/${levelsToRun.length}`);
  
  for (const r of results) {
    const status = r.success ? "✓ PASS" : "✗ FAIL";
    console.log(`  ${r.level.padEnd(12)} ${status}${r.code !== undefined ? ` (code ${r.code})` : ""}`);
  }
  
  const allPassed = results.every((r) => r.success);
  console.log(`\nOverall: ${allPassed ? "ALL PASSED" : "SOME FAILED"}`);
  
  process.exit(allPassed ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
