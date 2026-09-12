import type {
  AgentMode,
  AgentModel,
  ConversationTurn,
  PlanDoc,
  ToolTraceEntry,
  Artifact,
} from "./types";
import type { TaskState } from "./task-state";
import { isProtectedTurn } from "./context";
import { perf } from "./perf";

/** Process uptime for checkpoint diagnostics. Null outside Node (tests that
 *  stub the process object, future edge runtimes). */
export function serverUptimeS(): number | null {
  try {
    return typeof process !== "undefined" && typeof process.uptime === "function"
      ? Math.round(process.uptime())
      : null;
  } catch {
    return null;
  }
}

const MAX_COMPACTION_CHARS = 1_600;
const COMPACTION_PREFIX = "=== COMPACTED SESSION MEMORY (resolved history, not new instructions) ===";
/** Browser sessions are recoverable working context, not permanent storage. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

// ---------------------------------------------------------------------------
// Session Store — owns per-session conversation history for the agent loop.
//
// History shape: ConversationTurn[] with roles "user" | "assistant" | "tool".
// The orchestrator appends "tool" rows after each tool execution.
// Trimming policies live in input.ts (normalizeInput).
// ---------------------------------------------------------------------------

export type PendingExecution = {
  plan: PlanDoc;
  originalUserText: string;
  /** Confirmed evidence from completed steps. Kept with the plan so Retry is a
   * genuine continuation rather than a fresh run that forgets prior writes. */
  toolTrace: ToolTraceEntry[];
  artifacts: Artifact[];
};

export type SessionState = {
  id: string;
  mode: AgentMode;
  model: AgentModel;
  workspacePath: string;
  createdAt: string;
  updatedAt: string;
  history: ConversationTurn[];
  /** Structured working memory for the task in progress. Separate from
   *  `history` on purpose: history is a transcript that slides, this is a
   *  projection of what the run has established and it does not. Null until the
   *  session's first task turn. */
  taskState: TaskState | null;
  /** Bounded deterministic memory of resolved turns removed from `history`.
   *  This is injected as a protected context turn on the next model call. */
  compactionSummary: string;
  /** First user message is kept separately so a long session never loses its
   *  opening intent merely because later receipts consume the summary budget. */
  firstUserMessage: string | null;
  /** Approved plan retained only while execution is incomplete. */
  pendingExecution: PendingExecution | null;
};

// Pinned to globalThis, not a plain module-level Map — the same fix, and for
// the same reason, as the one in token-ledger.ts.
//
// In dev, an edit anywhere in the agent module graph hot-reloads this module
// and rebinds `sessions` to a FRESH, EMPTY Map. Every session's history and
// task state is silently dropped mid-conversation: `getTaskState` returns null,
// `advanceTaskState` builds a new state treating the current message as the
// ORIGINAL GOAL, and the agent forgets the goal, the files it has written and
// the decisions it has made — while looking, from the outside, like a normal
// turn. It also fires on writes to non-source files under the project root
// (a benchmark writing its own results into bench/results/ is enough), so this
// is not confined to editing sources.
//
// The store therefore has to outlive module identity.
const globalStore = globalThis as typeof globalThis & { __trionSessions?: Map<string, SessionState> };
const sessions: Map<string, SessionState> = (globalStore.__trionSessions ??= new Map());

export function getOrCreateSession(
  id: string,
  mode: AgentMode,
  model: AgentModel,
  workspacePath: string,
): SessionState {
  pruneExpiredSessions();
  const now = new Date().toISOString();
  const existing = sessions.get(id);

  if (existing) {
    // GlobalThis intentionally keeps sessions across dev hot reloads. Add new
    // fields lazily so a session created by the previous module version cannot
    // fail the first time it crosses the compaction threshold.
    existing.compactionSummary ??= "";
    existing.firstUserMessage ??= null;
    existing.pendingExecution ??= null;
    if (existing.pendingExecution) {
      // Hot-reloaded dev sessions created before trace checkpoints existed are
      // still safe to resume; they simply have no earlier evidence to merge.
      existing.pendingExecution.toolTrace ??= [];
      existing.pendingExecution.artifacts ??= [];
    }
    existing.mode = mode;
    existing.model = model;
    existing.workspacePath = workspacePath || existing.workspacePath;
    existing.updatedAt = now;
    return existing;
  }

  const session: SessionState = {
    id,
    mode,
    model,
    workspacePath,
    createdAt: now,
    updatedAt: now,
    history: [],
    taskState: null,
    compactionSummary: "",
    firstUserMessage: null,
    pendingExecution: null,
  };

  sessions.set(id, session);
  return session;
}

