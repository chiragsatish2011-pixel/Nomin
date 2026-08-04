import { describe, expect, it } from "vitest";
import { recordUsage, resetLedger, totalsFor, withLedgerSession } from "../token-ledger";

function usage(model: string, promptTokens: number, completionTokens: number) {
  return {
    callType: "execution_decision" as const,
    model,
    promptTokens,
    completionTokens,
    cachedPromptTokens: 0,
    promptCacheStable: true,
    thinking: false,
    ms: 1,
  };
}

describe("token-ledger concurrent-session isolation", () => {
  it("keeps overlapping asynchronous model usage with the session that incurred it", async () => {
    const alpha = "ledger-isolation-alpha";
    const beta = "ledger-isolation-beta";
    resetLedger(alpha);
    resetLedger(beta);

    await Promise.all([
      withLedgerSession(alpha, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        recordUsage(usage("trion-alpha", 101, 11));
      }),
      withLedgerSession(beta, async () => {
        recordUsage(usage("trion-beta", 202, 22));
        await new Promise((resolve) => setTimeout(resolve, 15));
        recordUsage(usage("trion-beta", 303, 33));
      }),
    ]);

    expect(totalsFor(alpha)).toMatchObject({ calls: 1, promptTokens: 101, completionTokens: 11, totalTokens: 112 });
    expect(totalsFor(alpha).byModel).toEqual({ "trion-alpha": { calls: 1, promptTokens: 101, completionTokens: 11 } });
    expect(totalsFor(beta)).toMatchObject({ calls: 2, promptTokens: 505, completionTokens: 55, totalTokens: 560 });
    expect(totalsFor(beta).byModel).toEqual({ "trion-beta": { calls: 2, promptTokens: 505, completionTokens: 55 } });
  });
});
