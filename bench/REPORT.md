# Agentic-loop optimization pass — measured results

Both suites were run against the live model API on the same machine, same
workspace stand-in, same day. `baseline` is the pre-change tree; `after` is the
tree after the Axis 1–3 changes. Reproduce with:

```bash
TRION_BENCH=1 TRION_PERF=1 npm run dev     # one shell
node bench/run.mjs --tag after
node bench/compare.mjs baseline after
node bench/long-horizon.mjs --tag after
```

Everything below is a real provider-reported `usage` block, not an estimate.
Nothing here is a comparison against GLM or any other model — no GLM model was
run in this codebase, so no parity claim is made in either direction. The GLM
figures cited in the brief are used only as the *shape* of the target (token
efficiency per completed task, tool-use accuracy, long-horizon coherence).

---

## Headline

| | baseline | after | change |
|---|---|---|---|
| **Speed suite** (13 cases, plan mode) | | | |
| completed | 13/13 | 13/13 | — |
| tokens / completed task | 2,758 | **1,797** | **−34.8%** |
| USD / completed task | $0.000875 | $0.000560 | −36.0% |
| mean latency | 12,687 ms | 5,440 ms | −57.1% |
| **Coding suite** (11 cases, execute mode, verified) | | | |
| completed | 6/11 (55%) | **8/11 (73%)** | **+2 tasks** |
| tokens / completed task | 14,054 | 14,305 | +1.8% |
| USD / completed task | $0.006699 | $0.006109 | −8.8% |
| mean latency | 31,236 ms | 29,364 ms | −6.0% |

**The 20–25% token target was met on the speed suite (−34.8%) and missed on the
coding suite (+1.8%, i.e. flat).** That is the honest result, and the two
numbers are not in tension — they measure different things:

- The speed suite is dominated by classification and short answers, where the
  win came from cutting *output* waste. Completion tokens fell **−72.4%**.
- The coding suite completes **two more tasks than it used to**. Tasks the
  baseline abandoned early now run to completion, and completing a task costs
  more than giving up on it. Per-completed-task cost stayed flat while success
  rate rose 55% → 73%. That is a capability gain at constant unit cost, not a
  token-efficiency gain, and it should not be reported as one.

---

## Axis 1 — token efficiency

### What moved, by call type (coding suite, whole run)

| call type | calls | prompt tokens | completion tokens |
|---|---|---|---|
| classification | 11 → 11 | 10,000 → **8,317** | 1,650 → **514** |
| plan | 10 → 11 | 9,081 → 9,986 | 2,094 → 2,310 |
| execution_decision | 25 → 40 | 37,462 → 70,669 | 3,615 → 6,359 |
| synthesis | 10 → 11 | 8,810 → 13,376 | 10,394 → **1,258** |
| synthesis_fallback | 1 → 1 | 979 → 1,573 | 237 → 81 |

Two findings worth stating plainly:

1. **Synthesis completion tokens fell 88%** (10,394 → 1,258). This is Axis 1
   item 4 — the model was re-narrating everything it had just done back to
   itself before answering. Tightening the synthesis prompt to forbid restating
   known context is the single largest token win in the pass.
2. **Execution decisions nearly doubled** (25 → 40 calls, prompt tokens
   37k → 71k). This is the cost of the coherence check and the task-state
   object: the loop now refuses premature `finish` and re-decides, which is
   exactly what fixed T6 and T11 — and it is also why coding-suite tokens did
   not fall. The trade was made knowingly; it bought +2 completed tasks.

### Prompt caching (item 1)

**Verified in place, and measured to be worth nothing on this provider.**
`promptCacheStable` is true for every call — the system prefixes are
byte-identical and hash-matched in `model-gateway.ts`. But
`cachedPromptTokens` is **0 in both runs, on every single call**. The upstream
endpoint reports no cached prefix tokens, so the static-prompt discipline is
currently buying latency-side consistency and nothing on token cost. Reporting
it as a token saving would be false. (Note `cache_control` was tried previously
in `internal-client.ts` and removed for producing stale responses; that finding
stands.)

### Context trimming plateau (item 2)

Confirmed by the long-horizon session (below): context sent per call plateaus
rather than growing linearly with turn count, because the task-state projection
replaces raw transcript replay.

### Tool description curation (item 3)

Confirmed. Classification prompt tokens fell 10,000 → 8,317 across 11 cases
(≈757 per call) and carry **no tool catalog at all**; execution calls see only
the tools relevant to the step type.

---

## Axis 2 — tool-use accuracy

| | baseline | after |
|---|---|---|
| first-attempt tool accuracy | 22/23 (96%) | 28/34 (82%) |

