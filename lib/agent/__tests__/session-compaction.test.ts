import { describe, expect, it } from "vitest";
import { appendTurn, getOrCreateSession } from "../session-store";
import { normalizeInput } from "../input";
import { buildContextWindow, CONTEXT_PRESETS } from "../context";

function session(id: string) {
  return getOrCreateSession(id, "execute", "trion-1.4", "workspace");
}

describe("deterministic session compaction", () => {
  it("replaces resolved overflow with bounded memory instead of deleting it", async () => {
    const id = "compaction-preserves-goal";
    const state = session(id);
    appendTurn(id, { role: "user", content: "Build an accessible observatory dashboard called Nightwatch." });
    for (let index = 0; index < 70; index++) {
      appendTurn(id, { role: "assistant", content: `Completed iteration ${index}.` });
    }

    expect(state.history).toHaveLength(60);
    expect(state.compactionSummary).toContain("Nightwatch");
    expect(state.compactionSummary.length).toBeLessThanOrEqual(1_700);

    const input = await normalizeInput(
      { sessionId: id, userText: "What did we call it?", mode: "execute", model: "trion-1.4", workspacePath: "workspace" },
      state
    );
    expect(input.conversation_history[0]).toEqual(expect.objectContaining({ compacted: true }));
    expect(input.conversation_history[0].content).toContain("Nightwatch");
    expect(buildContextWindow(input.conversation_history, CONTEXT_PRESETS.directAnswer).turns[0]).toEqual(
      expect.objectContaining({ compacted: true })
    );
  });

  it("never compacts an open clarification just to meet the soft cap", () => {
    const id = "compaction-keeps-open-thread";
    const state = session(id);
    appendTurn(id, { role: "assistant", content: "Which deployment region should I use?", clarifying: true, unresolved: true });
    for (let index = 0; index < 65; index++) {
      appendTurn(id, { role: "tool", tool_name: "read_file", content: JSON.stringify({ path: `src/${index}.ts` }) });
    }

    expect(state.history.some((turn) => turn.content.includes("Which deployment region"))).toBe(true);
  });

  it("migrates an in-memory session created before compaction fields existed", () => {
    const id = "compaction-hot-reload-migration";
    const state = session(id);
    (state as unknown as { compactionSummary?: string; firstUserMessage?: string | null }).compactionSummary = undefined;
    (state as unknown as { compactionSummary?: string; firstUserMessage?: string | null }).firstUserMessage = undefined;

    const restored = session(id);
    expect(restored.compactionSummary).toBe("");
    expect(restored.firstUserMessage).toBeNull();
  });
});
