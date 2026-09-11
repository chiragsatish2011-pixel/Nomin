# Trion Repair Report — Engineering Audit + Fixes (2026-09-11)

Branch: `main`. Method: forensics → baseline → narrow scoped fixes, each verified
by typecheck + lint + tests (+ production build at the end). No blind rewrites;
no safety control removed; no test weakened (fixtures were corrected to the
new contract, assertions only added).

Baseline (before fixes): `tsc` clean, `eslint` clean, vitest **59 files / 519
tests pass**, `next build` clean — after unblocking the runner (see B7).

Final validation: `tsc` clean, `eslint` clean, vitest **59 files / 539 tests
pass**, `next build` clean with routes `/`, `/capacity`, `/connections` and all
`/api/*` routes. No `/login` route exists.

## A. Architecture map (as built, not as documented)

```
Browser UI (app/page.tsx: NDJSON stream, approval gate UI, queue-while-busy)
  → POST /api/trion/chat → parseChatRequest → runTurn (state-machine.ts)
    → Step 0 input (input.ts: snapshot/attachment sensitivity filtering)
    → Step 1 intent (intent/classifier.ts: grammar + model, direct_fast_path)
    → Step 2 plan (planner/generator.ts: 5-step plan + ensureVerificationStep)
    → Step 2.5 approval gate (bridge.ts: plan-hash-bound, 10-min hard pause)
    → Step 3 execute (executor/step-runner.ts: contract + coherence + retry×2)
        → tool-runner.ts (validation) → bridge.emit tool_call+execution_id
        → browser WebContainer (workspace-container.ts) → POST tool-result
    → Step 4 synthesis (synthesis/generator.ts: gated + grounded)
    → Step 5 output (output/builder.ts: contract + leak check)
Model gateway (model-gateway.ts) → queue (internal-client.ts) → key-pool,
rate-governor (40 RPM AIMD), circuit-breaker, hosted↔Gemini routing + BYOK.
```

Supporting: token-ledger (measurement), capacity/usage routes, session-store
(TTL + compaction), task-state, turn-control (cancel), quality-chain (critic),
eval/ + bench/ harnesses.

## B. Bug register (confirmed, fixed, regression-tested)

| # | File:line | Problem | Fix | Test |
|---|---|---|---|---|
| B1 | `step-runner.ts:673` | `isValidAgentTurn` accepted `done:true` with no `summary`; synthesis fell back to generic text | Require non-empty summary when done; precise retry message | `step-action-contract.test.ts` +3 |
| B2 | `planner/generator.ts:195` | `VALID_TOOLS` allowed `finish` plan steps (prompt never offers it) → terminator with no work | Removed; coerces to null non-tool step | `regressions.test.ts` +1 |
| B3 | `model-gateway.ts:329`, `sanitize.ts` | Sanitizer rewrote vendor substrings **inside `write_file` code bodies** — disk bytes differed from authored bytes (e.g. a Gemini SDK integration) | `sanitizeToolInput`: code bodies byte-exact; prose still scrubbed | `sanitize.test.ts` +5 |
| B4 | `sanitize.ts:140` | `assertNoLeaks` error echoed `pattern.source` (the banned strings) | Rule index instead of source | `sanitize.test.ts` +1 |
| B5 | `output/builder.ts:40` | Whole-output leak assert would throw on legitimate SDK names in user code | `assertNoLeaksInOutput`: prose checked, code bodies exempt | `sanitize.test.ts` +1 |
| B6 | `internal-client.ts:325` | Hosted transport cap 120s truncated the promised 180s authoring call; Gemini honored 180s (60s route divergence) | Default cap 180000 (env override wins) | existing deadline tests pass |
| B7 | `package-lock` (vite 8.2.0→8.3.0) | Rolldown `UNRESOLVED_ENTRY` — **no** vitest config could load on Windows, suite unrunnable | `npm update vite` (within range) | suite runs: 59/539 |
| B8 | `step-runner.ts:667` | Hard-ceiling timeout ("operation exceeded") not fast-failed → 2× wasted decisions + waits | Regex covers both bridge messages | covered by fast-fail path |
| B9 | `bridge.ts:108`, `tool-result/route.ts:29` | Partial results (`ok`+`output` only) entered trace as success; wrong-step results silently re-labeled | `validateToolResultShape`, step binding at registration, fail-fast consume+reject, route delegates to bridge | `bridge.test.ts` +6, fixtures fixed |
| B10 | `bridge.ts:150`, `state-machine.ts:521`, `approval/route.ts`, `page.tsx:816,1242` | Approval bound to session only: replayable across plans, no mismatch detection | `hashPlan` binding end-to-end (event → client echo → resolve check; mismatch keeps gate open) | `bridge.test.ts` +4 |
| B11 | `verification.ts:22` | `npm run dev` success stamped `passed` — process start presented as proof | New `started` status (preview live, unproven); gates treat as honest-final, review requires `passed` | `verification.test.ts` +2 |
| B12 | `useWebContainerExecutor.ts:180` | Result POST gave up after ~2.5s → confirmed work lost on longer blips | 6 attempts, ~11s window (inside 45s bridge budget) | — (client path, build-verified) |
| B13 | `page.tsx:794` | Stop left queued messages; next turn fired a "cancelled" follow-up | Stop clears queue + approval hash | — (client path) |
| B14 | `workspace-container.ts:182` | Dead ternary always emitted `ready`, masking install failure (+ non-zero exit only logged) | Failure keeps `error` status with message | — (client path, tsc/lint) |
| B15 | `workspace-container.ts:358` | `search_codebase` returned secret-file contents, bypassing the `read_file` block | Skip sensitive paths in client search (listing unchanged; server already filters snapshots) | tsc/lint; server tests green |
| B16 | `.env.example` | Hosted lane undocumented (fresh clone unusable); old Gemini timeout example (60s) would reintroduce truncation | Full template with correct defaults | — |
| B17 | `package.json` | Runtime deps pinned `latest` (non-reproducible) | Pinned to verified `^` ranges; added `test`/`typecheck` scripts | full suite + build |
| B18 | `eval/README.md:12,31` | Stale absolute macOS path | Portable placeholder | — |
| B19 | Login remnants | `.firebaserc`, empty `app/login/`, Firebase + dead keys in local `.env` (code files were already deleted) | Removed; verified no `/login` route, zero firebase/auth imports | build route table |