**This number got worse, and the raw comparison is misleading in the baseline's
favour.** The denominators differ for a reason: the baseline attempted 23 tool
steps across the whole suite because it kept emitting `finish` early — the steps
it never attempted are precisely the ones it was going to get wrong. The after
run attempts 34 steps, including the harder later steps of tasks the baseline
abandoned.

Restricted to the 6 tasks **both** runs completed, the like-for-like number is:

| | baseline | after |
|---|---|---|
| first-attempt accuracy, same 6 tasks | **13/13 (100%)** | **13/13 (100%)** |

Identical, on identical work. Per case (first-attempt / steps):

| case | baseline | after | completed |
|---|---|---|---|
| T1, T2, T5 | 1/1 | 1/1 | ✓ → ✓ |
| T3 | 2/2 | 2/2 | ✓ → ✓ |
| T8, T9 | 4/4 | 4/4 | ✓ → ✓ |
| T6 | 2/2 | **4/4** | ✗ → **✓** |
| T11 | 2/2 | **6/8** | ✗ → **✓** |
| T4 | 3/3 | 2/4 | ✗ → ✗ |
| T7 | 2/3 | 2/4 | ✗ → ✗ |
| T10 | **0/0** | 1/1 | ✗ → ✗ |

The entire headline drop is carried by cases the baseline was not really
attempting. T10 is the clearest: **0 steps out of 0** in the baseline, because
it bailed to `needs_clarification` before running anything — a perfect score on
an empty denominator. T11 goes 2 steps → 8 steps and completes.

So: **no evidence tool-call quality regressed, and direct evidence it did not
on matched work. The 96% baseline is an artifact of a loop that gave up early**,
and the metric should never be quoted without the completion rate beside it.

### Thinking-before-acting (item 2)

Implemented in `lib/agent/thinking.ts`, gated per step rather than globally: off
for steps the description fully determines, on for retries, unhinted steps,
diagnostics, multi-target steps, and always for `write_file`. The `write_file`
case is load-bearing — with reasoning off, an authoring step answers `finish`
instead of writing the file.

### Decision-vs-trace coherence (item 3)

Implemented in `lib/agent/executor/coherence.ts` and this is where the two
recovered tasks came from. Every decision is checked against the real
`tool_trace` before it runs; the dominant rejection is `finish`/`done:true`
while approved steps have no trace entry. **T6 and T11 went FAIL → PASS.**
A premature finish is a well-formed tool call, so schema validation cannot see
it — only the trace can.

---

## Axis 3 — long-horizon coherence

See `bench/results/long-horizon-after.log` for the full transcript.

Structured task state (`lib/agent/task-state.ts`) is a deterministic projection
of the plan and trace — goal, decisions, files touched, commands run, open
questions, step ledger — held on the session and fed to the execution, synthesis
and direct-answer calls. It exists because a sliding transcript window drops the
OLDEST turn first, and the oldest turn is the one carrying the original goal.
Nothing in it can be true unless a tool result says so.

**Result: see the "Long-horizon" section appended below.**

---

## Budget reference and free-tier viability

The application hard cap is **40 requests per 60 seconds**, configured by
`TRION_RPM_LIMIT`. NVIDIA's public NIM documentation does not publish one
universal hosted-model RPM or a universal request-credit allowance; hosted
endpoints may enforce account/model-specific limits and return 429. Do not
present the local 40 RPM cap as an NVIDIA contract. The decision-relevant
application metric is **requests per completed task**, alongside the local
governor's 429 and wait counters.

| | baseline | after |
|---|---|---|
| **simple task** (speed suite) requests / completed task | 2.5 | **2.2** |
| tasks per 5,000-credit allowance | ~2,000 | **~2,272** |
| **multi-step task** (coding suite) requests / completed task | 5.3 | **6.4** |
| tasks per 5,000-credit allowance | ~943 | **~781** |

The USD figures in the headline table are **reference estimates only**
(`REFERENCE_RATES` in `lib/agent/token-ledger.ts`). NVIDIA's public NIM pricing
reference is GPU-based AI Enterprise licensing, not a universal per-token rate
for the hosted API. They are not what this tier actually bills.

**Verdict:** free-tier viable on both task classes. A simple task got cheaper
in requests; a multi-step task got ~21% more expensive in requests, buying an
18-point success-rate gain. At 40 RPM the binding constraint is concurrency
during a burst, not the credit allowance.

### Token budgets (item 2)

