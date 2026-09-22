# Trion codebase map

Use this map to find the right layer before changing a file.

## Runtime layers

- `app/` — Next.js routes and browser UI.
  - `app/page.tsx` — the conversation shell: sidebar, transcript, composer, session switching, and stream handling.
  - `app/chat.css` — the shell's stylesheet; `app/globals.css` holds the theme tokens and everything else.
  - `app/components/` — reusable UI: preview, artifacts, trace, auth, theme, and mascot.
  - `app/lib/workspace-container.ts` — the browser-owned WebContainer and preview lifecycle.
  - `app/hooks/useWebContainerExecutor.ts` — browser-to-server tool-result bridge.
  - `app/api/trion/` — HTTP endpoints for chat, cancellation, approvals, tool results, usage, and capacity.
- `lib/agent/` — provider-independent agent contract.
  - `orchestrator/state-machine.ts` — turn stages, checkpoint resume, cancellation, and final output.
  - `intent/` — classification and clarification decisions.
  - `planner/` — plan generation and plan normalization.
  - `executor/` — step decisions, tool calls, retries, coherence, and verification.
  - `synthesis/` and `output/` — evidence-based final response construction, including the streamed conversational answer.
  - `quality-chain.ts` — selective coding/design critic chain.
  - `session-store.ts` and `task-state.ts` — bounded conversation memory and durable-in-process checkpoints.
- `lib/nim/` — provider transport and capacity controls.
  - `internal-client.ts` — the one provider lane: request queue, SSE streaming, retries, timeouts, and usage accounting.
  - `single-key.ts` and `rate-governor.ts` — the single credential's request budget and leases.
  - `circuit-breaker.ts` — fail fast after repeated upstream failures.
  - `byok-context.ts` — isolated user-provider context.
- `public/` — runtime assets only: favicon, fonts, and brand assets.

## Verification and diagnostics

- `lib/**/__tests__/` — product unit/regression tests.
- `bench/` — live benchmark drivers and suites; generated output belongs in `bench/results/`.
- `eval/` — component, security, trajectory, judge, and online evaluation runners; generated output belongs in `eval/results/`.
- `docs/` — architecture, system reports, and this map. Do not put secrets or generated JSON here.
- `references/` — design research and visual references; not runtime code.

## Safe change rules

1. Change the agent contract in `lib/agent/` before changing UI interpretations of its events.
2. Change provider routing only in `lib/nim/`; never add provider selection logic to `app/page.tsx`.
3. Keep WebContainer operations in `app/lib/workspace-container.ts`; the server cannot touch the browser filesystem directly.
4. Keep generated caches and reports out of commits. `.next`, `node_modules`, `.env*`, `bench/results`, and `eval/results` are ignored.
5. Run `npm run lint`, `npx vitest run`, and `npm run build` after structural changes.
