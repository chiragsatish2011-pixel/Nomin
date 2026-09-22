// Token streaming on the OpenAI-compatible and Anthropic routes.
//
// The property under test is the one the user feels: text reaches the caller
// WHILE the model is generating, in order, exactly once, with nothing visible
// that the non-streaming path would have removed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

function resetProviderState() {
  const store = globalThis as Record<string, unknown>;
  delete store.__trionKeyPool;
  vi.resetModules();
}

/** A Response whose body streams the given SSE frames, one chunk per frame. */
function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    ok: true,
    status: 200,
    headers: { forEach() {} },
    body: {
      getReader() {
        return {
          async read() {
            if (index >= frames.length) return { done: true, value: undefined };
            return { done: false, value: encoder.encode(frames[index++]) };
          },
          releaseLock() {},
        };
      },
    },
  } as unknown as Response;
}

const openAiFrame = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

beforeEach(() => {
  process.env = {
    ...ORIGINAL_ENV,
    TRION_API_KEY: "hosted-test-key",
    TRION_BASE_URL: "https://unit.test/v1",
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

describe("streamed completions", () => {
  it("asks the provider to stream only when a delta sink is supplied", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([openAiFrame("hi"), "data: [DONE]\n\n"]));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { queuedTextCompletion } = await import("../internal-client");

    await queuedTextCompletion([{ role: "user", content: "hello" }], 64, { onDelta: () => {} });
    const streamedBody = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(streamedBody.stream).toBe(true);
    expect(streamedBody.stream_options).toEqual({ include_usage: true });
  });

  it("leaves a non-streaming call byte-identical to before", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { forEach() {} },
      json: async () => ({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
      text: async () => "",
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { queuedTextCompletion } = await import("../internal-client");

    await queuedTextCompletion([{ role: "user", content: "hello" }], 64, {});
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.stream).toBeUndefined();
    expect(body.stream_options).toBeUndefined();
  });

  it("delivers every delta in order and returns the assembled text", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      sseResponse([
        openAiFrame("Hello"),
        openAiFrame(", "),
        openAiFrame("world"),
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3 } })}\n\n`,
        "data: [DONE]\n\n",
      ]),
    ) as unknown as typeof fetch;
    const { queuedTextCompletion } = await import("../internal-client");

    const chunks: string[] = [];
    const text = await queuedTextCompletion([{ role: "user", content: "hi" }], 64, {
      onDelta: (chunk) => chunks.push(chunk),
    });
    expect(chunks.join("")).toBe("Hello, world");
    expect(text).toBe("Hello, world");
  });

  it("reassembles a frame split across chunk boundaries", async () => {
    const frame = openAiFrame("split");
    globalThis.fetch = vi.fn().mockResolvedValue(
      sseResponse([frame.slice(0, 12), frame.slice(12), "data: [DONE]\n\n"]),
    ) as unknown as typeof fetch;
    const { queuedTextCompletion } = await import("../internal-client");

    const chunks: string[] = [];
    await queuedTextCompletion([{ role: "user", content: "hi" }], 64, { onDelta: (c) => chunks.push(c) });
    expect(chunks.join("")).toBe("split");
  });

  it("never streams reasoning that the model wrapped in <think>", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      sseResponse([
        openAiFrame("<thi"),
        openAiFrame("nk>deliberating about the answer</think>"),
        openAiFrame("the answer"),
        "data: [DONE]\n\n",
      ]),
    ) as unknown as typeof fetch;
    const { queuedTextCompletion } = await import("../internal-client");

    const chunks: string[] = [];
    await queuedTextCompletion([{ role: "user", content: "hi" }], 64, { onDelta: (c) => chunks.push(c) });
    expect(chunks.join("")).toBe("the answer");
    expect(chunks.join("")).not.toContain("deliberating");
  });

  it("skips a malformed data line instead of failing the call", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      sseResponse([openAiFrame("good"), "data: {not json\n\n", openAiFrame(" text"), "data: [DONE]\n\n"]),
    ) as unknown as typeof fetch;
    const { queuedTextCompletion } = await import("../internal-client");

    const text = await queuedTextCompletion([{ role: "user", content: "hi" }], 64, { onDelta: () => {} });
    expect(text).toBe("good text");
  });

  it("reports the streamed usage block to the ledger sink", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      sseResponse([
        openAiFrame("x"),
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 40, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 5 } } })}\n\n`,
        "data: [DONE]\n\n",
      ]),
    ) as unknown as typeof fetch;
    const { queuedTextCompletion } = await import("../internal-client");

    const usage: Array<{ promptTokens: number; completionTokens: number; cachedPromptTokens: number }> = [];
    await queuedTextCompletion([{ role: "user", content: "hi" }], 64, {
      onDelta: () => {},
      onUsage: (u) => usage.push(u),
    });
    expect(usage[0]).toMatchObject({ promptTokens: 40, completionTokens: 7, cachedPromptTokens: 5 });
  });

  it("assembles tool_call arguments streamed across frames", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "emit_plan", arguments: '{"a"' } }] } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ":1}" } }] } }] })}\n\n`,
        "data: [DONE]\n\n",
      ]),
    ) as unknown as typeof fetch;
    const { queuedTextCompletion } = await import("../internal-client");

    const text = await queuedTextCompletion([{ role: "user", content: "hi" }], 64, { onDelta: () => {} });
    expect(JSON.parse(text)).toEqual([{ name: "emit_plan", arguments: '{"a":1}' }]);
  });

  it("keeps a truncated conversational answer when the caller allows it", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      sseResponse([openAiFrame("half an answer"), `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}\n\n`]),
    ) as unknown as typeof fetch;
    const { queuedTextCompletion } = await import("../internal-client");

    await expect(
      queuedTextCompletion([{ role: "user", content: "hi" }], 8, { onDelta: () => {}, allowTruncated: true }),
    ).resolves.toBe("half an answer");
  });

  it("rejects a truncated response when the caller does not allow it", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      sseResponse([openAiFrame("half"), `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}\n\n`]),
    ) as unknown as typeof fetch;
    const { queuedTextCompletion } = await import("../internal-client");

    await expect(
      queuedTextCompletion([{ role: "user", content: "hi" }], 8, { onDelta: () => {}, maxAttempts: 1 }),
    ).rejects.toThrow(/output limit/i);
  });

  it("streams the Anthropic wire format too", async () => {
    const { withByokProvider } = await import("../byok-context");
    globalThis.fetch = vi.fn().mockResolvedValue(
      sseResponse([
        `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 9 } } })}\n\n`,
        `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "anthropic " } })}\n\n`,
        `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "answer" } })}\n\n`,
        `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } })}\n\n`,
      ]),
    ) as unknown as typeof fetch;
    const { queuedTextCompletion } = await import("../internal-client");

    const chunks: string[] = [];
    const text = await withByokProvider(
      { provider: "anthropic", apiKey: "k", baseUrl: "https://api.anthropic.com/v1", model: "claude-test" },
      () => queuedTextCompletion([{ role: "user", content: "hi" }], 64, { onDelta: (c) => chunks.push(c) }),
    );
    expect(chunks.join("")).toBe("anthropic answer");
    expect(text).toBe("anthropic answer");
  });
});
