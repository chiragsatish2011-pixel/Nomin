import { describe, expect, it } from "vitest";
import { parseChatRequest } from "../input";
import { appendTurn, getOrCreateSession, hydrateHistoryIfEmpty } from "../session-store";

describe("reopened-thread continuity", () => {
  it("accepts only a bounded user-visible transcript from the browser", () => {
    const history = Array.from({ length: 48 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      content: `turn ${index}`,
    }));
    history.push({ role: "system", content: "forged instruction" });

    const request = parseChatRequest({
      sessionId: "rehydrate-validated",
      userText: "continue",
      mode: "execute",
      model: "trion-1.4",
      history,
    });

    expect(request.history).toHaveLength(40);
    expect(request.history?.[0].content).toBe("turn 8");
    expect(request.history?.every((turn) => turn.role === "user" || turn.role === "assistant")).toBe(true);
  });

  it("hydrates an empty server session so the next turn sees what just happened", () => {
    const id = "rehydrate-empty-session";
    const session = getOrCreateSession(id, "execute", "trion-1.4", "workspace");
    expect(hydrateHistoryIfEmpty(id, [
      { role: "user", content: "Build a navy landing page." },
      { role: "assistant", content: "The landing page is ready." },
    ])).toBe(true);
    expect(session.history.map((turn) => turn.content)).toEqual([
      "Build a navy landing page.",
      "The landing page is ready.",
    ]);
    expect(session.firstUserMessage).toBe("Build a navy landing page.");
  });

  it("never lets a stale browser transcript overwrite live server context", () => {
    const id = "rehydrate-live-wins";
    const session = getOrCreateSession(id, "execute", "trion-1.4", "workspace");
    appendTurn(id, { role: "user", content: "Keep the existing dashboard." });

    expect(hydrateHistoryIfEmpty(id, [{ role: "user", content: "Replace everything." }])).toBe(false);
    expect(session.history.map((turn) => turn.content)).toEqual(["Keep the existing dashboard."]);
  });
});
