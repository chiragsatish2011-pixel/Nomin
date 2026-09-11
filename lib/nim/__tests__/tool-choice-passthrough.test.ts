// Task 0: prove `tools` / `tool_choice` are passed through to the
// OpenAI-compatible provider body, and that tool_calls responses surface.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FetchMock = ReturnType<typeof vi.fn>;

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

const TOOL = {
  type: "function",
  function: {
    name: "emit_plan",
    description: "Emit the build plan",
    parameters: { type: "object", properties: { plan_summary: { type: "string" } } },
  },
} as const;

beforeEach(() => {
  process.env = {
    ...ORIGINAL_ENV,
    TRION_API_KEY: "hosted-test-key",
    TRION_BASE_URL: "https://unit.test/v1",
    // No GEMINI_* keys: non-plan labels route hosted anyway; keep it explicit.
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

describe("tool_choice passthrough on the OpenAI-compatible route", () => {
  it("sends tools + tool_choice verbatim when provided", async () => {
    const fetchMock: FetchMock = vi.fn();
    fetchMock.mockResolvedValue(
      okResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { queuedTextCompletion } = await import("../internal-client");

    await queuedTextCompletion([{ role: "user", content: "hi" }], 64, {
      label: "toolchoice-proof",
      timeoutMs: 5_000,
      maxAttempts: 1,
      tools: [TOOL as unknown as never],
      toolChoice: { type: "function", function: { name: "emit_plan" } },
    });

    const sentBody = fetchMock.mock.calls[0]?.[1]?.body;
    expect(sentBody).toBeDefined();
    const body = JSON.parse(String(sentBody));
    expect(body.tools).toEqual([TOOL]);
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "emit_plan" } });
  });

  it("omits both keys when the caller has no opinion (byte-identical bodies)", async () => {
    const fetchMock: FetchMock = vi.fn();
    fetchMock.mockResolvedValue(
      okResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { queuedTextCompletion } = await import("../internal-client");

    await queuedTextCompletion([{ role: "user", content: "hi" }], 64, {
      label: "toolchoice-proof",
      timeoutMs: 5_000,
      maxAttempts: 1,
    });

    const sentBody = fetchMock.mock.calls[0]?.[1]?.body;
    expect(sentBody).toBeDefined();
    const body = JSON.parse(String(sentBody));
    expect("tools" in body).toBe(false);
    expect("tool_choice" in body).toBe(false);
  });

  it("surfaces tool_calls as text instead of throwing empty-response", async () => {
    globalThis.fetch = (async () =>
      okResponse({
        choices: [{
          message: {
            content: "",
            tool_calls: [{ id: "1", type: "function", function: { name: "emit_plan", arguments: '{"a":1}' } }],
          },
          finish_reason: "tool_calls",
        }],
      })) as unknown as typeof fetch;
    const { queuedTextCompletion } = await import("../internal-client");

    const text = await queuedTextCompletion([{ role: "user", content: "hi" }], 64, {
      label: "toolchoice-proof",
      timeoutMs: 5_000,
      maxAttempts: 1,
      tools: [TOOL as unknown as never],
      toolChoice: { type: "function", function: { name: "emit_plan" } },
    });
    expect(text).toContain("emit_plan");
  });

  it("still throws empty-response when content is empty without tool_calls", async () => {
    globalThis.fetch = (async () =>
      okResponse({ choices: [{ message: { content: "" }, finish_reason: "stop" }] })) as unknown as typeof fetch;
    const { queuedTextCompletion } = await import("../internal-client");

    await expect(
      queuedTextCompletion([{ role: "user", content: "hi" }], 64, {
        label: "toolchoice-proof",
        timeoutMs: 5_000,
        maxAttempts: 1,
      }),
    ).rejects.toThrow(/empty response/);
  });
});