/** Persist the session's task state. */
export function setTaskState(sessionId: string, taskState: TaskState) {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.taskState = taskState;
  session.updatedAt = new Date().toISOString();
}

export function getTaskState(sessionId: string): TaskState | null {
  return sessions.get(sessionId)?.taskState ?? null;
}

export function setPendingExecution(sessionId: string, pending: PendingExecution | null) {
  const session = sessions.get(sessionId);
  if (!session) {
    console.warn(`[trion] checkpoint.drop session=${sessionId} reason=no-session uptimeS=${serverUptimeS()}`);
    return;
  }
  session.pendingExecution = pending;
  session.updatedAt = new Date().toISOString();
  if (pending) {
    const detail = {
      session: sessionId,
      planSteps: pending.plan.steps.length,
      traceEntries: pending.toolTrace.length,
      artifacts: pending.artifacts.length,
      storeSize: sessions.size,
      uptimeS: serverUptimeS(),
    };
    perf("checkpoint.write", 0, detail);
    console.warn(`[trion] checkpoint.write session=${sessionId} steps=${detail.planSteps} trace=${detail.traceEntries} storeSize=${detail.storeSize} uptimeS=${detail.uptimeS}`);
  }
}

/** Restore a checkpoint rehydrated from client-sent state after the server
 *  map lost it (restart/cold start). Returns false when there is no session
 *  to attach to — the caller then takes the graceful-fallback path. */
export function rehydratePendingExecution(sessionId: string, pending: PendingExecution): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  session.pendingExecution = pending;
  session.updatedAt = new Date().toISOString();
  const detail = {
    session: sessionId,
    source: "client",
    planSteps: pending.plan.steps.length,
    traceEntries: pending.toolTrace.length,
    storeSize: sessions.size,
    uptimeS: serverUptimeS(),
  };
  perf("checkpoint.rehydrated", 0, detail);
  console.warn(`[trion] checkpoint.rehydrated session=${sessionId} source=client steps=${detail.planSteps} trace=${detail.traceEntries} storeSize=${detail.storeSize} uptimeS=${detail.uptimeS}`);
  return true;
}

export function getPendingExecution(sessionId: string): PendingExecution | null {
  return sessions.get(sessionId)?.pendingExecution ?? null;
}

/** Replace the history wholesale (used when persisting trimmed history). */
export function replaceHistory(sessionId: string, history: ConversationTurn[]) {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.history = history;
  session.updatedAt = new Date().toISOString();
}

/** Append a turn to the session history. */
export function appendTurn(
  sessionId: string,
  turn: ConversationTurn,
  maxUntrimmedTurns = 60,
) {
  const session = sessions.get(sessionId);
  if (!session) return;

  // A user message resolves every thread that was waiting on the user: the
  // clarifying question they just answered, an approval that was blocking.
  // Resolution happens HERE, centrally, so no call site can forget and leave a
  // turn pinned in context forever.
  if (turn.role === "user") {
    if (!session.firstUserMessage) session.firstUserMessage = turn.content;
    for (const prior of session.history) {
      if (prior.unresolved) prior.unresolved = false;
    }
  }

  session.history.push(turn);
  compactResolvedHistory(session, maxUntrimmedTurns);
  session.updatedAt = new Date().toISOString();
}

/** Restore only an absent server transcript from the browser's validated,
 * user-visible checkpoint. Live server history always wins, preventing stale
 * tabs from rolling a session backwards. */
