// Shared conversation-context assembly for EVERY model call in the loop.
//
// Before this module each call type built its own history slice ad hoc:
//   classification  -> 0 turns
//   plan            -> last 3 turns, truncated to 200 chars each
//   execution       -> last 10 turns
//   synthesis       -> 0 turns
//   direct answer   -> 0 turns
// So the agent's memory depended on which stage was asking, and conversational
// turns (direct answer) were entirely stateless — the user could answer a
// question and the very next turn would have no record of it.
//
// The strategy here is deliberate, not "include more":
//   1. RECENCY      — the last N turns are always included verbatim.
//   2. UNRESOLVED   — turns still awaiting resolution (an unanswered clarifying
//                     question, a paused approval) are NEVER trimmed until they
//                     resolve, however old they get.
//   3. SUMMARY      — older RESOLVED turns collapse into a short deterministic
//                     digest (requests made, files touched, commands run) rather
//                     than being dropped outright. No extra model call, so this
//                     costs latency nothing.
//   4. CONSISTENCY  — one selection function, five presets. Call types differ in
//                     SIZE only; they can never disagree about WHICH turns matter.

import type { ConversationTurn, NimMessage } from "./types";
import { frameUntrustedContent } from "./untrusted-content";

export interface ContextWindow {
  /** Deterministic digest of older resolved turns. Empty when there are none. */
  summary: string;
  /** Turns to include verbatim, oldest first. */
  turns: ConversationTurn[];
  /** Diagnostics — asserted in tests and logged in perf output. */
  stats: {
    totalTurns: number;
    verbatimTurns: number;
    summarizedTurns: number;
    protectedTurns: number;
    chars: number;
  };
}

export interface ContextOptions {
  /** Turns always included verbatim, regardless of budget. */
  recentTurns: number;
  /** Soft char budget for the verbatim window. Protected turns may exceed it. */
  budgetChars: number;
  /** Collapse older resolved turns into a digest instead of dropping them. */
  summarize: boolean;
}

/** Per-call-type sizes. Selection logic is shared; only the size differs.
 *  Classification stays deliberately small — it is the latency-critical call. */
export const CONTEXT_PRESETS = {
  // Classification is an enum decision, not a conversation answer. It gets
  // no history by default; classifier.ts injects the one outstanding question
  // inline when the user is answering a clarification. This prevents old
  // prose from changing intent and saves those tokens on every turn.
  classification: { recentTurns: 0, budgetChars: 0, summarize: false },
  plan: { recentTurns: 6, budgetChars: 4_000, summarize: true },
  // Was 10 turns / 8k chars. Safe to shrink ONLY because the durable facts a
  // long run needs — the original goal, the decisions taken, the files already
  // written, the step ledger — are now carried structurally by TaskState instead
  // of being re-derived from transcript. Without that this would be a straight
  // memory regression; with it, the transcript only has to carry the last few
  // exchanges. See lib/agent/task-state.ts.
  execution: { recentTurns: 6, budgetChars: 5_000, summarize: true },
  synthesis: { recentTurns: 6, budgetChars: 4_000, summarize: true },
  directAnswer: { recentTurns: 6, budgetChars: 3_000, summarize: true },
} as const satisfies Record<string, ContextOptions>;

/**
 * How a selected window is RENDERED. Selection (which turns) and rendering (how
 * much of each turn) are deliberately separate: `buildContextWindow` must never
 * truncate a turn it selected — a caller that asks for a turn gets the whole
 * turn — so the size control for payload-heavy rows lives here.
 */
export interface RenderOptions {
  /** Most-recent tool rows whose full payload is kept. */
  liveToolRows: number;
  /** Head/tail budget for a tool payload that IS kept. */
  toolHeadChars: number;
  toolTailChars: number;
  /** Cap for a user/assistant turn. */
  proseChars: number;
}

const UNBOUNDED = Number.POSITIVE_INFINITY;

export const RENDER_PRESETS = {
  /** No clipping. The default, so existing callers are unaffected. */
  full: { liveToolRows: UNBOUNDED, toolHeadChars: UNBOUNDED, toolTailChars: 0, proseChars: UNBOUNDED },
  /** The execution decision call. */
  execution: { liveToolRows: 3, toolHeadChars: 3_000, toolTailChars: 500, proseChars: 1_500 },
} as const satisfies Record<string, RenderOptions>;

/** Below this, a tool payload is cheaper to keep than to describe. */
const COLLAPSE_MIN_CHARS = 400;

