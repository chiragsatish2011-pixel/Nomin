# Trion agent system report

This document describes system engineering around the model. It does not claim
weight-level training or fine-tuning access to Nemotron/NIM.

## NIM budget reference

NVIDIA's public NIM documentation does not publish one universal hosted-model
RPM value. NVIDIA's NIM deployment documentation describes NIM rate limiting as
an application/gateway responsibility, and the hosted API can return 429s. The
local application therefore treats `TRION_RPM_LIMIT` as the hard budget and
defaults it to **40 requests per 60 seconds**. It adapts downward after a 429
and never retries a missing browser bridge as a model request.

NVIDIA's public production pricing reference is GPU-based AI Enterprise
licensing, starting at **$4,500 per GPU per year** or approximately **$1 per GPU
per hour in the cloud**. That is not a per-token or per-request price for the
hosted API. The token ledger's dollar values are reference estimates only and
must not be presented as the user's actual NIM bill.

Sources:

- https://docs.api.nvidia.com/nim/docs/product
- https://docs.nvidia.com/nim/large-language-models/latest/api-reference.html
- https://docs.nvidia.com/nim/large-language-models/latest/security.html

## Three-key pool and selective quality chain (2026-08-03)

The provider client now supports a maximum of three independently paced key
buckets. It is deliberately an opt-in local configuration: all of
`TRION_KEY_POOL_ENABLED=1`, `TRION_KEY_POOL_TOS_CONFIRMED=1`, and configured
numbered keys are required; otherwise the existing one-key configuration is
used unchanged. A pool key is never coupled to a model tier. New independent
requests choose the least-loaded non-cooling key; a 429 or 503 cools only that
key and retries immediately on a healthy alternative when one exists. Secrets
never appear in the health route, metrics, test output, or logs.