## C. Security register (trust boundaries)

1. **Browser→server tool results**: now shape-validated + step-bound + one-shot (replay → 404) + 45s idle/180s hard expiry. Server pending record authoritative.
2. **Approval gate**: session-keyed + plan-hash-bound; mismatch/duplicate/expired/cross-session rejected; timeout → cancel.
3. **Paths/commands**: server allow-list validation (POSIX-relative, no traversal, sensitive-path block, no shell operators, no network utilities); client search excludes secrets; snapshots/attachments filtered at input.
4. **Identity boundary**: prose scrubbed + asserted; code bodies exempt (integrity over cosmetics); error messages carry no vendor strings.
5. **Provider keys**: server-side only, never in `NEXT_PUBLIC_*`; redacted telemetry; BYOK per-tab session storage.
6. **Known limitation**: remote `git` URL in local git config contains a token (pre-existing; rotate it — see Risks).

## D. Performance register

- Authoring: single 180s attempt (no duplicate generation); decision budgets unchanged (30–45s, 1–2 attempts); queue pacing 1.6s/start under 40 RPM AIMD governor; priority classification-first.
- Saved model calls (preserved from base): deterministic inspection turn, deterministic sandbox verification command, deterministic failure synthesis, review gates requiring `passed`.
- Client delivery window widened (~2.5s→~11s) with zero extra model cost.

## E. Capability matrix

WORKING: intent classification, bounded planning, risk approval (now bound),
contract-enforced execution, WebContainer tools + preview, bridge (race-free,
heartbeat, fail-fast), verification (honest statuses), grounded synthesis,
retry/cancel propagation, rate/circuit/BYOK, local sessions + compaction.
PARTIAL: verification proves startup vs correctness (no browser-asserted route
checks yet); workspace re-observation (snapshot + deterministic reads only).
NOT IMPLEMENTED (by product design, unchanged): one-click deploy, email
feedback, cross-device sync, login/Firebase (removed per request).

## F. Change summary

22 source/test/config files changed, all narrowly scoped (see B-register).
Login system fully removed (code was already deleted; remnants cleared).
No architecture replaced; no safety control removed; strictness only added
with fail-fast precise errors.

## G. Validation summary

- `tsc --noEmit`: PASS (before and after).
- `eslint .`: PASS.
- `vitest run`: 59 files / 519 pass (baseline) → **59 / 539 pass** (20 new tests).
- `next build`: PASS; routes `/`, `/capacity`, `/connections`, 10 API routes; no `/login`.
- Live model/bridge journeys (15-item user-journey list) were NOT run — no
  provider budget was spent; guarded by unit coverage + build.

## H. Remaining risks (not hidden)

1. **State is process-local** (`globalThis` maps): safe for single-process
   dev/self-host; multi-instance deployment needs the store abstraction
   (Phase 5) — documented, not implemented.
2. **No write-time re-observation**: a `write_file` timeout retries without
   first reading the file (partial-write double-apply possible).
3. **Command filter is regex-based** (`env`-printing not blocked): accepted —
   the sandbox holds no provisioned secrets (keys never enter the container).
4. **Remote URL embeds a token** (`git remote -v` shows `ghp_...`): rotate the
   token and switch to credential-helper storage.
5. **Long-horizon adversarial memory tests** and **live end-to-end journeys**
   still to be run with provider budget.
6. **Vite 8.3.0** was required for the Windows config-load bug (upstream);
   lockfile updated accordingly.
