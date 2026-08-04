#!/usr/bin/env node
// Unit-level test harness — extends existing 13-case speed + 11-case coding suites
// Runs against live server (requires TRION_BENCH=1). Reuses bench/suites.mjs cases.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SPEED_SUITE, CODING_SUITE, scoreSpeedCase } from "../bench/suites.mjs";
import { runTurn, resetUsage, readUsage } from "../bench/driver.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = process.env.TRION_EVAL_RESULTS_DIR || path.join(HERE, "results");

async function runSpeedSuite(tag) {
  const rows = [];
  console.log(`\n=== SPEED SUITE (13 cases, plan mode) — ${tag} ===`);
  
  for (const testCase of SPEED_SUITE) {
    const sessionId = `eval-unit-speed-${testCase.id}-${Date.now()}`;
    await resetUsage(sessionId);
    
    const run = await runTurn({ sessionId, userText: testCase.input, mode: "plan" });
    const score = scoreSpeedCase(testCase, run);
    const usage = await readUsage(sessionId);
    
    rows.push({
      id: testCase.id,
      category: testCase.category,
      input: testCase.input,
      expect: testCase.expect,
      status: run.result?.status ?? null,
      completed: score.completed,
      why: score.why ?? null,
      ms: run.ms,
      ttft: run.ttft,
      modelCalls: usage.totals.calls,
      promptTokens: usage.totals.promptTokens,
      completionTokens: usage.totals.completionTokens,
      totalTokens: usage.totals.totalTokens,
      cachedPromptTokens: usage.totals.cachedPromptTokens,
      costUsd: usage.costUsd,
      byCallType: usage.totals.byCallType,
      message: (run.result?.message ?? "").slice(0, 300),
    });
    
    const statusStr = score.completed ? "PASS" : "FAIL";
    console.log(`  ${testCase.id.padEnd(4)} ${statusStr}  ${String(run.ms).padStart(6)}ms  ${String(usage.totals.totalTokens).padStart(6)} tok (${usage.totals.calls} calls)  ${run.result?.status ?? "-"}${score.why ? `  <- ${score.why}` : ""}`);
  }
  return rows;
}

function toolAccuracy(trace) {
  const byStep = new Map();
  for (const entry of trace) {
    const rows = byStep.get(entry.step_id) ?? [];
    rows.push(entry);
    byStep.set(entry.step_id, rows);
  }
  let steps = 0, firstAttemptOk = 0, malformed = 0, ranAndErrored = 0;
  for (const rows of byStep.values()) {
    steps += 1;
    const minAttempt = Math.min(...rows.map((r) => r.attempt));
    if (minAttempt > 1) { malformed += minAttempt - 1; continue; }
    const first = rows.find((r) => r.attempt === 1);
    if (first?.status === "success") firstAttemptOk += 1;
    else ranAndErrored += 1;
  }
  return { steps, firstAttemptOk, malformed, ranAndErrored, rate: steps ? firstAttemptOk / steps : null };
}

async function runCodingSuite(tag) {
  const rows = [];
  console.log(`\n=== CODING SUITE (11 cases, execute mode, verified) — ${tag} ===`);
  
  for (const testCase of CODING_SUITE) {
    const sessionId = `eval-unit-coding-${testCase.id}-${Date.now()}`;
    await resetUsage(sessionId);
    
    // Coding suite needs workspace - use a temp dir with seed
    const os = await import("node:os");
    const tmpRoot = path.join(os.tmpdir(), "trion-eval", `${tag}-${testCase.id}`);
    const { seedWorkspace } = await import("../bench/workspace.mjs");
    await seedWorkspace(tmpRoot, testCase.seed ?? {});
    
    const run = await runTurn({ sessionId, userText: testCase.input, mode: "execute", root: tmpRoot });
    let completed = false;
    let verifyError = null;
    try {
      completed = run.ok ? await testCase.verify(tmpRoot, run) : false;
    } catch (error) {
      verifyError = error.message;
    }
    const usage = await readUsage(sessionId);
    const accuracy = toolAccuracy(run.result?.tool_trace ?? []);
    
    rows.push({
      id: testCase.id,
      label: testCase.label,
      input: testCase.input,
      completed: Boolean(completed),
      verifyError,
      status: run.result?.status ?? null,
      ms: run.ms,
      ttft: run.ttft,
      modelCalls: usage.totals.calls,
      promptTokens: usage.totals.promptTokens,
      completionTokens: usage.totals.completionTokens,
      totalTokens: usage.totals.totalTokens,
      cachedPromptTokens: usage.totals.cachedPromptTokens,
      costUsd: usage.costUsd,
      byCallType: usage.totals.byCallType,
      planSteps: run.plan?.steps.length ?? 0,
      toolCalls: run.toolCalls.length,
      accuracy,
      trace: (run.result?.tool_trace ?? []).map((t) => ({ step: t.step_id, tool: t.tool_name, attempt: t.attempt, status: t.status })),
      message: (run.result?.message ?? "").slice(0, 400),
      error: run.error ?? null,
    });
    
    console.log(`  ${testCase.id.padEnd(4)} ${completed ? "PASS" : "FAIL"}  ${String(run.ms).padStart(6)}ms  ${String(usage.totals.totalTokens).padStart(6)} tok (${usage.totals.calls} calls, ${run.toolCalls.length} tools)  1st-try ${accuracy.firstAttemptOk}/${accuracy.steps}${verifyError ? `  verify-error: ${verifyError}` : ""}`);
  }
  return rows;
}