NVIDIA documents that API keys are unique to an account and should be kept
secret, rotated, or revoked when necessary. Its hosted trial service can apply
rate limits, but the public documentation reviewed does **not** grant an
explicit exemption for combining multiple accounts/keys to multiply a trial
allowance. Accordingly, this implementation is capped at three configured
buckets, requires an explicit acknowledgement flag, and must not be scaled
beyond three without written provider authorization. See NVIDIA's [deployment
FAQ](https://docs.api.nvidia.com/nim/docs/deployment) and [Build trial
terms](https://build.nvidia.com/explore/discover).

| Area | Behaviour | RPM/token impact |
|---|---|---:|
| Independent concurrent work | Least-loaded selection across up to three individual 40-RPM buckets | No extra model calls. The local health snapshot reports aggregate configured capacity, but it is a configured ceiling—not a promise from NVIDIA. |
| 429 / 503 | Failed key cools for at least 60s (or longer Retry-After); a healthy key receives the retry | No added call when healthy; one retry only after a provider error, replacing a full-turn failure. |
| Coding completion chain | Existing proposer summary → read-only evidence critic → final synthesizer, only after a verified multi-file coding run | **+2 requests** only on this narrow success path; bounded to 3,000 + 4,000 input-token ceilings and 600 + 900 output tokens. |
| UI deliverable chain | Final substantial UI write → read-only checklist critic → scoped same-file rewrite when flagged → one critic re-check | 1 critic request when no violation; +1 synthesizer +1 re-check only after a specific violation. Bounded to 3,500/6,000/3,000 input-token ceilings and 700/2,800/700 output tokens. |
| Chat / simple task / plan-only | No reviewer chain | **0 additional requests/tokens**. |

The critic has no action parser, executor, or writable tool schema: it uses a
text-only model completion over a bounded trace/source excerpt. Its declared
capabilities contain only trace/file/diff/read-only-check evidence names;
`write_file` and `run_command` are structurally absent. The UI synthesizer is
validated at the executor boundary: it may rewrite only the same file already
approved in the plan. The re-check produces no fake user-facing trace entry;
only the real scoped rewrite is recorded as `write_file`.

Regression evidence:

- Simulated six concurrent leases distribute `key-1 → key-2 → key-3` twice;
  each key's 60-second window fills independently.
- A simulated 429 cools its selected key and immediately routes the retry to a
  different healthy key.
- An unverified “it works” coding claim is qualified by the critic's
  trace-derived fallback rather than allowed to stand.
- A generic purple-gradient UI violation causes exactly one same-file revision
  and exactly one targeted re-check in the execution-level regression.
- Direct, plan-mode, one-file, and unchecked runs do not meet the coding-chain
  predicate.

These regressions are automated in `key-pool.test.ts`, `quality-chain.test.ts`,
and `step-runner-design-review.test.ts`. They are deterministic simulations,
not invented provider billing figures. Real provider-reported usage remains
available only from the local benchmark endpoint when `TRION_BENCH=1`; it is
intentionally disabled in normal runtime so model identifiers and internal cost
records cannot reach a user-facing surface.

One fresh, local **plan-only** measurement was made with that endpoint enabled
temporarily, then disabled again. It does not trigger either quality chain, so
it is a clean baseline rather than a claim about reviewer cost:

| Stage | Calls | Prompt / completion tokens | Model time | Pool result |
|---|---:|---:|---:|---|
| Classification | 1 | 743 / 43 | 721ms | key-1 |
| Plan | 1 | 1,357 / 606 | 19,309ms | key-2 |
| Plan-only presentation | 1 | 563 / 380 | 2,897ms | key-3 |
| **Total** | **3** | **2,663 / 1,029** | **22,927ms** | one independent request per key |

The local reference-price estimate was **$0.0021616**, but it is not an NIM
invoice; hosted trial billing/quotas are not inferred from it. The coding and
UI review additions above are reported as explicit bounded call/token deltas
until a browser-backed end-to-end task reaches both chains in the same runtime.

### Real reviewer-chain measurement (benchmark-only)

The local quality probe ran the actual reviewer prompts through the normal key
pool with a fixed multi-file trace. It intentionally seeded an unverified
success claim and a generic standalone marketing page (purple/blue gradient,
three-card grid, template copy, and no interaction/accessibility treatment).

| Chain | Actual result | Provider calls / tokens / model time |
|---|---|---:|
| Coding | The critic returned `qualify` for the unsupported completion claim; the final synthesizer received that verdict instead of bypassing it. | 2 calls; 604 prompt + 182 completion tokens; 4.8s in the representative successful run. |
| UI | Critic returned `revise` with all five seeded checklist violations. The scoped writer produced a replacement file; the same critic re-check completed and rejected the remaining three-card-grid violation. | 3 calls; 3,232 prompt + 2,425 completion tokens; 31.4s in the representative completed re-check run. |

This is the correct evidence-based outcome, not a manufactured “pass”: the
re-check is deliberately allowed to reject an incomplete revision and the
product must surface that qualification rather than claim the design was fixed.
The stronger revision route was also measured and was not retained because it
did not return a valid bounded action before its deadline. The faster writer,
plus a hard source-format guard and mandatory re-check, is the safer
rate-limited configuration. A browser-backed multi-file run remains required
before treating UI quality as proven end-to-end.

### Follow-up browser findings

A controlled browser WebContainer run found two additional product defects and
both are now covered at the framework boundary. The development-only exhaustive
interface experiment had been automatically adding inspection/polish writes,
which violated requests that explicitly limited the number of files. It is now
**opt-in only** (`TRION_EXHAUSTIVE_BUILD_TEST=1`). A planner request such as
“exactly one React component file and one CSS file” now injects a hard
two-write scope contract; the live plan check produced two write steps plus a
build command, with no extra integration or polish files.

The same browser trace showed why a last-file-only design review was too weak:
the component contained a generic three-card layout while a later CSS file was
the last write. The reviewer now assembles a bounded, trace-grounded bundle of
all successfully written visual files, selects the source with the strongest
markup signal as the only permitted revision target, and re-checks the updated
bundle. This adds no request for non-UI work and no additional role; it makes
the existing critic inspect the actual deliverable rather than an arbitrary
final file.

## Before / after changes

| Area | Change | Requests | Token impact |
|---|---|---:|---:|
| Classification | Ordinary classification sends only the current message; an unresolved clarification is injected inline | 0 | Lower by the previous history payload, up to the 1,500-character classification context budget |
| Classification regression | 23 natural, abbreviated, vague, and imperative cases plus clarification recovery | 0 at runtime | Test-only |
| Vague task boundary | Requests such as “help me build something” are classified as clarification even if the model calls them a task; clarification output accepts only a real user-facing question | Lower: avoids plan, execution, and synthesis calls for an underspecified request | Lower: no speculative plan and no task workflow context for this branch |
| Browser execution | Missing WebContainer result fails at 45s instead of 180s | Lower: no retry decision calls for an unavailable bridge | Lower on bridge failures; one tool decision instead of up to three |
| Cross-route execution bridge | Pending browser execution and approval registries are shared across independently evaluated API route bundles | 0 additional calls | 0; removes the false timeout path and its doomed follow-up decisions |
| Completion verification | A trace-derived gate accepts only a successful build/test/lint/typecheck/dev-server command **after** the final runnable file change. Missing or failed evidence emits a factual response instead of model synthesis. | Lower when evidence is missing or failed: skips synthesis | **0 added calls/tokens**; one normal synthesis call is saved on an unchecked coding turn |
| Approved-step scope | Each concrete action must match its approved plan tool; read/search may substitute only for each other, while clarification remains available. `finish` is accepted only for an explicit no-tool/finish step. | 0 on valid executions | 0 normal token/RPM impact; an invalid model action uses one bounded re-decision instead of executing out of scope. |
| Approval | Risk-aware approval distinguishes destructive, outbound, privileged, large, and write-then-run work; `TRION_APPROVAL_PROFILE` supports permissive / balanced (default) / strict consent. Ordinary reversible work proceeds only under balanced/permissive policy. | 0 model calls | No model-token impact; adds one user approval action only for review-worthy work |
| Shared rate circuit | Opens after five consecutive 429 responses, then cools down for 60 seconds; a non-429 result breaks the sequence | Lower during sustained limits: rejects doomed retries while open | 0 added on healthy traffic; avoids up to five futile retry attempts per saturated request |
| Dispatch pacing | Provider starts are globally spaced 1.6s by default (37.5 RPM) beneath the 40-RPM shared ceiling; an explicit deployment setting may override it. | Lower: prevents burst-induced 429s before backoff is needed | **0 added requests/tokens**; deliberate worst-case queue tradeoff is up to 1.6s before a later queued call starts. |
| Model-call reliability | Classification has one 15s attempt; an execution decision has at most two 30s attempts; plans have at most two 45s attempts. | Lower on timeout failures: execution decision worst case falls from five 120s attempts to two 30s attempts | 0 added on healthy traffic; bounds a transient retry to one extra request rather than four |
| Circuit admission | An open circuit rejects queued work before it is charged to the local sliding-window budget. | Lower after an outage: no phantom local throttle | 0 provider requests/tokens; prevents a rejected request from consuming an RPM slot |
| Browser-worker lifecycle | A real page close/reload tears down its browser-owned sandbox worker; bfcache returns retain it. | Lower: avoids recovery retries caused by exhausted local sandbox capacity | 0 model requests/tokens |
| Long-turn liveness | The server emits its last real pipeline status every 15 seconds while a turn is pending; the client can distinguish a live slow turn from a dead stream. | 0 provider calls | 0 model tokens; a few small local stream frames only. This still needs a successful streamed-browser proof: the prior stalled local request did not deliver a heartbeat before the client watchdog recovered. |
| Authoring right-sizing | Staged UI authoring gets a 2,800-token file-body ceiling, no hidden reasoning on its first pass, and a dedicated write-only static prompt under half the normal author prompt size. Malformed/incorrect output returns to the normal reasoning retry path. | Lower on healthy UI authoring: avoids duplicate timeout retries | Lower prompt and output reservation; retry is paid only when the fast constrained pass fails |
| Secret/tool boundary | Blocks `.env` credentials, private keys, cloud-secret directories, direct network utilities, shell chaining, traversal, and destructive commands. Sensitive paths are also removed from browser snapshots and attachments before model-facing input. | Lower on invalid/malicious requests: rejected before WebContainer execution | Lower input metadata; **0 added model calls/tokens**. |
| Large file reads | Files over 200 lines return a compact head/tail map unless an explicit ≤200-line range is requested | Usually unchanged; rare large-file work may need one focused follow-up | Lower per-result context load; deliberate tradeoff is one extra tool decision only when a large file genuinely needs a middle section |
| Long-session compaction | After 60 raw turns, resolved history becomes a bounded deterministic session-memory receipt while unresolved clarifications/approvals remain verbatim. The opening user message is preserved separately. | 0 provider calls | **0 RPM and 0 completion tokens**; only sessions beyond 60 turns add at most ~400 input tokens of compacted context per relevant model call. |
| Session retention | In-memory sessions expire after 30 days of inactivity; malformed legacy timestamps are retained rather than risking accidental active-context deletion. | 0 provider calls | **0 RPM/token impact**; bounds server memory between process restarts. |
| Exhaustive interface test | Development-only UI-quality experiment forces visible inspect → implement → polish → verify stages | Normal production: 0. Test mode: may add up to two tool decisions/steps | Test-only small per-step context; enabled locally, disabled in production unless explicitly set to `1` |
| Local dev | `npm run dev` uses Webpack instead of Turbopack | 0 | 0 |
| Untrusted workspace content | Frames files, command output, search results, and attachments as data; static prompts deny them authority | 0 | Small deliberate input overhead: two cacheable static clauses and fixed delimiters around supplied content; no additional model call |
| Concurrent sessions | Async-local token attribution is regression-tested under overlapping work | 0 | Test-only |
| Concurrent model usage | Token-window settlement is tied to its own dispatched request, even when completions arrive out of order | 0 | 0 |
| Accessibility | Added accessible names to icon-only composer, preview, and artifact-panel controls | 0 | 0 |
| Interruption recovery | HTTP cancellation prevents the state machine from proceeding to plan, tool, or synthesis stages after the current provider request resolves | Lower on stopped turns | No new call; avoids all downstream calls after cancellation |

## Live coding verification

The benchmark case `T10` seeds `projects/web/src/broken.ts` with a missing
closing brace in its `for` loop, asks the agent to diagnose and fix it, and
then checks the resulting file rather than trusting the model's final text.

| Run | Outcome | Time | Model calls | Provider-reported tokens | Tool evidence |
|---|---|---:|---:|---:|---|
| `quality-arc` (stale dev process) | Failed: the benchmark's tool-result post received 404, so no file change was accepted | 52.2s | 4 | 4,921 | `read_file` never reached the bridge; no false success was reported |
| `quality-arc-fixed-bridge` (clean server) | Passed | 20.7s | 5 | 7,935 (7,210 prompt, 725 completion) | `read_file` and `write_file` both succeeded on their first attempt; the brace-balance verifier passed |

The successful run's actual call split was one classification call (797 tokens),
one plan call (1,416), two execution decisions (4,474), and one synthesis call
(1,248). It completed at 2/2 first-attempt tool accuracy. The additional work
relative to the failed run is not a silent rate regression: it is the one
execution decision needed after the real `read_file` result to choose and carry
out the repair. The browser-bridge failure path now avoids further model retries
entirely.

Raw, machine-readable evidence: `bench/results/quality-arc-fixed-bridge.json`.

## Real browser/WebContainer verification

The browser-owned execution bridge was exercised against a clean local server,
not simulated through the benchmark driver. The first browser run exposed a
real defect: the chat and tool-result API routes had separately evaluated
module-level pending maps under Webpack development mode. The browser did run
the requested `write_file`, but its POST received a typed 404 and the server
waited for the 45-second bridge timeout.

The registry now lives on `globalThis`, so both route bundles rendezvous on the
same execution id. Repeating the exact task — create `browser-e2e.txt` with
`Browser bridge verified` — produced this server-side evidence:

| Check | Actual result |
|---|---|
| Browser tool-result POST | **200** in 337ms |
| Tool trace | `write_file` succeeded on first attempt |
| Total browser turn | **11.1s** |
| Pipeline calls | classification, plan, execution decision, synthesis — 4 normal calls |
| Rendered browser state | `Done`, `1/1 tasks · 1 tool call`, code panel showing `browser-e2e.txt` and its exact content |
| First-turn workspace context | Client snapshot contained 13 mounted workspace files before planning |

The fix adds no model request and no model tokens. It removes the previous
45-second timeout and the two doomed follow-up decision calls that an
unavailable bridge would otherwise cause. The cross-route module regression is
in `lib/agent/execution/__tests__/bridge.test.ts`.

## Honest availability boundaries

Only the configured Trion 1.4 route is selectable in the product. The 1.9 and
2.3 entries are disabled and now say `Provider route not configured`; they are
not represented as alternative active models. This is a UI wording correction,
not a provider or model change: **0 requests and 0 tokens**. Enabling those
tiers needs concrete provider model identifiers, credentials, and a separate
rate/quality evaluation; it must not be guessed from decorative tier labels.

The executor remains browser-owned by design. With the Trion tab open, the
verified browser flow above now works. A completely closed or suspended tab
cannot execute a browser WebContainer; solving that requires a separately
authorized server-side sandbox architecture, not a prompt or retry change.

## Final checks

- `npx vitest run`: **40 files, 436 tests passed** after the current reliability, execution-recovery, circuit, staged-workflow, long-session-compaction, approval-profile, dispatch-pacing, approved-step-scope, sensitive-context-boundary, session-retention, key-pool, quality-chain, exact-file-scope, and multi-file UI-review changes.
- `npm run lint`: **passed**.
- `npm run build`: **passed**, including `/api/trion/tool-result` in the route manifest.
- Fresh Webpack development server smoke test: `/` returned **200**. A deliberately
  unmatched tool-result post returned the route's typed **404** (`Unknown or expired
  execution id`), proving the route is present and validating requests rather than
  falling through as a missing route or a 500.

## Additional hardening

Workspace and attachment text now crosses an explicit trust boundary before it
reaches the model. It is marked as untrusted data at the message boundary, and
the cached planning/execution system prompts state that only the system prompt
and the user's request may set goals, permissions, tools, or approval state.
This has no RPM impact and deliberately trades a small amount of cached prompt
and delimiter text for prompt-injection resistance. A focused regression suite
also proves that overlapping asynchronous model calls record their usage in the
correct session ledger.

Cancellation is now explicit agent state, rather than merely closing the browser
stream. A stop signal releases pending browser work and, at every stage boundary,
prevents further planning, tool execution, or synthesis. A provider completion
already in flight may still return (provider cancellation is not assumed), but it
cannot trigger any later action or model request.

The workspace UI also keeps a monotonic request identity. A stopped or stale
stream can no longer overwrite a newer turn's busy state, clear its abort
controller, drain its queue, or surface a deliberate stop as a generic error.

## Workflow contract

1. Classify the current message.
2. Plan only actionable work.
3. Ask for approval for destructive, outbound, privileged, large, or write-then-run plans.
4. Execute one approved step at a time using only the relevant tool catalog.
5. Validate the tool result before recording success and compare every next decision with the actual trace.
6. Run one relevant verification command after runnable code changes.
7. Synthesize only verified outcomes.

Direct answers do not create plans, traces, approvals, or tool calls.

## Current live behavioral checks

The local API was exercised after the current source changes, using fresh,
isolated session ids:

| Input | Actual output evidence | RPM/token impact of the repair |
|---|---|---|
| `hello` | `Hello! 👋`, `plan: null`, empty `tool_trace` | Deterministic fast path: **0 provider requests, 0 provider input/output tokens**. |
| `what is 2+2` | `4`, `plan: null`, empty `tool_trace` | Deterministic fast path: **0 provider requests, 0 provider input/output tokens**. Live rate counters stayed at `admitted: 108`, `requestsInWindow: 0`, `tokensInWindow: 0` before and after. |
| `help me build something` | `What would you like to build?`, `status: needs_clarification`, `plan: null`, empty `tool_trace` | Removes the previously observed speculative plan, execution decision, and synthesis calls. The clarification reply is taken directly from the classification turn. |
| `my name is Alice` → `what is my name?` | Second turn returned `Alice`, with no plan or tools | No added request; the existing bounded conversational context provides the recall. |

The clarification-output regression rejects classifier self-narration such as
“The user wants…” or “I need to clarify…” at the user-facing boundary. It
falls back to “What would you like to build?” rather than leaking internal
reasoning.

## Completion evidence gate

The previous prompt told the model to run a check after coding, but a prompt is
not enforcement. The completion path now derives verification from successful
tool trace entries. A `.tsx` / `.ts` / `.js` / style / page / config write is
only marked verified when a relevant successful command follows its **last**
write. An earlier build cannot validate a later edit, and `npm install` alone
does not count as proof that code works.

Focused regression evidence:

| Trace | Actual result | RPM/token impact |
|---|---|---:|
| `write_file src/Counter.tsx` | `not_run`; deterministic output says it cannot confirm the result works | 0 added; skips the usual synthesis request |
| `write_file` → `npm run build` succeeds | `passed`, with the exact command retained as evidence | 0 added |
| `write_file` → build → another `write_file` | `not_run`; the earlier build is rejected as stale evidence | 0 added |
| `write_file` → `npm test` fails | `failed`; no success claim is generated | 0 added; skips synthesis |

`lib/agent/__tests__/verification.test.ts` proves all four cases and proves
the no-evidence path makes **no** model-gateway synthesis call. This is a
deliberate quality/rate-limit win rather than an additional verification model
loop. The agent still needs an approved plan step and browser workspace to run
the actual check; this guard guarantees that absence of that step is visible,
not disguised as success.

## Current staged interface experiment

`TRION_EXHAUSTIVE_BUILD_TEST` is a temporary diagnostic workflow for answering a
specific question: does separating implementation from a dedicated visual polish
pass materially improve a generated interface? It is enabled by default only in
local development and can be disabled with `TRION_EXHAUSTIVE_BUILD_TEST=0`.
Production remains on the normal rate-efficient path; `=1` enables the experiment
explicitly in another environment.

For interface requests, the plan normalizer requires traceable stages in this
order: inspect an available entry point, implement, make a dedicated
hierarchy/responsiveness/interaction-state polish pass, then verify with a
build or development server. It never moves dependency-install commands after
the work that needs them. Each execution decision receives a compact reminder
to complete only its current stage against the actual preceding tool result.

Live plan-mode evidence (local API, 2026-08-03): “Build a polished marketing
landing page for a creative studio” produced six visible steps: inspect,
components, app composition, responsive interaction styling, document metadata,
and dev-server preview. No browser tool executed in that proof. Its policy adds
no provider call; plan mode used the normal classification, planning, and
plan-only synthesis calls.

The first live browser execution of that six-stage task completed the two
inspection stages and the authoring stage, then exposed a provider-decision
latency failure before the polish action was emitted. That is deliberately not
recorded as a successful design test. The old queue could retry a timed-out
decision five times at 120 seconds each, leaving the browser apparently active
for around ten minutes. Call-type reliability budgets now bound that exact
failure to two 30-second execution-decision attempts. If the response stream
ends without a terminal event, the composer now recovers with an actionable
error instead of remaining disabled. This change adds **zero** RPM or tokens on
successful turns and lowers failure-path RPM by up to three model requests.

The isolated repeat proved a second form of the same user-facing failure: after
three successful tool calls, a server stream could stay open while emitting no
further event. The composer now has a 105-second **silent-stream** watchdog —
longer than the bounded planning retry window — which aborts only a completely
quiet response and unlocks the UI with an honest “paused” recovery message.
It adds **0** requests and **0** tokens; its tradeoff is deliberately ending a
pathological silent turn rather than pretending it is still making progress.

The trace also uncovered a state-loss defect: when an execution-decision call
failed before a tool call, `executeSteps()` threw before handing its earlier
successful trace rows back to the orchestrator. Error synthesis then claimed
that already-completed inspection had never happened. Decision failures are now
recorded as an explicit `model_decision` trace error and returned with all prior
evidence; a regression test proves this path. The normal UI-quality diagnostic
also right-sizes authoring output to 2,800 tokens and tries its first
full-file pass without hidden reasoning. Its first approved UI write now uses a
small write-only static prompt, less than half the normal author-prompt token
estimate; normal requests and every retry retain the full safety and recovery
prompt. The fallback remains reasoning-enabled when the first response is
malformed or incoherent. These changes add no normal RPM request; they reduce
input/output reservation and failure-path duplicate authoring requests.

Long provider calls now receive a 15-second heartbeat carrying the current,
already-emitted pipeline status. It does not represent a tool call, plan step,
or model progress that did not occur. A stalled local run still reached the
client watchdog without a delivered heartbeat, so this is code- and
regression-verified but not yet counted as a successful stream-delivery proof.
The watchdog remains the honest recovery path until that browser proof passes.

A fresh repeat then failed before authoring with the sandbox worker's own
`33/32` request-cap message. The trace truthfully reported that no files had
been modified; this is not counted as an agent-design result. Diagnosis found
that each disposable browser document prewarms a worker and prior reload/close
paths did not release it. The workspace container now tears down on a genuine
`pagehide` (but retains a bfcache-restored page), preventing refreshes from
accumulating detached workers. This has no model-rate cost. The test harness
tab created for that failed check was then closed; no other browser tab was
touched.

Fresh browser lifecycle evidence after the change: boot overlay, composer
input, send enablement, New thread, page refresh, and post-refresh input all
remained operable. The local test observed a cleared composer and enabled Send
button after typing in both a new thread and a refreshed page.

## Recent safety and efficiency checks

- The five-consecutive-429 circuit is pure and regression-tested; it opens for
  60 seconds only after the fifth sequential rate-limit response, and any other
  provider result resets the sequence.
- Secret paths (`.env`, `.env.local`, `secrets/`, `.aws/`, private-key formats)
  and direct `curl`/`wget`/SSH-style utilities are rejected before client
  execution. `.env.example` stays readable as a checked-in template.
- A 500-line read returns 80 lines of head, 80 of tail, total-line metadata,
  and an instruction to request a focused range; a requested 210–215 range
  returns exactly those six lines.
- Verified unused deployable assets removed: the two obsolete public boot videos
  and an unused public brand JPEG. The original source video and design
  references remain. TypeScript incremental state now lives under `.next/cache`
  instead of the repository root.

## Known architectural boundary

Filesystem and command tools run in the browser-owned WebContainer. A server
request made without an active Trion browser tab cannot execute those tools. It
now fails quickly and tells the user how to recover. Removing that dependency
would require moving the workspace sandbox server-side, which is a separate
architecture and security project, not a prompt change.
