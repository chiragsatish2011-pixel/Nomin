// Before/after comparison over two bench/results/*.json runs.
//
//   node bench/compare.mjs baseline after
//
// Reports the headline metric — tokens per COMPLETED task — alongside the
// success rate that forms its denominator, because the two are only meaningful
// together: a run that sheds tokens by failing more often looks better on one
// and worse on the other, and only reading both catches it.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [beforeTag = "baseline", afterTag = "after"] = process.argv.slice(2);

const load = async (tag) => JSON.parse(await fs.readFile(path.join(HERE, "results", `${tag}.json`), "utf-8"));

function pct(before, after) {
  if (before === null || after === null || !before) return "n/a";
  const delta = ((after - before) / before) * 100;
  return `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`;
}

function fmt(value, digits = 0) {
  if (value === null || value === undefined) return "n/a";
  return typeof value === "number" ? value.toFixed(digits) : String(value);
}

const METRICS = [
  ["completed / cases", (s) => `${s.completed}/${s.cases}`, null],
  ["success rate", (s) => `${(s.successRate * 100).toFixed(0)}%`, null],
  ["tokens / completed task", (s) => fmt(s.tokensPerCompletedTask), (s) => s.tokensPerCompletedTask],
  ["  prompt tokens / task", (s) => fmt(s.promptTokensPerCompletedTask), (s) => s.promptTokensPerCompletedTask],
  ["  completion tokens / task", (s) => fmt(s.completionTokensPerCompletedTask), (s) => s.completionTokensPerCompletedTask],
  ["cost / completed task (USD)", (s) => `$${fmt(s.costPerCompletedTaskUsd, 6)}`, (s) => s.costPerCompletedTaskUsd],
  ["model calls / completed", (s) => fmt(s.modelCallsPerCompletedTask, 1), (s) => s.modelCallsPerCompletedTask],
  ["mean latency (ms)", (s) => fmt(s.meanMs), (s) => s.meanMs],
  ["total tokens (whole suite)", (s) => fmt(s.totalTokens), (s) => s.totalTokens],
  ["cached prompt tokens", (s) => fmt(s.cachedPromptTokens), null],
  [
    "1st-attempt tool accuracy",
    (s) => (s.toolSteps ? `${s.toolFirstAttemptOk}/${s.toolSteps} (${((s.firstAttemptToolAccuracy ?? 0) * 100).toFixed(0)}%)` : "n/a"),
    null,
  ],
];

const before = await load(beforeTag);
const after = await load(afterTag);

for (const suite of ["speed", "coding"]) {
  const b = before.suites[suite]?.summary;
  const a = after.suites[suite]?.summary;
  if (!b || !a) continue;

  console.log(`\n=== ${suite.toUpperCase()} SUITE — ${beforeTag} vs ${afterTag} ===\n`);
  console.log(`  ${"metric".padEnd(30)} ${beforeTag.padStart(12)} ${afterTag.padStart(12)}   change`);
  console.log(`  ${"-".repeat(30)} ${"-".repeat(12)} ${"-".repeat(12)}   ${"-".repeat(8)}`);
  for (const [label, render, value] of METRICS) {
    const change = value ? pct(value(b), value(a)) : "";
    console.log(`  ${label.padEnd(30)} ${render(b).padStart(12)} ${render(a).padStart(12)}   ${change}`);
  }

  // Per-case, so a suite-level average cannot hide a case that got worse.
  console.log(`\n  per case:`);
  console.log(`  ${"id".padEnd(5)} ${"before".padStart(20)} ${"after".padStart(20)}   tokens`);
  const byId = new Map(after.suites[suite].rows.map((r) => [r.id, r]));
  for (const row of before.suites[suite].rows) {
    const next = byId.get(row.id);
    if (!next) continue;
    const b1 = `${row.completed ? "PASS" : "FAIL"} ${String(row.totalTokens).padStart(6)}t ${String(row.ms).padStart(6)}ms`;
    const a1 = `${next.completed ? "PASS" : "FAIL"} ${String(next.totalTokens).padStart(6)}t ${String(next.ms).padStart(6)}ms`;
    const flip = row.completed === next.completed ? "  " : next.completed ? "↑ fixed" : "↓ REGRESSED";
    console.log(`  ${row.id.padEnd(5)} ${b1.padStart(20)} ${a1.padStart(20)}   ${pct(row.totalTokens, next.totalTokens).padStart(7)} ${flip}`);
  }
}

// Per-call-type spend, which is where a change shows up as a cause rather than
// an effect.
console.log(`\n=== TOKENS BY CALL TYPE (coding suite, whole run) ===\n`);
const stageTotals = (report) => {
  const totals = {};
  for (const row of report.suites.coding?.rows ?? []) {
    for (const [stage, use] of Object.entries(row.byCallType ?? {})) {
      const acc = (totals[stage] ??= { calls: 0, prompt: 0, completion: 0 });
      acc.calls += use.calls;
      acc.prompt += use.promptTokens;
      acc.completion += use.completionTokens;
    }
  }
  return totals;
};
const sb = stageTotals(before);
const sa = stageTotals(after);
console.log(`  ${"call type".padEnd(22)} ${"calls".padStart(11)} ${"prompt tok".padStart(14)} ${"completion tok".padStart(16)}`);
for (const stage of new Set([...Object.keys(sb), ...Object.keys(sa)])) {
  const b = sb[stage] ?? { calls: 0, prompt: 0, completion: 0 };
  const a = sa[stage] ?? { calls: 0, prompt: 0, completion: 0 };
  console.log(
    `  ${stage.padEnd(22)} ${`${b.calls}→${a.calls}`.padStart(11)} ${`${b.prompt}→${a.prompt}`.padStart(14)} ${`${b.completion}→${a.completion}`.padStart(16)}`
  );
}
console.log();
