import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queuedCompletion: vi.fn(),
  queuedTextCompletion: vi.fn().mockResolvedValue("The verified answer is ready."),
}));

vi.mock("../../nim/internal-client", () => mocks);

import { modelGateway } from "../model-gateway";
import { withByokProvider } from "../../nim/byok-context";

const messages = [
  { role: "system" as const, content: "You are Trion. Follow the complete tool and verification contract." },
  { role: "user" as const, content: "Explain the next safe step." },
];

const options = {
  tier: "trion-1.4" as const,
  fast: true,
  maxTokens: 120,
  callType: "direct_answer" as const,
  thinking: false,
};

describe("BYOK provider parity", () => {
  it("keeps the exact Trion prompt and call policy when a user provider is active", async () => {
    mocks.queuedTextCompletion.mockClear();
    await modelGateway.completeText(messages, options);
    const hostedMessages = mocks.queuedTextCompletion.mock.calls[0][0];
    const hostedOptions = mocks.queuedTextCompletion.mock.calls[0][2];

    mocks.queuedTextCompletion.mockClear();
    await withByokProvider({
      provider: "openai",
      apiKey: "user-key",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-test",
      fastModel: "gpt-fast-test",
    }, () => modelGateway.completeText(messages, options));
    const byokMessages = mocks.queuedTextCompletion.mock.calls[0][0];
    const byokOptions = mocks.queuedTextCompletion.mock.calls[0][2];

    expect(byokMessages).toEqual(hostedMessages);
    expect(byokOptions).toMatchObject({
      fast: hostedOptions.fast,
      tier: hostedOptions.tier,
      maxAttempts: hostedOptions.maxAttempts,
      label: hostedOptions.label,
      thinking: hostedOptions.thinking,
    });
  });
});
