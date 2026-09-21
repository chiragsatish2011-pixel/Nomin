// The local model lane and its fallback to the hosted NVIDIA lane.
//
// The property under test is the one that decides whether this is usable: a
// local model is tried first, and when it is not there, the user's request is
// still answered — by the hosted lane, on the same call, without the turn
// failing and without consuming the hosted lane's retry budget.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

const LOCAL = "http://127.0.0.1:11434/v1";
const HOSTED = "https://hosted.test/v1";

function reset() {
  // The key lane is cached on globalThis so a hot reload keeps its rate state;
  // a test that changes the environment has to clear it, or it keeps the lane
  // built from the PREVIOUS test's variables.
  delete (globalThis as Record<string, unknown>).__trionKeyLane;
  vi.resetModules();
}

function okResponse(content: string): Response {
  return {
    ok: true,
    status: 200,
    headers: { forEach() {} },
    json: async () => ({ choices: [{ message: { content }, finish_reason: "stop" }] }),
    text: async () => "",
  } as unknown as Response;
}

function errorResponse(status: number): Response {
  return {
    ok: false,
    status,
    headers: { forEach() {} },
    json: async () => ({}),
    text: async () => "upstream said no",
  } as unknown as Response;
}

/** The shape a dead port produces: fetch rejects before any response. */
function refused(): Promise<Response> {
  return Promise.reject(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), { cause: { code: "ECONNREFUSED" } }));
}

function urlOf(call: unknown[]): string {
  return String(call[0]);
}

function bodyOf(call: unknown[]): Record<string, unknown> {
  return JSON.parse((call[1] as { body: string }).body);
}

beforeEach(() => {
  process.env = {
    ...ORIGINAL_ENV,
    TRION_LOCAL_BASE_URL: LOCAL,
    TRION_LOCAL_MODEL: "local-coder",
    TRION_API_KEY: "hosted-key",
    TRION_BASE_URL: HOSTED,
    TRION_MODEL_PRIMARY: "nvidia/nemotron-3-ultra-550b-a55b",
    TRION_MODEL_FAST: "nvidia/nemotron-3-super-120b-a12b",
    TRION_MIN_INTERVAL_MS: "0",
    TRION_RPM_LIMIT: "1000",
  };
  delete process.env.TRION_LOCAL_DISABLED;
  delete process.env.TRION_LOCAL_API_KEY;
  delete process.env.TRION_LOCAL_FAST_MODEL;
  reset();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
  reset();
  vi.restoreAllMocks();
});

describe("configuration", () => {
  it("needs both a base URL and a model id", async () => {
    const { localLaneFromEnv } = await import("../local-lane");
    expect(localLaneFromEnv({ TRION_LOCAL_BASE_URL: LOCAL })).toBeNull();
    expect(localLaneFromEnv({ TRION_LOCAL_MODEL: "m" })).toBeNull();
    expect(localLaneFromEnv({ TRION_LOCAL_BASE_URL: LOCAL, TRION_LOCAL_MODEL: "m" })).toMatchObject({
      baseUrl: LOCAL,
      model: "m",
    });
  });

  it("can be switched off without losing the configuration", async () => {
    const { localLaneFromEnv } = await import("../local-lane");
    expect(localLaneFromEnv({ TRION_LOCAL_BASE_URL: LOCAL, TRION_LOCAL_MODEL: "m", TRION_LOCAL_DISABLED: "1" })).toBeNull();
  });

  it("counts a local-only install as a configured provider", async () => {
    delete process.env.TRION_API_KEY;
    reset();
    const { hasConfig } = await import("../internal-client");
    const { hasProviderCredential } = await import("@/lib/agent/model-tiers");
    expect(hasConfig()).toBe(true);
    expect(hasProviderCredential(process.env)).toBe(true);
  });
});

