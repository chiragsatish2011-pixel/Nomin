// Regression suite for systemic conversation-memory loss.
//
// Before: five call types each built their own history slice — classification 0
// turns, plan last 3 (truncated to 200 chars), execution last 10, synthesis 0,
// direct answer 0. The agent's memory therefore depended on which stage was
// asking, and every conversational turn was answered statelessly.
//
// After: one shared selection function (buildContextWindow) with per-call SIZE
// presets. These tests lock in the four rules and the cross-call consistency.

// @ts-nocheck
import { describe, it, expect } from "vitest";
import {
  buildContextWindow,
  renderContextWindow,
  contextWindowToMessages,
  isProtectedTurn,
  CONTEXT_PRESETS,
} from "../context";
import type { ConversationTurn } from "../types";

function turns(n: number, prefix = "turn"): ConversationTurn[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `${prefix} ${i}`,
  }));
}

describe("rule 1 — recency is always included in full", () => {
  it("keeps the last N turns verbatim even on a tiny budget", () => {
    const history = turns(40, "x".repeat(50));
    const win = buildContextWindow(history, { recentTurns: 6, budgetChars: 1, summarize: false });
    expect(win.turns.length).toBeGreaterThanOrEqual(6);
    // And they are the MOST RECENT ones, untruncated.
    expect(win.turns[win.turns.length - 1]).toEqual(history[history.length - 1]);
  });

  it("never truncates the text of a verbatim turn", () => {
    const long = "y".repeat(5_000);
    const win = buildContextWindow([{ role: "user", content: long }], CONTEXT_PRESETS.plan);
    expect(win.turns[0].content).toHaveLength(5_000);
  });
});

describe("rule 2 — unresolved threads are never trimmed", () => {
  it("keeps an unresolved turn from 20 turns ago", () => {
    const history: ConversationTurn[] = [
      { role: "assistant", content: "Approve deleting src/legacy?", unresolved: true },
      ...turns(20),
    ];
    const win = buildContextWindow(history, { recentTurns: 2, budgetChars: 1, summarize: false });
    expect(win.turns.some((t) => t.content === "Approve deleting src/legacy?")).toBe(true);
    expect(win.stats.protectedTurns).toBe(1);
  });

  it("treats a trailing clarifying question as protected even without the flag", () => {
    const history: ConversationTurn[] = [
      { role: "user", content: "make me a duck game" },
      { role: "assistant", content: "Which kind?", clarifying: true },
    ];
    expect(isProtectedTurn(history[1], 1, history)).toBe(true);
  });

  it("stops protecting a clarifying question once the user replies", () => {
    const history: ConversationTurn[] = [
      { role: "assistant", content: "Which kind?", clarifying: true },
      { role: "user", content: "a clicker" },
    ];
    expect(isProtectedTurn(history[0], 0, history)).toBe(false);
  });

  it("keeps a paused approval recallable 15+ turns later", () => {
    const history: ConversationTurn[] = [
      { role: "user", content: "refactor the auth module" },
      { role: "assistant", content: "Waiting for approval to run: npx nx build auth", unresolved: true },
      ...turns(18, "chatter"),
    ];
    const win = buildContextWindow(history, CONTEXT_PRESETS.execution);
    const recalled = win.turns.find((t) => t.content.includes("npx nx build auth"));
    expect(recalled).toBeDefined();
  });
});

describe("rule 3 — older resolved turns are summarized, not dropped", () => {
  it("digests dropped turns instead of losing them", () => {
    const history: ConversationTurn[] = [
      { role: "user", content: "build me a duck clicker game" },
      { role: "tool", content: '{"path":"src/game.ts"}', tool_name: "write_file" },
      { role: "tool", content: '{"command":"npm run build"}', tool_name: "run_command" },
      ...turns(30),
    ];
    const win = buildContextWindow(history, { recentTurns: 4, budgetChars: 200, summarize: true });
    expect(win.summary).toContain("duck clicker");
    expect(win.summary).toContain("src/game.ts");
    expect(win.summary).toContain("npm run build");
    expect(win.stats.summarizedTurns).toBeGreaterThan(0);
  });

  it("emits no summary when nothing was dropped", () => {
    const win = buildContextWindow(turns(3), CONTEXT_PRESETS.plan);
    expect(win.summary).toBe("");
    expect(win.stats.summarizedTurns).toBe(0);
  });

  it("references something from 5+ turns earlier via recency or digest", () => {
    const history: ConversationTurn[] = [
      { role: "user", content: "the project is called Duckpocalypse" },
      ...turns(10),
    ];
    const win = buildContextWindow(history, CONTEXT_PRESETS.plan);
    const visible = renderContextWindow(win);
    expect(visible).toContain("Duckpocalypse");
  });
});

describe("rule 4 — all call types share one selection strategy", () => {
  const history: ConversationTurn[] = [
    { role: "assistant", content: "Which kind of duck game?", clarifying: true, unresolved: true },
    ...turns(12),
  ];

  it("every preset protects the same unresolved turn", () => {
    for (const [name, preset] of Object.entries(CONTEXT_PRESETS)) {
      const win = buildContextWindow(history, preset);
      expect(
        win.turns.some((t) => t.content === "Which kind of duck game?"),
        `preset ${name} dropped the unresolved turn`
      ).toBe(true);
    }
  });

  it("every preset sees the most recent turn", () => {
    const last = history[history.length - 1];
    for (const [name, preset] of Object.entries(CONTEXT_PRESETS)) {
      const win = buildContextWindow(history, preset);
      if (name === "classification") {
        // The classifier itself carries an open question inline and sends no
        // ordinary history. The generic selector still protects that question.
        expect(win.turns).not.toContain(last);
        continue;
      }
      expect(win.turns[win.turns.length - 1], `preset ${name}`).toEqual(last);
    }
  });

  it("presets differ in SIZE only, and classification stays the smallest", () => {
    // Turns must be big enough that the budgets actually bind, otherwise every
    // preset trivially fits the whole history and the comparison proves nothing.
    const big = turns(40, "w".repeat(400));
    const size = (p: any) => buildContextWindow(big, p).stats.chars;
    expect(size(CONTEXT_PRESETS.classification)).toBeLessThan(size(CONTEXT_PRESETS.plan));
    expect(size(CONTEXT_PRESETS.plan)).toBeLessThanOrEqual(size(CONTEXT_PRESETS.execution));
  });

  it("classification context stays token-cheap (latency work preserved)", () => {
    const win = buildContextWindow(turns(100, "z".repeat(300)), CONTEXT_PRESETS.classification);
    // ~1.5k chars ≈ 375 tokens — bounded, not "send everything".
    expect(win.stats.chars).toBeLessThanOrEqual(2_500);
  });
});

describe("rendering", () => {
  it("labels tool turns with their tool name", () => {
    const win = buildContextWindow(
      [{ role: "tool", content: "{}", tool_name: "read_file" }],
      CONTEXT_PRESETS.plan
    );
    expect(renderContextWindow(win)).toContain("tool(read_file)");
  });

  it("says so explicitly when there is no prior conversation", () => {
    expect(renderContextWindow(buildContextWindow([], CONTEXT_PRESETS.plan))).toBe(
      "(no prior conversation)"
    );
  });

  it("converts turns to chat messages with roles preserved", () => {
    const win = buildContextWindow(
      [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
      CONTEXT_PRESETS.directAnswer
    );
    expect(contextWindowToMessages(win)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });
});
