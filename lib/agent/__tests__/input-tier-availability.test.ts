import { afterEach, describe, expect, it, vi } from "vitest";
import { InputValidationError, parseChatRequest } from "../input";

const request = (model: string) => ({
  sessionId: "tier-test",
  userText: "hello",
  mode: "execute",
  model,
});

afterEach(() => vi.unstubAllEnvs());

describe("chat model-tier validation", () => {
  it("keeps 1.4 backward-compatible as the default route", () => {
    expect(parseChatRequest(request("trion-1.4")).model).toBe("trion-1.4");
    expect(parseChatRequest(request("unknown-tier")).model).toBe("trion-1.4");
  });

  it("rejects a known tier that has no real provider route", () => {
    vi.stubEnv("TRION_MODEL_1_9_PRIMARY", "");
    expect(() => parseChatRequest(request("trion-1.9"))).toThrow(InputValidationError);
    expect(() => parseChatRequest(request("trion-1.9"))).toThrow(/not configured/i);
  });

  it("admits a tier only after its explicit primary route is configured", () => {
    vi.stubEnv("TRION_MODEL_1_9_PRIMARY", "explicit-19-primary");
    expect(parseChatRequest(request("trion-1.9")).model).toBe("trion-1.9");
  });
});