describe("the local lane is tried first", () => {
  it("sends the request to the local server, with its own model id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse("local answer"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { queuedTextCompletion } = await import("../internal-client");

    const text = await queuedTextCompletion([{ role: "user", content: "hi" }], 64, {});
    expect(text).toBe("local answer");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(urlOf(fetchMock.mock.calls[0])).toBe(`${LOCAL}/chat/completions`);
    expect(bodyOf(fetchMock.mock.calls[0]).model).toBe("local-coder");
  });

  it("sends no Authorization header when the local server needs no key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse("ok"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { queuedTextCompletion } = await import("../internal-client");

    await queuedTextCompletion([{ role: "user", content: "hi" }], 64, {});
    const headers = (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers.authorization).toBeUndefined();
  });

  it("uses the small local model for a fast-tier call when one is configured", async () => {
    process.env.TRION_LOCAL_FAST_MODEL = "local-mini";
    reset();
    const fetchMock = vi.fn().mockResolvedValue(okResponse("ok"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { queuedTextCompletion } = await import("../internal-client");

    await queuedTextCompletion([{ role: "user", content: "hi" }], 64, { fast: true });
    expect(bodyOf(fetchMock.mock.calls[0]).model).toBe("local-mini");
  });

  it("does not send NVIDIA-specific body keys to a local server", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse("ok"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { queuedTextCompletion } = await import("../internal-client");

    await queuedTextCompletion([{ role: "user", content: "hi" }], 64, { thinking: false });
    expect(bodyOf(fetchMock.mock.calls[0]).chat_template_kwargs).toBeUndefined();
  });

  it("streams from the local server like any other OpenAI-compatible endpoint", async () => {
    const frame = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
    const chunks = [frame("local "), frame("stream"), "data: [DONE]\n\n"];
    let index = 0;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { forEach() {} },
      body: {
        getReader: () => ({
          async read() {
            if (index >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: new TextEncoder().encode(chunks[index++]) };
          },
          releaseLock() {},
        }),
      },
    } as unknown as Response) as unknown as typeof fetch;
    const { queuedTextCompletion } = await import("../internal-client");

    const seen: string[] = [];
    const text = await queuedTextCompletion([{ role: "user", content: "hi" }], 64, { onDelta: (c) => seen.push(c) });
    expect(seen.join("")).toBe("local stream");
    expect(text).toBe("local stream");
  });
});

