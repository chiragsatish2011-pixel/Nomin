// REGRESSION: Stop must reach a model call, not just the gaps between steps.
//
// The turn's AbortSignal previously stopped at the orchestrator. `runTurn`
// checked it between stages, so a Stop pressed DURING an execution decision (up
// to 180s for full-file authoring) did nothing until that call returned on its
// own. These tests drive the real queue and assert cancellation is observed
// both in flight and while queued.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

function resetProviderState() {
  const store = globalThis as Record<string, unknown>;
  delete store.__trionKeyPool;
  delete store.__trionGeminiPool;
  vi.resetModules();
}

function okResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { forEach() {} },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response;
}

beforeEach(() => {
  process.env = {
    ...ORIGINAL_ENV,
    TRION_API_KEY: "hosted-test-key",
    TRION_MIN_INTERVAL_MS: "0",
    TRION_RPM_LIMIT: "1000",
  };
  resetProviderState();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
  resetProviderState();
  vi.restoreAllMocks();
});

describe("Stop reaches model calls", () => {
  it("aborts a call that is already in flight", async () => {
    // A provider that never answers until aborted — the shape of a hung request.
    let abortRequest: (() => void) | undefined;
    globalThis.fetch = ((_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        abortRequest = () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };
        signal?.addEventListener("abort", () => abortRequest?.(), { once: true });
      })) as unknown as typeof fetch;

    const { queuedCompletion } = await import("../internal-client");

    const controller = new AbortController();
    const call = queuedCompletion([{ role: "user", content: "work" }], 256, {
      label: "execution_decision",
      timeoutMs: 60_000,
      maxAttempts: 1,
      deadlineMs: 60_000,
      signal: controller.signal,
    });

    // Give the pump a tick to actually dispatch before cancelling.
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();

    await expect(call).rejects.toThrow(/cancelled/i);
  });

  it("cancels a call that is still queued behind a cooled key", async () => {
    // Never dispatched at all: the previous design could only observe Stop at a
    // checkpoint, so a queued call stayed pending until its own timeout.
    globalThis.fetch = (async () => okResponse({
      choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
    })) as unknown as typeof fetch;

    const { queuedCompletion } = await import("../internal-client");

    const controller = new AbortController();
    controller.abort(); // already stopped before the call is even made

    const call = queuedCompletion([{ role: "user", content: "work" }], 256, {
      label: "execution_decision",
      timeoutMs: 30_000,
      maxAttempts: 2,
      deadlineMs: 30_000,
      signal: controller.signal,
    });

    await expect(call).rejects.toThrow(/cancelled/i);
  });

  it("inherits the ambient turn signal when no explicit signal is passed", async () => {
    // The property that makes this hold for call sites that never opted in:
    // classification, planning, synthesis and the review roles pass no signal.
    let abortRequest: (() => void) | undefined;
    globalThis.fetch = ((_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        abortRequest = () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };
        signal?.addEventListener("abort", () => abortRequest?.(), { once: true });
      })) as unknown as typeof fetch;

    const { queuedCompletion } = await import("../internal-client");
    const { withTurnSignal } = await import("@/lib/agent/turn-control");

    const controller = new AbortController();

    // Wrapped so the ambient context is established for the ENQUEUE without this
    // test awaiting the very promise it is about to cancel.
    const { call } = await withTurnSignal(controller.signal, async () => ({
      // No `signal` in the options — exactly like classifyIntent/generatePlan.
      call: queuedCompletion([{ role: "user", content: "classify" }], 256, {
        label: "classification",
        timeoutMs: 60_000,
        maxAttempts: 1,
        deadlineMs: 60_000,
      }),
    }));

    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();

    await expect(call).rejects.toThrow(/cancelled/i);
  });
});