function isErrorRow(turn: ConversationTurn): boolean {
  return /^(?:Error:|Verification failed:|Coherence check:)/.test(turn.content);
}

/** Keep the head and the tail, drop the middle. A truncated-at-the-head clip
 *  loses the part of a command's output that says how it ended, which is the
 *  part that decides what happens next. */
function clip(text: string, head: number, tail: number): string {
  if (!Number.isFinite(head) || text.length <= head + tail) return text;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n…[${omitted.toLocaleString()} characters omitted]…\n${text.slice(text.length - tail)}`;
}

/**
 * One-line receipt for an older tool row that already did its job.
 *
 * This is the outcome-aware half of the trimming: a payload is dropped because
 * the step that consumed it RESOLVED, not because it got old. The row itself
 * stays — the model still needs to know the call happened so it does not repeat
 * it — and TaskState independently records that the file was read or written, so
 * the receipt is never the only surviving record.
 */
function receiptFor(turn: ConversationTurn): string {
  const name = turn.tool_name ?? "tool";
  let target = "";
  try {
    const parsed = JSON.parse(turn.content) as { path?: unknown; query?: unknown };
    if (typeof parsed.path === "string") target = ` ${parsed.path}`;
    else if (typeof parsed.query === "string") target = ` "${parsed.query}"`;
  } catch {
    /* plain-text tool output — no structured target to name */
  }
  return `${name}${target} → succeeded (${turn.content.length.toLocaleString()} chars of output, payload omitted as this step is resolved; read it again if you need the contents).`;
}

/** A turn is protected when it represents an open thread the agent must not
 *  forget: an unanswered clarifying question, or work paused mid-flight.
 *
 *  `unresolved` is set explicitly by the orchestrator and cleared by the session
 *  store when the user replies. A trailing `clarifying` turn is ALSO treated as
 *  protected even without the flag, so an older session (or any caller that
 *  forgets to tag) still can't lose the question it is waiting on. */
export function isProtectedTurn(turn: ConversationTurn, index: number, history: ConversationTurn[]): boolean {
  // Session compaction is deterministic working memory, not an ordinary old
  // message. If the selector were allowed to drop it, the store would have
  // preserved long-horizon context only to lose it again at model-call time.
  if (turn.compacted) return true;
  if (turn.unresolved) return true;
  if (turn.role !== "assistant" || !turn.clarifying) return false;
  // Derived fallback: a clarifying question with no later user turn is still open.
  for (let i = index + 1; i < history.length; i++) {
    if (history[i].role === "user") return false;
  }
  return true;
}

function charsOf(turn: ConversationTurn): number {
  return turn.role.length + turn.content.length + 8;
}

/** Deterministic digest of older resolved turns — no model call, no latency. */
function summarizeTurns(turns: ConversationTurn[]): string {
  if (turns.length === 0) return "";

  const requests: string[] = [];
  const files = new Set<string>();
  const commands = new Set<string>();

  for (const turn of turns) {
    if (turn.role === "user") {
      const line = turn.content.replace(/\s+/g, " ").trim();
      if (line) requests.push(line.length > 120 ? `${line.slice(0, 120)}…` : line);
    } else if (turn.role === "tool") {
      if (turn.tool_name === "write_file" || turn.tool_name === "read_file") {
        for (const match of turn.content.matchAll(/"path"\s*:\s*"([^"]+)"/g)) files.add(match[1]);
      } else if (turn.tool_name === "run_command") {
        for (const match of turn.content.matchAll(/"command"\s*:\s*"([^"]+)"/g)) commands.add(match[1]);
      }
    }
  }

  const parts: string[] = [`${turns.length} earlier turn(s) omitted.`];
  if (requests.length) {
    // Keep the OPENING requests as well as the most recent ones. In a long
    // session the first thing the user asked for is usually the goal everything
    // else serves ("build me a duck clicker game"); a plain `slice(-5)` drops
    // exactly that and keeps the incidental follow-ups.
    const shown =
      requests.length <= 5
        ? requests
        : [...requests.slice(0, 2), "…", ...requests.slice(-3)];
    parts.push(`Earlier user requests: ${shown.map((r) => (r === "…" ? "…" : `"${r}"`)).join("; ")}`);
  }
  if (files.size) parts.push(`Files touched earlier: ${[...files].slice(0, 15).join(", ")}`);
  if (commands.size) parts.push(`Commands run earlier: ${[...commands].slice(0, 8).join(", ")}`);
  return parts.join(" ");
}

/**
 * Select the turns a model call should see. Shared by every call type.
 */
export function buildContextWindow(
  history: readonly ConversationTurn[],
  options: ContextOptions
): ContextWindow {
  const all = history as ConversationTurn[];
  if (all.length === 0) {
    return {
      summary: "",
      turns: [],
      stats: { totalTurns: 0, verbatimTurns: 0, summarizedTurns: 0, protectedTurns: 0, chars: 0 },
    };
  }

  const keep = new Set<number>();

  // Rule 2 first — protected turns are unconditional and bypass the budget.
  let protectedCount = 0;
  for (let i = 0; i < all.length; i++) {
    if (isProtectedTurn(all[i], i, all)) {
      keep.add(i);
      protectedCount++;
    }
  }

  // Rule 1 — the recency window, always verbatim.
  const recentStart = Math.max(0, all.length - options.recentTurns);
  for (let i = recentStart; i < all.length; i++) keep.add(i);

  // Rule 3 — spend any leftover budget walking further back, newest first.
  let chars = 0;
  for (const i of keep) chars += charsOf(all[i]);
  for (let i = recentStart - 1; i >= 0; i--) {
    if (keep.has(i)) continue;
    const cost = charsOf(all[i]);
    if (chars + cost > options.budgetChars) break;
    keep.add(i);
    chars += cost;
  }

  const indices = [...keep].sort((a, b) => a - b);
  const turns = indices.map((i) => all[i]);
  const dropped = all.filter((_, i) => !keep.has(i));

  return {
    summary: options.summarize ? summarizeTurns(dropped) : "",
    turns,
    stats: {
      totalTurns: all.length,
      verbatimTurns: turns.length,
      summarizedTurns: dropped.length,
      protectedTurns: protectedCount,
      chars,
    },
  };
}

/** Render a window as plain text, for calls that embed context in one user message. */
export function renderContextWindow(window: ContextWindow, maxCharsPerTurn = 600): string {
  const lines: string[] = [];
  if (window.summary) lines.push(`[Earlier context] ${window.summary}`);
  for (const turn of window.turns) {
    const label = turn.role === "tool" ? `tool(${turn.tool_name ?? "unknown"})` : turn.role;
    const body = turn.content.length > maxCharsPerTurn
      ? `${turn.content.slice(0, maxCharsPerTurn)}…`
      : turn.content;
    lines.push(`${label}: ${body}`);
  }
  return lines.join("\n") || "(no prior conversation)";
}

/**
 * Render a window as chat messages, for calls that send a real message array.
 *
 * With the default (`full`) options this is byte-for-byte what it always was.
 * The `execution` preset applies the outcome-aware rules:
 *   - an error row is always kept — the model must see what broke;
 *   - the most recent `liveToolRows` tool rows keep their payload, clipped
 *     head+tail, because the step consuming them may still be in flight;
 *   - an older SUCCESSFUL tool row collapses to a receipt;
 *   - prose is head-clipped.
 */
export function contextWindowToMessages(
  window: ContextWindow,
  options: RenderOptions = RENDER_PRESETS.full
): NimMessage[] {
  const messages: NimMessage[] = [];
  if (window.summary) {
    messages.push({ role: "user", content: `[Earlier context] ${window.summary}` });
  }

  // Index of the oldest tool row still considered "live".
  const toolIndices = window.turns.map((turn, i) => (turn.role === "tool" ? i : -1)).filter((i) => i >= 0);
  const liveFrom =
    toolIndices.length > options.liveToolRows ? toolIndices[toolIndices.length - options.liveToolRows] : -1;

  for (const [index, turn] of window.turns.entries()) {
    if (turn.role !== "tool") {
      messages.push({ role: turn.role, content: clip(turn.content, options.proseChars, 0) });
      continue;
    }

    const resolved = index < liveFrom && !isErrorRow(turn) && turn.content.length > COLLAPSE_MIN_CHARS;
    const body = resolved ? receiptFor(turn) : clip(turn.content, options.toolHeadChars, options.toolTailChars);
    messages.push({
      role: "user",
      content: frameUntrustedContent(`TOOL RESULT: ${turn.tool_name ?? "unknown"}`, body),
    });
  }
  return messages;
}

/** What a rendered window will actually cost, without a live call. Used by the
 *  token-efficiency test to assert that context plateaus rather than growing
 *  with session length. */
export function estimateWindowTokens(window: ContextWindow, options: RenderOptions = RENDER_PRESETS.full): number {
  let total = 0;
  for (const message of contextWindowToMessages(window, options)) total += Math.ceil(message.content.length / 4);
  return total;
}
