// Long-horizon coherence test.
//
// One session, one workspace, many turns — deliberately built so that the
// things the agent must still know at the end are established at the START and
// never repeated: the original goal (turn 1), a colour decision (turn 2), and
// the answer to a clarifying question (turns 4-5). Between them sit a forced
// tool failure and enough successful steps to push the early turns out of any
// plain recency window.
//
// The pass criteria are recall probes, not vibes: each probe asks for one
// specific fact and the answer is matched against it.
//
//   node bench/long-horizon.mjs --tag baseline

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { runTurn, resetUsage, readUsage, seedWorkspace } from "./driver.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const tag = args[args.indexOf("--tag") + 1] || "run";

const SESSION = `bench-lh-${tag}-${Date.now()}`;
const ROOT = path.join(os.tmpdir(), "trion-bench", `lh-${tag}`);

/**
 * The script. `probe` turns are graded on what the reply RECALLS; `work` turns
 * are graded on whether the session kept moving.
 */
const SCRIPT = [
  {
    kind: "work",
    mode: "execute",
    text: "build a small task tracker app at projects/tracker with an index.html, a src/main.tsx entry, and a src/App.tsx that lists tasks",
  },
  {
    kind: "work",
    mode: "execute",
    text: "make the accent colour in the tracker green rather than blue, in projects/tracker/src/styles.css",
  },
  {
    kind: "work",
    mode: "execute",
    text: "install the nanoid package into projects/tracker so tasks can have ids",
    // Forces the retry path: the first attempt at this command fails.
    failCommands: ["nanoid"],
    expectFailure: true,
  },
  {
    kind: "work",
    mode: "execute",
    text: "add a projects/tracker/src/TaskItem.tsx component that renders one task with a done checkbox, and use it in App.tsx",
  },
  // Mid-task clarification, forced rather than hoped for: this phrasing is one
  // the classifier's ambiguity heuristics resolve to needs_clarification, so the
  // question really is asked and the next turn really is its answer.
  {
    kind: "clarify",
    mode: "execute",
    text: "what should we do next?",
    label: "mid-task clarification",
  },
  {
    kind: "work",
    mode: "execute",
    text: "add a projects/tracker/src/Header.tsx showing the title 'My Tasks' and render it at the top of App.tsx",
    label: "answer to the clarification",
  },
  {
    kind: "probe",
    mode: "plan",
    text: "remind me: what was the original thing I asked you to build in this session?",
    // "task tracker", "task-tracker" and "task‑tracker" (U+2011 non-breaking
    // hyphen, which the model actually emitted) are the same recall. Requiring
    // a literal space scored a complete, correct answer as a MISS on the choice
    // of hyphen — measuring orthography rather than memory.
    expect: [/task[\s‐-―-]?tracker/i, /projects\/tracker/i],
    label: "original goal",
  },
  {
    kind: "probe",
    mode: "plan",
    text: "what colour did I tell you to use for the accent?",
    expect: [/green/i],
    label: "mid-session decision",
  },
  {
    kind: "work",
    mode: "execute",
    text: "add a projects/tracker/src/Filter.tsx component with buttons for all / active / completed, and render it in App.tsx",
  },
  {
    kind: "probe",
    mode: "plan",
    text: "which files have you created or changed in projects/tracker so far? list their paths.",
    expect: [/App\.tsx/, /TaskItem\.tsx/, /Filter\.tsx/],
    label: "files touched",
  },
  {
    kind: "probe",
    mode: "plan",
    text: "did anything fail earlier in this session? if so, what?",
    expect: [/nanoid|install|command/i],
    label: "failure recall",
  },
];

function textOf(run) {
  return `${run.result?.message ?? ""}\n${run.result?.next_action_hint ?? ""}`;
}

async function main() {
  await seedWorkspace(ROOT);
  await resetUsage(SESSION);

  const turns = [];
  let stepsExecuted = 0;
  let sawRetry = false;
  let sawClarification = false;

  for (const [index, entry] of SCRIPT.entries()) {
    process.stdout.write(`\n--- turn ${index + 1} (${entry.kind}) --- ${entry.text.slice(0, 78)}\n`);

    const run = await runTurn({
      sessionId: SESSION,
      userText: entry.text,
      mode: entry.mode,
      root: ROOT,
      failCommands: entry.failCommands,
    });

    const trace = run.result?.tool_trace ?? [];
    stepsExecuted += new Set(trace.map((t) => t.step_id)).size;
    if (trace.some((t) => t.attempt > 1)) sawRetry = true;
    if (run.result?.status === "needs_clarification") sawClarification = true;

    const record = {
      turn: index + 1,
      kind: entry.kind,
      label: entry.label ?? null,
      text: entry.text,
      status: run.result?.status ?? null,
      ms: run.ms,
      toolSteps: new Set(trace.map((t) => t.step_id)).size,
      trace: trace.map((t) => `${t.step_id}:${t.tool_name}:a${t.attempt}:${t.status}`),
      message: run.result?.message ?? "",
    };

    if (entry.kind === "probe") {
      const body = textOf(run);
      const hits = entry.expect.map((re) => ({ pattern: String(re), matched: re.test(body) }));
      record.recall = hits;
      record.recalled = hits.every((h) => h.matched);
      process.stdout.write(
        `    RECALL [${entry.label}] ${record.recalled ? "PASS" : "FAIL"} — ` +
          hits.map((h) => `${h.pattern}${h.matched ? " ok" : " MISS"}`).join(", ") +
          `\n    reply: ${record.message.replace(/\s+/g, " ").slice(0, 220)}\n`
      );
    } else {
      process.stdout.write(`    ${record.status} — ${record.toolSteps} tool step(s): ${record.trace.join(" ")}\n`);
    }

    turns.push(record);
  }

  const usage = await readUsage(SESSION);
  const probes = turns.filter((t) => t.kind === "probe");
  const recalled = probes.filter((t) => t.recalled).length;

  const report = {
    tag,
    session: SESSION,
    at: new Date().toISOString(),
    turns,
    stepsExecuted,
    sawRetry,
    sawClarification,
    probes: { total: probes.length, recalled },
    pass: stepsExecuted >= 10 && sawRetry && sawClarification && recalled === probes.length,
    usage: { totals: usage.totals, costUsd: usage.costUsd },
  };

  await fs.mkdir(path.join(HERE, "results"), { recursive: true });
  const out = path.join(HERE, "results", `long-horizon-${tag}.json`);
  await fs.writeFile(out, JSON.stringify(report, null, 2), "utf-8");

  console.log(
    `\n=== LONG-HORIZON (${tag}) ===\n` +
      `  turns                 ${turns.length}\n` +
      `  tool steps executed   ${stepsExecuted}  (need >= 10)\n` +
      `  saw a retry           ${sawRetry}\n` +
      `  saw a clarification   ${sawClarification}\n` +
      `  recall probes passed  ${recalled}/${probes.length}\n` +
      `  total tokens          ${usage.totals.totalTokens}  ($${usage.costUsd.toFixed(4)})\n` +
      `  OVERALL               ${report.pass ? "PASS" : "FAIL"}\n\n  written: ${out}\n`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