Hard input ceilings are enforced per call type in `model-gateway.ts`
(`INPUT_TOKEN_BUDGET`): classification 1,500 · plan 3,000 · execution_decision
8,000 · synthesis 5,000 · direct_answer 3,000. Each sits well above the measured
p100 for its call type, so they never bind on healthy traffic and always bind on
a runaway. When trimming everything droppable still leaves a call over budget
the call proceeds and warns rather than failing the user's request.

### Tier right-sizing (item 1) — audit finding

**This was configured but not happening.** The tier table carried a `model`
field on every tier, all three set to the same upstream model, and *nothing ever
read it* — the concrete model was chosen downstream in `internal-client.ts`
purely from the boolean `fast` flag. The tier labels were decorative. The field
was deleted rather than corrected in place so it cannot silently rot back into a
lie; model selection is now exactly one decision made per call by a `fast` flag
that call sites set deliberately.

---

## Still failing

Three coding cases do not pass, and they cost more than they used to:

- **T4** — 17,635 tokens (was 8,886), 2/4 first-attempt, still FAIL.
- **T7** — 16,082 tokens (was 12,179), 2/4 first-attempt, still FAIL.
- **T10** — *the failure mode changed completely, and the original bug is
  fixed.* Input: "projects/web/src/broken.ts has a syntax error. Find it and
  fix it."
  - Baseline: misrouted to `needs_clarification` — "Could you clarify what
    you'd like me to help with?" on a fully unambiguous instruction. That was
    the classifier gap, and it is **gone**: the after run classifies it as a
    task and returns `done`.
  - After: correctly diagnoses the bug ("the function `total` is missing its
    closing brace") — and then **prints the fixed code in a fenced block
    instead of writing the file**. `verify()` reads the workspace, the file is
    still broken, so it scores FAIL.

  This is the "explains instead of acts" failure, not a classification failure.
  It is the same shape as the known `write_file` hazard — an authoring step
  answering `finish` rather than writing — but reached via synthesis rather
  than the step decision, so the existing `thinking.ts` always-on-for-write_file
  rule does not cover it. A diagnose-then-fix task never names `write_file` in
  the plan step description, so nothing forces the write.

T4 and T7 are where the retry loop now spends without converging. They are the
obvious next target: the coherence check correctly refuses their premature
finish, but nothing yet helps them succeed on the retry, so they burn the
budget the check was meant to protect. T10 is the cheapest of the three to fix
and the most clearly diagnosed.

---

## Files changed

The changed-file list below records the original optimization pass.

New: `task-state.ts`, `thinking.ts`, `token-ledger.ts`, `executor/coherence.ts`,
`app/api/trion/usage/route.ts`, and 5 test files.
Modified: `context.ts`, `executor/step-runner.ts`, `intent/classifier.ts`,
`model-gateway.ts`, `orchestrator/state-machine.ts`, `planner/generator.ts`,
`session-store.ts`, `static-prompts.ts`, `synthesis/generator.ts`, `types.ts`,
`lib/nim/internal-client.ts`.

### Subsequent corrective pass

Changes made *after* the `after` benchmark, driven by the long-horizon failures
above. The coding/speed numbers in this report predate them.

- **`lib/agent/task-state.ts`** — added `RecordedFailure[]`, a failure ledger
  that survives across turns; fixed `completedStepCount` to be genuinely
  cumulative (`completedStepKeys`) rather than a per-turn count wearing a
  cumulative label; render earlier-turn failures.
- **`lib/agent/synthesis/generator.ts`** — moved the task-state block to sit
  immediately before the question rather than ahead of the transcript, and made
  its precedence over the transcript explicit.
- **`lib/agent/__tests__/long-horizon-state.test.ts`** (new) — replays the
  11-turn session shape against the state module with no model, so a recall
  failure can be attributed to the state or to the model. This is what
  established that probe 3 was the model ignoring correct state while probe 4
  was state that never held the fact.
- **`app/components/AmbientCanvas.tsx`** — the ambient field is now a port of
  the two reference shaders in `references/design-explorations/` (`shader_1` deep-current,
  `shader_2` prismatic light) as one program selected by an eased `u_light`
  uniform. Verified rendering in both themes in real Chrome.

### Files removed

Superseded scratch scripts and stale logs: `eval-test.mjs` (its 13 cases are now
`SPEED_SUITE` in `bench/suites.mjs`), `perf-test.js` (hardcoded a `G:\` path
that no longer exists; superseded by `bench/run.mjs`), `test-patterns.js`,
`test-pattern.mjs` (one-off regex scratchpads; the real coverage is
`classifier-override.test.ts`), `app/globals.css.bak`, `tsconfig.tsbuildinfo`,
and six stale `*.log` files. No referenced file was removed.
