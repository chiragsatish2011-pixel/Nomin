// Benchmark runner.
//
//   node bench/run.mjs --tag baseline            # both suites
//   node bench/run.mjs --tag after --suite coding
//
// Writes bench/results/<tag>.json and prints the comparison table. Requires the
// dev/prod server running with TRION_BENCH=1.

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { runTurn, resetUsage, readUsage, seedWorkspace } from "./driver.mjs";
import { SPEED_SUITE, CODING_SUITE, scoreSpeedCase } from "./suites.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(HERE, "results");

const args = process.argv.slice(2);
const tag = valueOf("--tag") || "run";
const only = valueOf("--suite") || "both";
const caseFilter = valueOf("--case");

function valueOf(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

/**
 * First-attempt tool-call accuracy.
 *
 * Two failure modes count, and only one of them reaches tool_trace:
 *  - a call that RAN and errored (bad path, bad command, failed verification)
 *    appears as an attempt-1 row with status "error";
 *  - a response that did not parse as a valid action never reaches runTool at
 *    all, so the step's trace simply STARTS at attempt 2. That gap is the
 *    evidence, and ignoring it would flatter the number.
 */
function toolAccuracy(trace) {
  const byStep = new Map();
  for (const entry of trace) {
    const rows = byStep.get(entry.step_id) ?? [];
    rows.push(entry);
    byStep.set(entry.step_id, rows);
  }

  let steps = 0;
  let firstAttemptOk = 0;
  let malformed = 0;
  let ranAndErrored = 0;

  for (const rows of byStep.values()) {
    steps += 1;
    const minAttempt = Math.min(...rows.map((r) => r.attempt));
    if (minAttempt > 1) {
      // Attempt 1 never produced a runnable call.
      malformed += minAttempt - 1;
      continue;
    }
    const first = rows.find((r) => r.attempt === 1);
    if (first?.status === "success") firstAttemptOk += 1;
    else ranAndErrored += 1;
  }

  return { steps, firstAttemptOk, malformed, ranAndErrored, rate: steps ? firstAttemptOk / steps : null };
}

async function runSpeedSuite() {
  const rows = [];
  for (const testCase of SPEED_SUITE) {
    if (caseFilter && testCase.id !== caseFilter) continue;
    const sessionId = `bench-${tag}-${testCase.id}-${Date.now()}`;
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

    process.stdout.write(
      `  ${testCase.id.padEnd(4)} ${score.completed ? "PASS" : "FAIL"} ${String(run.ms).padStart(6)}ms  ` +
        `${String(usage.totals.totalTokens).padStart(6)} tok (${usage.totals.calls} calls)  ${run.result?.status ?? "-"}` +
        `${score.why ? `  <- ${score.why}` : ""}\n`
    );
  }
  return rows;
}

async function runCodingSuite() {
  const rows = [];
  for (const testCase of CODING_SUITE) {
    if (caseFilter && testCase.id !== caseFilter) continue;
    const sessionId = `bench-${tag}-${testCase.id}-${Date.now()}`;
    const root = path.join(os.tmpdir(), "trion-bench", `${tag}-${testCase.id}`);
    await seedWorkspace(root, testCase.seed ?? {});
    await resetUsage(sessionId);

    const run = await runTurn({ sessionId, userText: testCase.input, mode: "execute", root });
    let completed = false;
    let verifyError = null;
    try {
      completed = run.ok ? await testCase.verify(root, run) : false;
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

    process.stdout.write(
      `  ${testCase.id.padEnd(4)} ${completed ? "PASS" : "FAIL"} ${String(run.ms).padStart(6)}ms  ` +
        `${String(usage.totals.totalTokens).padStart(6)} tok (${usage.totals.calls} calls, ${run.toolCalls.length} tools)  ` +
        `1st-try ${accuracy.firstAttemptOk}/${accuracy.steps}${verifyError ? `  verify-error: ${verifyError}` : ""}\n`
    );
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
    // The headline metric. Denominator is COMPLETED tasks, so shedding tokens
    // by failing more often makes this number worse, not better.
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
  await fs.mkdir(RESULTS, { recursive: true });
  const report = { tag, at: new Date().toISOString(), suites: {} };

  if (only === "both" || only === "speed") {
    console.log(`\n=== SPEED / PROFESSIONALISM SUITE (13 cases, plan mode) — tag "${tag}" ===`);
    const rows = await runSpeedSuite();
    report.suites.speed = { rows, summary: summarise(rows) };
  }

  if (only === "both" || only === "coding") {
    console.log(`\n=== CODING SUITE (11 cases, execute mode, verified) — tag "${tag}" ===`);
    const rows = await runCodingSuite();
    report.suites.coding = { rows, summary: summarise(rows) };
  }

  const out = path.join(RESULTS, `${tag}.json`);
  await fs.writeFile(out, JSON.stringify(report, null, 2), "utf-8");

  console.log(`\n=== SUMMARY (${tag}) ===`);
  for (const [name, suite] of Object.entries(report.suites)) {
    const s = suite.summary;
    console.log(
      `\n${name}:\n` +
        `  completed              ${s.completed}/${s.cases}  (${(s.successRate * 100).toFixed(0)}%)\n` +
        `  total tokens           ${s.totalTokens}\n` +
        `  tokens / completed     ${s.tokensPerCompletedTask?.toFixed(0) ?? "n/a"}` +
        `  (prompt ${s.promptTokensPerCompletedTask?.toFixed(0) ?? "-"} / completion ${s.completionTokensPerCompletedTask?.toFixed(0) ?? "-"})\n` +
        `  cost / completed       $${s.costPerCompletedTaskUsd?.toFixed(6) ?? "n/a"}\n` +
        `  model calls / completed ${s.modelCallsPerCompletedTask?.toFixed(1) ?? "n/a"}\n` +
        `  mean latency           ${s.meanMs?.toFixed(0) ?? "-"}ms\n` +
        `  cached prompt tokens   ${s.cachedPromptTokens}\n` +
        (s.toolSteps
          ? `  1st-attempt tool acc.  ${s.toolFirstAttemptOk}/${s.toolSteps} (${((s.firstAttemptToolAccuracy ?? 0) * 100).toFixed(0)}%), ${s.toolMalformedFirstAttempts} malformed\n`
          : "")
    );
  }
  console.log(`\nwritten: ${out}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