describe("falling back to the hosted NVIDIA lane", () => {
  it("answers on the hosted lane when the local server is not running", async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => refused())
      .mockResolvedValue(okResponse("hosted answer"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { queuedTextCompletion } = await import("../internal-client");

    const text = await queuedTextCompletion([{ role: "user", content: "hi" }], 64, {});
    expect(text).toBe("hosted answer");
    expect(urlOf(fetchMock.mock.calls[0])).toContain("127.0.0.1");
    expect(urlOf(fetchMock.mock.calls[1])).toBe(`${HOSTED}/chat/completions`);
    expect(bodyOf(fetchMock.mock.calls[1]).model).toBe("nvidia/nemotron-3-ultra-550b-a55b");
  });

  it("falls back on a local HTTP error too, not just a dead port", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(errorResponse(404))   // wrong model id on the local server
      .mockResolvedValue(okResponse("hosted answer"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { queuedTextCompletion } = await import("../internal-client");

    await expect(queuedTextCompletion([{ role: "user", content: "hi" }], 64, {})).resolves.toBe("hosted answer");
  });

  it("does not spend the hosted lane's retry budget on the local failure", async () => {
    // maxAttempts: 1 means the hosted lane gets exactly one try. If the local
    // hop counted as that try, this call could never reach the hosted lane.
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => refused())
      .mockResolvedValue(okResponse("hosted answer"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { queuedTextCompletion } = await import("../internal-client");

    await expect(queuedTextCompletion([{ role: "user", content: "hi" }], 64, { maxAttempts: 1 })).resolves.toBe("hosted answer");
  });

  it("tells the client to discard anything the failed local attempt streamed", async () => {
    const frame = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
    let streamed = false;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes("127.0.0.1")) {
        streamed = true;
        // A local server that starts answering and then dies mid-stream.
        return {
          ok: true,
          status: 200,
          headers: { forEach() {} },
          body: {
            getReader: () => {
              let sent = false;
              return {
                async read() {
                  if (!sent) {
                    sent = true;
                    return { done: false, value: new TextEncoder().encode(frame("half an ")) };
                  }
                  throw new Error("socket closed");
                },
                releaseLock() {},
              };
            },
          },
        } as unknown as Response;
      }
      const hosted = [frame("complete hosted answer"), "data: [DONE]\n\n"];
      let sent = 0;
      return {
        ok: true,
        status: 200,
        headers: { forEach() {} },
        body: {
          getReader: () => ({
            async read() {
              if (sent >= hosted.length) return { done: true, value: undefined };
              return { done: false, value: new TextEncoder().encode(hosted[sent++]) };
            },
            releaseLock() {},
          }),
        },
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const { queuedTextCompletion } = await import("../internal-client");

    let shown = "";
    const text = await queuedTextCompletion([{ role: "user", content: "hi" }], 64, {
      onDelta: (chunk) => { shown += chunk; },
      onStreamRestart: () => { shown = ""; },
    });
    expect(streamed).toBe(true);
    // The half sentence the local server managed to emit was withdrawn, and
    // what the user is left looking at is the hosted answer alone.
    expect(shown).not.toContain("half an");
    expect(shown).toBe("complete hosted answer");
    expect(text).toBe("complete hosted answer");
  });

  it("says what actually failed when there is no hosted fallback configured", async () => {
    delete process.env.TRION_API_KEY;
    reset();
    globalThis.fetch = vi.fn().mockImplementation(() => refused()) as unknown as typeof fetch;
    const { queuedTextCompletion } = await import("../internal-client");

    await expect(queuedTextCompletion([{ role: "user", content: "hi" }], 64, {})).rejects.toThrow(
      /local model at http:\/\/127\.0\.0\.1:11434\/v1 .*no hosted fallback/i,
    );
  });
});

describe("a dead local server is not retried in front of every call", () => {
  it("stops attempting locally after three consecutive failures", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes("127.0.0.1")) return refused();
      return okResponse("hosted answer");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { queuedTextCompletion } = await import("../internal-client");
    const { localLaneSnapshot } = await import("../local-lane");

    for (let i = 0; i < 5; i++) {
      await expect(queuedTextCompletion([{ role: "user", content: "hi" }], 64, {})).resolves.toBe("hosted answer");
    }

    const localCalls = fetchMock.mock.calls.filter((call) => urlOf(call).includes("127.0.0.1"));
    expect(localCalls).toHaveLength(3);
    const snapshot = localLaneSnapshot();
    expect(snapshot.coolingDown).toBe(true);
    expect(snapshot.fallbacks).toBe(3);
  });

  it("forgets the failures as soon as the local server answers again", async () => {
    let healthy = false;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes("127.0.0.1")) return healthy ? okResponse("local answer") : refused();
      return okResponse("hosted answer");
    }) as unknown as typeof fetch;
    const { queuedTextCompletion } = await import("../internal-client");
    const { localLaneSnapshot } = await import("../local-lane");

    await queuedTextCompletion([{ role: "user", content: "hi" }], 64, {});
    expect(localLaneSnapshot().consecutiveFailures).toBe(1);

    healthy = true;
    await expect(queuedTextCompletion([{ role: "user", content: "hi" }], 64, {})).resolves.toBe("local answer");
    expect(localLaneSnapshot().consecutiveFailures).toBe(0);
  });
});

describe("a user's own connection still wins", () => {
  it("uses BYOK instead of the local lane", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse("byok answer"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { queuedTextCompletion } = await import("../internal-client");
    const { withByokProvider } = await import("../byok-context");

    await withByokProvider(
      { provider: "openai", apiKey: "sk-user", baseUrl: "https://api.openai.test/v1", model: "gpt-user" },
      () => queuedTextCompletion([{ role: "user", content: "hi" }], 64, {}),
    );
    expect(urlOf(fetchMock.mock.calls[0])).toBe("https://api.openai.test/v1/chat/completions");
    expect(bodyOf(fetchMock.mock.calls[0]).model).toBe("gpt-user");
  });
});
