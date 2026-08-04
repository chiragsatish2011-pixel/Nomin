#!/usr/bin/env node
// LLM-as-Judge Calibration Harness & Runner
// Runs calibration cases first — judge must score all 5 correctly before grading real cases.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { modelGateway } from "../../lib/agent/model-gateway.ts";
import { CALIBRATION_CASES, getRubric, scoreWithRubric } from "./rubrics.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = process.env.TRION_EVAL_RESULTS_DIR || path.join(HERE, "..", "results");

const JUDGE_SYSTEM_PROMPT = `You are an expert evaluator grading AI agent outputs against explicit rubrics.
You receive: the task input, the agent's output (message + tool trace), and the rubric criteria.
You MUST return ONLY valid JSON matching the rubric's criterion IDs with scores 0-100.
Do not add prose. Be precise and consistent.`;

function buildJudgePrompt(rubric, agentOutput, taskInput) {
  const criteriaDesc = rubric.criteria.map((c) =>
    `### ${c.name} (weight: ${c.weight}%)\n${c.levels.map((l) => `- ${l.score}: ${l.description}`).join("\n")}`
  ).join("\n\n");
  
  const traceSummary = agentOutput.tool_trace?.map((t) =>
    `Step ${t.step_id}: ${t.tool_name} (attempt ${t.attempt}) — ${t.status}${t.output ? `: ${String(t.output).slice(0, 200)}` : ""}`
  ).join("\n") || "(no tool trace)";
  
  return `Task Input: ${taskInput}

Agent Output:
${agentOutput.message || "(empty)"}

Execution Trace:
${traceSummary}

Final Status: ${agentOutput.status}

---

Rubric: ${rubric.name} v${rubric.version}
${rubric.description}

Criteria:
${criteriaDesc}

---

Return ONLY JSON with scores for each criterion:
{${rubric.criteria.map((c) => `"${c.id}": 0-100`).join(", ")}}
`;
}

async function judgeOutput(rubric, agentOutput, taskInput) {
  const prompt = buildJudgePrompt(rubric, agentOutput, taskInput);
  const messages = [
    { role: "system", content: JUDGE_SYSTEM_PROMPT },
    { role: "user", content: prompt },
  ];
  
  const raw = await modelGateway.completeText(messages, {
    tier: "trion-1.9",
    maxTokens: 500,
    callType: "judge",
    temperature: 0.1,
    thinking: false,
  });
  
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Judge returned no JSON: ${raw.slice(0, 200)}`);
  
  const scores = JSON.parse(jsonMatch[0]);
  const total = scoreWithRubric(rubric, scores);
  return { scores, total, raw };
}

async function runCalibration() {
  console.log("\n=== JUDGE CALIBRATION (5 known-answer cases) ===\n");
  let allPassed = true;
  
  for (const calCase of CALIBRATION_CASES) {
    const rubric = getRubric(calCase.taskType);
    console.log(`Calibrating ${calCase.id} (${calCase.taskType})...`);
    
    const { scores, total } = await judgeOutput(rubric, calCase.agentOutput, calCase.input);
    const expectedTotal = calCase.expectedTotal;
    const passed = total === expectedTotal;
    
    console.log(`  Expected: ${expectedTotal} | Got: ${total} | ${passed ? "PASS" : "FAIL"}`);
    if (!passed) {
      console.log(`  Expected breakdown:`, calCase.expectedScores);
      console.log(`  Actual breakdown:`, scores);
      allPassed = false;
    }
  }
  
  console.log(`\n${allPassed ? "✓ CALIBRATION PASSED" : "✗ CALIBRATION FAILED — do not proceed to grading"}`);
  return allPassed;
}

async function runJudgeEvaluation(tag) {
  const calibrated = await runCalibration();
  if (!calibrated) {
    console.error("Calibration failed. Fix rubric or judge prompt before proceeding.");
    process.exit(1);
  }
  
  // In a real run, this would load unit-level results and grade them
  console.log("\n=== JUDGE GRADING (would grade unit-level outputs here) ===");
  console.log("This harness is ready — integrate with unit results when running full eval.");
  
  const report = {
    tag,
    at: new Date().toISOString(),
    level: "judge",
    calibrationPassed: calibrated,
    note: "Connect to unit-level outputs for full grading",
  };
  
  await fs.mkdir(RESULTS, { recursive: true });
  const out = path.join(RESULTS, `judge-${tag}-${Date.now()}.json`);
  await fs.writeFile(out, JSON.stringify(report, null, 2), "utf-8");
  console.log(`\nwritten: ${out}`);
}

const args = process.argv.slice(2);
const tag = args.find((a) => a.startsWith("--tag="))?.split("=")[1] || "judge";
const onlyCalibrate = args.includes("--calibrate-only");

if (onlyCalibrate) {
  const ok = await runCalibration();
  process.exit(ok ? 0 : 1);
} else {
  runJudgeEvaluation(tag).catch((e) => { console.error(e); process.exit(1); });
}