function summarise(rows) {
  const completedRows = rows.filter((r) => r.completed);
  const sum = (list, key) => list.reduce((n, r) => n + (r[key] ?? 0), 0);
  const accSteps = rows.reduce((n, r) => n + (r.accuracy?.steps ?? 0), 0);
  const accOk = rows.reduce((n, r) => n + (r.accuracy?.firstAttemptOk ?? 0), 0);
  const accMalformed = rows.reduce((n, r) => n + (r.accuracy?.malformed ?? 0), 0);
  
  return {
    cases: rows.length,
    completed: completedRows.length,
    successRate: rows.length ? completedRows.length / rows.length : 0,
    totalTokens: sum(rows, "totalTokens"),
    tokensPerCompletedTask: completedRows.length ? sum(rows, "totalTokens") / completedRows.length : null,
    promptTokensPerCompletedTask: completedRows.length ? sum(rows, "promptTokens") / completedRows.length : null,
    completionTokensPerCompletedTask: completedRows.length ? sum(rows, "completionTokens") / completedRows.length : null,
    costPerCompletedTaskUsd: completedRows.length ? sum(rows, "costUsd") / completedRows.length : null,
    modelCallsPerCompletedTask: completedRows.length ? sum(rows, "modelCalls") / completedRows.length : null,
    meanMs: rows.length ? sum(rows, "ms") / rows.length : null,
    meanMsCompleted: completedRows.length ? sum(completedRows, "ms") / completedRows.length : null,
    cachedPromptTokens: sum(rows, "cachedPromptTokens"),
    firstAttemptToolAccuracy: accSteps ? accOk / accSteps : null,
    toolSteps: accSteps,
    toolFirstAttemptOk: accOk,
    toolMalformedFirstAttempts: accMalformed,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const tag = args.find((a) => a.startsWith("--tag="))?.split("=")[1] || "unit";
  
  await fs.mkdir(RESULTS, { recursive: true });
  
  const speedRows = await runSpeedSuite(tag);
  const codingRows = await runCodingSuite(tag);
  
  const report = {
    tag,
    at: new Date().toISOString(),
    level: "unit",
    suites: {
      speed: { rows: speedRows, summary: summarise(speedRows) },
      coding: { rows: codingRows, summary: summarise(codingRows) },
    },
  };
  
  const out = path.join(RESULTS, `unit-${tag}-${Date.now()}.json`);
  await fs.writeFile(out, JSON.stringify(report, null, 2), "utf-8");
  
  console.log(`\n=== UNIT SUMMARY (${tag}) ===`);
  for (const [name, suite] of Object.entries(report.suites)) {
    const s = suite.summary;
    console.log(`\n${name}:\n  completed: ${s.completed}/${s.cases} (${(s.successRate * 100).toFixed(0)}%)\n  tokens/completed: ${s.tokensPerCompletedTask?.toFixed(0) ?? "n/a"}\n  cost/completed: $${s.costPerCompletedTaskUsd?.toFixed(6) ?? "n/a"}\n  1st-attempt tool acc: ${s.toolFirstAttemptOk}/${s.toolSteps} (${((s.firstAttemptToolAccuracy ?? 0) * 100).toFixed(0)}%)`);
  }
  console.log(`\nwritten: ${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
