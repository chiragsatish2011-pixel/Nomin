// REPRODUCTION + REGRESSION: the Step 3 stall.
//
// Every prior "fix" for this stall asserted a CONSTANT (see
// model-reliability.test.ts) rather than driving the real dispatch queue, which
// is why the stall kept passing review and kept coming back. These tests drive
// `queuedCompletion` end to end against a mocked provider so the actual failure
// is observable.
//
// The defect: `opts.timeoutMs` only ever armed an AbortController around the
// in-flight `fetch`. It never bounded
//   (a) time a task spends waiting in the queue,
//   (b) provider-directed `retry-after` backoff, which is deliberately uncapped,
//   (c) route-fallback hops, each of which restarts the per-attempt budget.
// So a call declaring a 30s budget could legitimately stay pending for minutes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FetchMock = ReturnType<typeof vi.fn>;

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

/** The pools are memoised on globalThis, so a fresh module registry is not
 *  enough on its own — the cached pools must be dropped too. */
function resetProviderState() {
  const store = globalThis as Record<string, unknown>;
  delete store.__trionKeyPool;
  delete store.__trionGeminiPool;
  vi.resetModules();
}

function rateLimitedResponse(retryAfterSeconds: number): Response {
  return {
    ok: false,
    status: 429,
    headers: {
      forEach(callback: (value: string, key: string) => void) {
        callback(String(retryAfterSeconds), "retry-after");
      },
    },
    text: async () => JSON.stringify({ error: { message: "rate limit exceeded" } }),
  } as unknown as Response;
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

/** A valid Gemini-shaped success carrying a schema-valid AgentTurn. */
function geminiTurn(): Response {
  return okResponse({
    choices: [{
      message: { content: JSON.stringify({ thought: "ok", action: "read_file", action_input: { path: "a.ts" }, done: false }) },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
}

/** Resolves to "pending" if the promise has not settled inside `ms`. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<"settled" | "pending"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sentinel = new Promise<"pending">((resolve) => {
    timer = setTimeout(() => resolve("pending"), ms);
  });
  const outcome = await Promise.race([
    promise.then(() => "settled" as const).catch(() => "settled" as const),
    sentinel,
  ]);
  if (timer) clearTimeout(timer);
  return outcome;
}

beforeEach(() => {
  process.env = {
    ...ORIGINAL_ENV,
    TRION_API_KEY: "hosted-test-key",

    // Remove dispatch pacing so the test measures the deadline, not the pacer.
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

describe("model dispatch has a real end-to-end deadline", () => {
  it("settles an execution decision within its declared budget when every route is rate-limited with a long retry-after", async () => {
    // Both routes answer 429 with a two-minute provider-directed backoff. This
    // is the exact real-world condition behind the recurring Step 3 stall: a
    // shared free-tier allowance answering with a long cooldown.
    const fetchMock: FetchMock = vi.fn(async () => rateLimitedResponse(120));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { queuedCompletion } = await import("../internal-client");

    const call = queuedCompletion([{ role: "user", content: "decide" }], 256, {
      label: "execution_decision",
      // A deliberately small budget so the assertion is fast. The property under
      // test is scale-free: the call must not outlive its own declared budget.
      timeoutMs: 300,
      maxAttempts: 2,
      deadlineMs: 1_000,
    });
    // Prevent an unhandled rejection while we observe pending-ness.
    const guarded = call.catch(() => "rejected");

    // Declared budget is 2 attempts x 300ms. Anything still pending at 2.5s has
    // escaped its budget entirely — the stall.
    expect(await settlesWithin(guarded, 2_500)).toBe("settled");

    await expect(call).rejects.toThrow();
  });

  it("does not let an uncapped provider retry-after hold a turn open indefinitely", async () => {
    // One hour of provider-directed backoff. `retryDelayMs` intentionally does
    // not cap a server-specified delay, which is correct for politeness but must
    // never translate into an unbounded user-facing wait.
    const fetchMock: FetchMock = vi.fn(async () => rateLimitedResponse(3_600));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { queuedCompletion } = await import("../internal-client");

    const call = queuedCompletion([{ role: "user", content: "decide" }], 256, {
      label: "execution_decision",
      timeoutMs: 300,
      maxAttempts: 2,
      deadlineMs: 1_000,
    });
    const guarded = call.catch(() => "rejected");

    expect(await settlesWithin(guarded, 2_500)).toBe("settled");
    await expect(call).rejects.toThrow(/limit|capacity|retry/i);
  });

  it("does not queue behind a cooled build lane once its daily quota is spent", async () => {
    // THE REAL PRODUCTION CONDITION, reproduced.
    //
    // The build lane's free tier is a DAILY request quota (measured live: 20
    // requests/day/model, answering RESOURCE_EXHAUSTED with no `retry-after`
    // header). Once spent, every remaining call that day finds the pool cooling.
    // The pool cools for 60s on a 429, so each subsequent execution decision used
    // to wait out a full minute before failing over to a hosted route that was
    // healthy and idle the whole time — and, worse, `pump` returned while that
    // task was blocked, freezing every unrelated hosted call behind it.
    const seen: string[] = [];
    const fetchMock: FetchMock = vi.fn(async (url: unknown) => {
      const href = String(url);
      seen.push(href.includes("generativelanguage") ? "gemini" : "hosted");
      if (href.includes("generativelanguage")) return rateLimitedResponse(0);
      return okResponse({
        choices: [{
          message: { content: JSON.stringify({ thought: "hosted", action: "read_file", action_input: { path: "c.ts" }, done: false }) },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { queuedCompletion } = await import("../internal-client");

    // First call spends the lane and cools the pool.
    await queuedCompletion([{ role: "user", content: "first" }], 256, {
      label: "execution_decision", timeoutMs: 2_000, maxAttempts: 2, deadlineMs: 8_000,
    });

    // The next decision must NOT sit out the cooldown: the hosted route is ready.
    const started = Date.now();
    const turn = await queuedCompletion([{ role: "user", content: "second" }], 256, {
      label: "execution_decision", timeoutMs: 2_000, maxAttempts: 2, deadlineMs: 8_000,
    });
    const elapsed = Date.now() - started;

    expect(turn.action).toBe("read_file");
    // Comfortably under the 60s pool cooldown that used to be paid per step.
    expect(elapsed).toBeLessThan(3_000);
    // And it must not have burned another doomed request on the cooled lane.
    expect(seen.slice(2)).not.toContain("gemini");
  });

  it("does not let one blocked build call freeze unrelated hosted work", async () => {
    // Head-of-line blocking: `pump` selected the single highest-priority ready
    // task and RETURNED if it could not get a key, so one cooled build key
    // stalled the whole queue — including the classification call that gates the
    // user's first visible feedback.
    const fetchMock: FetchMock = vi.fn(async (url: unknown) => {
      if (String(url).includes("generativelanguage")) return rateLimitedResponse(0);
      return okResponse({
        choices: [{ message: { content: "classified" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { queuedCompletion, queuedTextCompletion } = await import("../internal-client");

    // Cool the build pool first.
    await queuedCompletion([{ role: "user", content: "spend" }], 256, {
      label: "execution_decision", timeoutMs: 2_000, maxAttempts: 2, deadlineMs: 8_000,
    }).catch(() => undefined);

    // A build-routed call that cannot run, enqueued at HIGHER priority (lower
    // number) than the hosted classification behind it.
    const blocked = queuedCompletion([{ role: "user", content: "blocked" }], 256, {
      label: "execution_decision", priority: 0, timeoutMs: 2_000, maxAttempts: 1, deadlineMs: 8_000,
    }).catch(() => "failed");

    const started = Date.now();
    const classification = await queuedTextCompletion([{ role: "user", content: "classify" }], 64, {
      label: "classification", priority: 9, timeoutMs: 2_000, maxAttempts: 1, deadlineMs: 8_000,
    });
    const elapsed = Date.now() - started;

    expect(classification).toBe("classified");
    expect(elapsed).toBeLessThan(3_000);
    await blocked;
  });

  it("still completes a healthy call well inside the deadline", async () => {
    // The deadline must not become a new failure source on the happy path.
    const fetchMock: FetchMock = vi.fn(async () => geminiTurn());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { queuedCompletion } = await import("../internal-client");

    const turn = await queuedCompletion([{ role: "user", content: "decide" }], 256, {
      label: "execution_decision",
      timeoutMs: 5_000,
      maxAttempts: 2,
      deadlineMs: 10_000,
    });

    expect(turn.action).toBe("read_file");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cuts off a response that starts arriving but never finishes", async () => {
    // A DIFFERENT failure mode from a hung request: headers arrive, the request
    // looks healthy, and the body then trickles forever. The per-attempt timer
    // must still be armed while the body is being read — it is cleared in a
    // `finally`, after `response.json()`, precisely so this case is covered.
    const fetchMock: FetchMock = vi.fn(async (_url: unknown, init?: { signal?: AbortSignal }) => ({
      ok: true,
      status: 200,
      headers: { forEach() {} },
      // Never resolves on its own; only the abort signal ends it.
      json: () => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      }),
      text: async () => "",
    })) as unknown as FetchMock;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { queuedCompletion } = await import("../internal-client");

    const call = queuedCompletion([{ role: "user", content: "decide" }], 256, {
      label: "execution_decision",
      timeoutMs: 1_000,
      maxAttempts: 1,
      deadlineMs: 3_000,
    });

    await expect(call).rejects.toThrow(/timed out|could not complete/i);
  });

  it("falls back to the hosted route and succeeds there when the build route is exhausted", async () => {
    // Guaranteed fallback: Gemini 429s, hosted answers. The user must get a real
    // result, not a stall and not an error.
    const fetchMock: FetchMock = vi.fn(async (url: unknown) => {
      const href = String(url);
      if (href.includes("generativelanguage")) return rateLimitedResponse(120);
      return okResponse({
        choices: [{
          message: { content: JSON.stringify({ thought: "hosted", action: "read_file", action_input: { path: "b.ts" }, done: false }) },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { queuedCompletion } = await import("../internal-client");

    const turn = await queuedCompletion([{ role: "user", content: "decide" }], 256, {
      label: "execution_decision",
      timeoutMs: 2_000,
      maxAttempts: 2,
      deadlineMs: 8_000,
    });

    expect(turn.action).toBe("read_file");
    expect((turn.action_input as { path?: string }).path).toBe("b.ts");
  });
});