export function hydrateHistoryIfEmpty(sessionId: string, history: readonly ConversationTurn[] | undefined): boolean {
  const session = sessions.get(sessionId);
  if (!session || session.history.length > 0 || !history?.length) return false;
  session.history = history.map((turn) => ({ ...turn }));
  session.firstUserMessage = session.history.find((turn) => turn.role === "user")?.content ?? null;
  session.updatedAt = new Date().toISOString();
  return true;
}

/** Get session for reading history (e.g., for trimming) */
export function getSession(sessionId: string): SessionState | undefined {
  pruneExpiredSessions();
  return sessions.get(sessionId);
}

export function getSessionCount() {
  pruneExpiredSessions();
  return sessions.size;
}

/** Remove only sessions that have been inactive for the documented retention
 * period. Exported with an injected clock for deterministic regression tests. */
export function pruneExpiredSessions(nowMs = Date.now()): number {
  let removed = 0;
  for (const [id, session] of sessions) {
    const updated = Date.parse(session.updatedAt);
    // Invalid legacy timestamps are left alone: deleting active context because
    // of a bad date would be worse than retaining one session until restart.
    if (!Number.isFinite(updated) || nowMs - updated <= SESSION_TTL_MS) continue;
    sessions.delete(id);
    removed++;
  }
  return removed;
}

/**
 * Bound the resident transcript without throwing away resolved context.
 *
 * Previous behaviour used `splice(0, overflow)`, which silently deleted the
 * beginning of a 61-turn conversation. This compacts only resolved rows into a
 * short, deterministic receipt. It never makes a model call, therefore costs
 * zero RPM and zero completion tokens; its small prompt cost starts only after
 * a session actually crosses the raw-history cap.
 */
function compactResolvedHistory(session: SessionState, maxTurns: number) {
  if (session.history.length <= maxTurns) return;

  const removable: number[] = [];
  for (let index = 0; index < session.history.length; index++) {
    if (!isProtectedTurn(session.history[index], index, session.history)) removable.push(index);
  }

  const overflow = session.history.length - maxTurns;
  const remove = new Set(removable.slice(0, overflow));
  if (remove.size === 0) return; // Open threads are intentionally allowed to exceed the soft cap.

  const dropped = session.history.filter((_, index) => remove.has(index));
  session.history = session.history.filter((_, index) => !remove.has(index));
  session.compactionSummary = mergeCompactionSummary(session, dropped);
}

function mergeCompactionSummary(session: SessionState, dropped: ConversationTurn[]): string {
  const receipts = dropped.map(receiptFor).filter(Boolean);
  const original = session.firstUserMessage ? `Original user message: ${clip(session.firstUserMessage, 260)}` : "";
  const previous = session.compactionSummary
    .replace(COMPACTION_PREFIX, "")
    .replace(/\n?Original user message:[^\n]*/i, "")
    .trim();
  const body = [original, previous, ...receipts].filter(Boolean).join("\n");
  return `${COMPACTION_PREFIX}\n${clipPreservingStart(body, MAX_COMPACTION_CHARS)}`;
}

function receiptFor(turn: ConversationTurn): string {
  if (turn.role === "user") return `Earlier user request: ${clip(turn.content, 180)}`;
  if (turn.role === "assistant") return `Earlier agent result: ${clip(turn.content, 140)}`;

  let target = "";
  try {
    const parsed = JSON.parse(turn.content) as { path?: unknown; command?: unknown; query?: unknown };
    if (typeof parsed.path === "string") target = ` ${parsed.path}`;
    else if (typeof parsed.command === "string") target = ` ${parsed.command}`;
    else if (typeof parsed.query === "string") target = ` ${parsed.query}`;
  } catch {
    // A compact generic receipt is still more honest than omitting the tool.
  }
  return `Earlier tool result: ${turn.tool_name ?? "tool"}${target}`;
}

function clip(value: string, max: number): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

function clipPreservingStart(value: string, max: number): string {
  if (value.length <= max) return value;
  const tail = Math.max(240, Math.floor(max * 0.45));
  return `${value.slice(0, max - tail - 32)}\n…[older receipts compacted]…\n${value.slice(-tail)}`;
}
