// Measures the real context size each call type sends, so the memory fix can be
// shown NOT to have undone the token-efficiency work. Prints a table under
// `npx vitest run context-size --reporter=verbose`.

// @ts-nocheck
import { describe, it, expect } from "vitest";
import { buildContextWindow, CONTEXT_PRESETS } from "../context";
import type { ConversationTurn } from "../types";

/** A realistic 20-turn coding session. */
function realisticSession(): ConversationTurn[] {
  const history: ConversationTurn[] = [
    { role: "user", content: "build me a simple duck clicker game" },
    { role: "assistant", content: "What kind of duck game would you like — a clicker, a hunting game, or a platformer?", clarifying: true },
    { role: "user", content: "yes a simpl clicker" },
  ];
  for (let i = 0; i < 8; i++) {
    history.push({ role: "assistant", content: `Writing the game files, pass ${i}. ${"detail ".repeat(20)}` });
    history.push({ role: "tool", content: JSON.stringify({ path: `src/game-${i}.ts`, ok: true }), tool_name: "write_file" });
  }
  return history;
}

describe("context size per call type", () => {
  it("stays bounded and ordered: classification cheapest", () => {
    const history = realisticSession();
    const rows: Array<[string, number, number, number]> = [];

    for (const [name, preset] of Object.entries(CONTEXT_PRESETS)) {
      const win = buildContextWindow(history, preset);
      const chars =
        win.summary.length + win.turns.reduce((n, t) => n + t.content.length, 0);
      rows.push([name, win.turns.length, chars, Math.ceil(chars / 4)]);
    }

    console.log(
      `\n  call type        turns   chars   ~tokens\n` +
        rows
          .map(([n, t, c, tok]) => `  ${n.padEnd(16)} ${String(t).padStart(5)} ${String(c).padStart(7)} ${String(tok).padStart(9)}`)
          .join("\n") +
        `\n  (session: ${history.length} turns total)\n`
    );

    const byName = Object.fromEntries(rows.map(([n, , c]) => [n, c]));

    // Classification is the latency-critical call and must stay the cheapest.
    expect(byName.classification).toBeLessThan(byName.execution);
    // Nothing sends the whole session verbatim.
    const fullSize = history.reduce((n, t) => n + t.content.length, 0);
    expect(byName.classification).toBeLessThan(fullSize);
    // Hard ceiling: classification context must stay ~500 tokens or less.
    expect(Math.ceil(byName.classification / 4)).toBeLessThanOrEqual(600);
  });

  it("stays bounded on a long session — growth does not track session length", () => {
    // 120 turns of substantial content: the budgets must actually bind here.
    const long: ConversationTurn[] = [
      { role: "user", content: "build me a duck clicker game" },
      { role: "assistant", content: "Which kind?", clarifying: true, unresolved: true },
    ];
    for (let i = 0; i < 120; i++) {
      long.push({ role: i % 2 ? "assistant" : "user", content: `step ${i}: ${"content ".repeat(40)}` });
    }

    const rows: Array<[string, number, number, number, number]> = [];
    for (const [name, preset] of Object.entries(CONTEXT_PRESETS)) {
      const win = buildContextWindow(long, preset);
      const chars = win.summary.length + win.turns.reduce((n, t) => n + t.content.length, 0);
      rows.push([name, win.turns.length, win.stats.summarizedTurns, chars, Math.ceil(chars / 4)]);
    }

    console.log(
      `\n  call type        turns  summarized   chars   ~tokens\n` +
        rows
          .map(([n, t, s, c, tok]) =>
            `  ${n.padEnd(16)} ${String(t).padStart(5)} ${String(s).padStart(11)} ${String(c).padStart(7)} ${String(tok).padStart(9)}`
          )
          .join("\n") +
        `\n  (session: ${long.length} turns, ${long.reduce((n, t) => n + t.content.length, 0)} chars total)\n`
    );

    const fullChars = long.reduce((n, t) => n + t.content.length, 0);
    for (const [name, , , chars] of rows) {
      // Every call type sends a small fraction of a long session.
      expect(chars, `${name} sent too much`).toBeLessThan(fullChars * 0.35);
    }

    // The unresolved clarifying question survives at every size.
    for (const preset of Object.values(CONTEXT_PRESETS)) {
      const win = buildContextWindow(long, preset);
      expect(win.turns.some((t) => t.content === "Which kind?")).toBe(true);
    }
  });
});
