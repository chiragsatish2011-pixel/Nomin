"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ArrowUp,
  BadgeCheck,
  Check,
  ChevronDown,
  Code2,
  Copy,
  FileText,
  Gauge,
  ListTree,
  MessageCircleQuestion,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
  Plus,
  Plug,
  Sparkles,
  X
} from "lucide-react";
import { NominMark } from "@/app/components/NominMark";
import { ThinkingMark } from "@/app/components/ThinkingMark";
import { readConnection, safeConnectionLabel, type ByokConfig } from "@/app/lib/byok-client";
import { Markdown } from "@/app/components/Markdown";
import { ThemeToggle } from "@/app/components/ThemeToggle";
import { TraceTree, type TraceNode } from "@/app/components/TraceTree";
import { WorkPanel, type LiveFile } from "@/app/components/WorkPanel";
import { ArtifactPanel } from "@/app/components/ArtifactPanel";
import { AccountMenu } from "@/app/components/AccountMenu";
import { useWebContainerExecutor } from "@/app/hooks/useWebContainerExecutor";
import type { AgentMode, AgentModel, Artifact, Plan, ToolTraceEntry } from "@/lib/agent/types";
import { ACTIVITY_LABELS, toAgentStatus } from "@/lib/agent/types";
import { MAX_SAVED_SESSION_BYTES, MAX_TOTAL_SAVED_SESSION_BYTES } from "@/app/lib/storage-hygiene";
import { type AgentOutput, type LegacyAgentOutput, type AgentStreamEvent, parseAgentStreamEvent } from "@/lib/agent/protocol";

const PIPELINE_STATUSES = new Set(["thinking", "planning", "executing", "synthesizing", "done", "error", "cancelled"]);

/**
 * There is no user-facing mode any more.
 *
 * "Think" vs "Execute" asked the user to make a judgement the agent is better
 * placed to make, and getting it wrong was silently punishing: a build request
 * sent in Think mode produced a plan and then quietly did nothing. Worse, the
 * toggle leaked the machinery — the user should be describing an outcome, not
 * configuring a pipeline.
 *
 * Every turn now runs in the mode that CAN act, and Step 1 classification is
 * what decides whether acting is appropriate. "hi" short-circuits to a direct
 * answer with no plan and no trace; "build me a counter" plans and executes.
 * That decision already exists and is tested — this just stops asking the user
 * to duplicate it.
 */
const AGENT_MODE: AgentMode = "execute";

/** Starting points under the landing composer. Outcomes, not tool names — the
 *  old sidebar grid said "Write / Code / Test / Deploy", which is a menu of our
 *  internals rather than anything a user came here wanting. */
const LANDING_SUGGESTIONS = [
  "Build a landing page",
  "Make a dashboard",
  "Write a small API",
  "Clean up this project",
] as const;

/**
 * The approval question, as pickable answers.
 *
 * Phrased as plain choices rather than as verbs from our pipeline. "Approve &
 * run" describes what the SYSTEM does; "Yes, go ahead" describes what the USER
 * means, and that is the only thing they are being asked.
 */
const APPROVAL_CHOICES = [
  { id: "approve", label: "Yes, go ahead", hint: "Run it now", recommended: true },
  { id: "adjust", label: "Change something first", hint: "I'll describe what to do differently" },
  { id: "reject", label: "No, don't run this", hint: "Stop and rethink the approach" },
] as const;

/**
 * Why a plan was rejected, as pickable options.
 *
 * Offering choices rather than a blank box is the difference between getting an
 * answer and getting a shrug: "what was wrong?" is hard to write and easy to
 * recognise. The first is marked Recommended because it is the one that most
 * often produces a materially better second plan — a wrong approach cannot be
 * fixed by trimming steps off it.
 */
const REJECT_REASONS = [
  {
    value: "That approach isn't right. Reconsider how to do this from the start, and propose a different plan.",
    label: "Wrong approach",
    hint: "Start over with a different strategy",
  },
  {
    value: "That plan does too much. Do the smallest thing that satisfies my request, and nothing else.",
    label: "Too much",
    hint: "Narrow it to the essentials",
  },
  {
    value: "That plan touches the wrong files or the wrong place in the project. Re-scope it to the right target.",
    label: "Wrong target",
    hint: "Right idea, wrong files",
  },
  {
    value: "I need to understand this before you run it. Explain what each step does and why, without executing anything.",
    label: "Explain it first",
    hint: "Walk me through before acting",
  },
] as const;

type AgentState = "working" | "complete" | "error";

const MODEL_TIERS = ["trion-1.4", "trion-1.9", "trion-2.3"] as const;

const MODEL_LABELS: Record<AgentModel, string> = {
  "trion-1.4": "1.4",
  "trion-1.9": "1.9",
  "trion-2.3": "2.3",
};

const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_CHARS = 200_000;

type AttachedFile = {
  name: string;
  content: string;
  size: number;
};

type TurnEntry = {
  id: number;
  role: "user" | "assistant";
  content: string;
};

type ProgressUpdate = {
  id: string;
  stage: "plan" | "paused" | "complete" | "notice" | "working";
  message: string;
  at: number;
};

type CapacityStatus = {
  ready: boolean;
  today: string;
  week: string;
  context: string;
  allowance: string;
  requestWindow: { used: number; limit: number; saturation: number };
  activity: { planning: number; building: number };
};

/** The browser-side part of a recoverable thread. This intentionally stores
 * only the user-visible checkpoint — never credentials, tool bridge handles,
 * or a runnable command. Server-side task state remains authoritative for a
 * retry. */
type SavedSession = {
  version: 2;
  turns: TurnEntry[];
  traceNodes: TraceNode[];
  liveFiles: LiveFile[];
  agentOutput: AgentOutput | null;
  submittedMessage: string | null;
  phase: string;
  error: string | null;
  progressUpdates: ProgressUpdate[];
};

/** One saved conversation, as listed in the sidebar. */
type SessionEntry = {
  id: string;
  title: string;
  updatedAt: number;
};

const SESSION_INDEX_KEY = "trion-sessions";
const SESSION_TURNS_PREFIX = "trion-session:";
const ACTIVE_SESSION_KEY = "trion-active-session";
const MAX_SAVED_SESSIONS = 40;
/** Saved chat checkpoints are recovery aids, never an unbounded local archive. */

/** Every installation is local-first. No account or remote-sync boundary exists. */
const activeSessionScope = "local";

function scopedStorageKey(key: string): string {
  return `${key}:${encodeURIComponent(activeSessionScope)}`;
}

function scopedTurnKey(id: string): string {
  return scopedStorageKey(`${SESSION_TURNS_PREFIX}${id}`);
}

// --- Client-held resume checkpoints ------------------------------------------
//
// The server keeps checkpoints in process memory, so a restart, redeploy, or
// cold start wipes them while the browser still holds the thread. The browser
// therefore snapshots the last errored turn's plan + evidence from its result
// event and re-sends it with resume:true; the server treats its own map as a
// cache and rehydrates from this payload on lookup miss. Never credentials,
// never bridge handles — only the user-visible plan and its evidence.

type ClientCheckpointSnapshot = {
  plan: Plan;
  toolTrace: ToolTraceEntry[];
  artifacts: Artifact[];
};

const CHECKPOINT_KEY_PREFIX = "trion-checkpoint:";
/** Stays comfortably under the server's 256KB validation cap. */
const MAX_CHECKPOINT_BYTES = 200_000;
const MAX_CHECKPOINT_TRACE_OUTPUT = 8_000;
const MAX_CHECKPOINT_ARTIFACT_CONTENT = 32_000;
const CLIP_MARKER = "…[clipped for checkpoint]";

function checkpointStorageKey(id: string): string {
  return scopedStorageKey(`${CHECKPOINT_KEY_PREFIX}${id}`);
}

function clipCheckpointText(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}${CLIP_MARKER}`;
}

/** Snapshot a failed turn for a later retry, or null when there is nothing
 *  resumable (success, cancellation, or no plan). Oversized snapshots are
 *  dropped rather than clipped into misleading evidence. */
function snapshotCheckpointFrom(output: AgentOutput): ClientCheckpointSnapshot | null {
  if (!output.plan || output.status !== "error") return null;
  const snapshot: ClientCheckpointSnapshot = {
    plan: output.plan,
    toolTrace: output.tool_trace.map((entry) => ({
      ...entry,
      output: clipCheckpointText(entry.output, MAX_CHECKPOINT_TRACE_OUTPUT),
    })),
    artifacts: output.artifacts.map((artifact) => ({
      ...artifact,
      content: clipCheckpointText(artifact.content, MAX_CHECKPOINT_ARTIFACT_CONTENT),
    })),
  };
  try {
    if (JSON.stringify(snapshot).length > MAX_CHECKPOINT_BYTES) return null;
  } catch {
    return null;
  }
  return snapshot;
}

function readCheckpoint(id: string): ClientCheckpointSnapshot | null {
  try {
    const raw = localStorage.getItem(checkpointStorageKey(id));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const snapshot = parsed as ClientCheckpointSnapshot;
    if (!snapshot.plan || !Array.isArray(snapshot.toolTrace) || !Array.isArray(snapshot.artifacts)) return null;
    return snapshot;
  } catch {
    return null;
  }
}

/** Persist (or clear, when snapshot is null) the thread's resume checkpoint. */
function writeCheckpoint(id: string, snapshot: ClientCheckpointSnapshot | null): void {
  try {
    if (!snapshot) {
      localStorage.removeItem(checkpointStorageKey(id));
      return;
    }
    localStorage.setItem(checkpointStorageKey(id), JSON.stringify(snapshot));
  } catch {
    // Quota or private mode — the retry simply falls back to a fresh turn.
  }
}

function readSessionIndex(): SessionEntry[] {
  try {
    const raw = localStorage.getItem(scopedStorageKey(SESSION_INDEX_KEY));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is SessionEntry =>
        typeof entry === "object" && entry !== null && typeof (entry as SessionEntry).id === "string"
    );
  } catch {
    return [];
  }
}

// --- Session index as an external store --------------------------------------
//
// localStorage IS an external system, so the conversation list is subscribed to
// rather than mirrored into component state from an effect. Mirroring it meant
// setState during render-commit, which cascades renders — and it also forced a
// choice between a hydration mismatch (read storage in the initializer) and a
// visible pop-in (read it in an effect). useSyncExternalStore has a dedicated
// server snapshot, so neither happens.

/* --- Sidebar preference -----------------------------------------------------
 *
 * A client-only value (stored preference, then viewport width) that the server
 * cannot know. Held outside React so `useSyncExternalStore` can serve the
 * server a stable `false` and the browser the real answer, with no effect
 * writing state on mount and no hydration mismatch.
 * -------------------------------------------------------------------------- */

const SIDEBAR_KEY = "nomin-sidebar-collapsed";
const sidebarListeners = new Set<() => void>();
let sidebarCollapsedState: boolean | null = null;

function readSidebarPreference(): boolean {
  try {
    const saved = window.localStorage.getItem(SIDEBAR_KEY);
    if (saved === "1") return true;
    if (saved === "0") return false;
    return window.innerWidth <= 860;
  } catch {
    return false;
  }
}

function subscribeSidebar(onChange: () => void) {
  sidebarListeners.add(onChange);
  return () => {
    sidebarListeners.delete(onChange);
  };
}

function sidebarSnapshot(): boolean {
  if (sidebarCollapsedState === null) sidebarCollapsedState = readSidebarPreference();
  return sidebarCollapsedState;
}

/** The server has no viewport and no storage; it always renders it open. */
function sidebarServerSnapshot(): boolean {
  return false;
}

function setSidebarPreference(collapsed: boolean) {
  sidebarCollapsedState = collapsed;
  try {
    window.localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0");
  } catch {
    // A remembered preference is a convenience; the app works without it.
  }
  sidebarListeners.forEach((listener) => listener());
}

const EMPTY_SESSIONS: SessionEntry[] = [];
/** Cached so the snapshot is referentially stable between notifications —
 *  returning a fresh array each call would re-render forever. */
let sessionCache: SessionEntry[] | null = null;
const sessionListeners = new Set<() => void>();

function subscribeSessions(onChange: () => void) {
  sessionListeners.add(onChange);
  return () => {
    sessionListeners.delete(onChange);
  };
}

function sessionSnapshot(): SessionEntry[] {
  if (sessionCache === null) sessionCache = readSessionIndex();
  return sessionCache;
}

function sessionServerSnapshot(): SessionEntry[] {
  return EMPTY_SESSIONS;
}

function commitSessions(next: SessionEntry[]) {
  sessionCache = next;
  try {
    localStorage.setItem(scopedStorageKey(SESSION_INDEX_KEY), JSON.stringify(next));
  } catch {
    // Quota or private mode — the list is still correct for this session.
  }
  for (const listener of sessionListeners) listener();
}

/** Record (or refresh) one conversation and its visible work checkpoint. */
function saveSession(id: string, saved: SavedSession) {
  const firstUserTurn = saved.turns.find((turn) => turn.role === "user");
  if (!firstUserTurn) return;

  const current = sessionSnapshot();
  const entry: SessionEntry = { id, title: sessionTitleFrom(firstUserTurn.content), updatedAt: Date.now() };
  let next = [entry, ...current.filter((item) => item.id !== id)].slice(0, MAX_SAVED_SESSIONS);
  const encoded = boundedSessionEncoding(saved);

  try {
    // Refuse to leave a stale oversized checkpoint behind. The active page
    // still works; only durable recovery is skipped until its visible state is
    // small enough to fit the documented retention ceiling.
    if (!encoded) {
      localStorage.removeItem(scopedTurnKey(id));
      commitSessions(next.filter((item) => item.id !== id));
      return;
    }
    localStorage.setItem(scopedTurnKey(id), encoded);
    // Enforce a total browser-storage budget by evicting the oldest saved
    // conversations first. Never evict the session being written.
    let total = savedSessionBytes(next);
    while (total > MAX_TOTAL_SAVED_SESSION_BYTES && next.length > 1) {
      const stale = next.at(-1);
      if (!stale || stale.id === id) break;
      localStorage.removeItem(scopedTurnKey(stale.id));
      next = next.slice(0, -1);
      total = savedSessionBytes(next);
    }
    // Drop transcripts that fell off the end of the index, so a long-lived
    // browser profile does not accumulate orphaned conversations forever.
    for (const stale of current) {
      if (!next.some((item) => item.id === stale.id)) {
        localStorage.removeItem(scopedTurnKey(stale.id));
      }
    }
  } catch {
    // Saving is best-effort; the conversation itself is unaffected.
  }

  commitSessions(next);
}

/** Make a bounded durable copy without changing the live conversation. Large
 * artifacts and long traces remain available during the current session, but
 * a reopened session restores the newest useful evidence instead of filling
 * localStorage indefinitely. */
function boundedSessionEncoding(saved: SavedSession): string | null {
  const bounded: SavedSession = {
    ...saved,
    turns: saved.turns.slice(-80),
    traceNodes: saved.traceNodes.slice(-160),
    liveFiles: saved.liveFiles.slice(-12),
    progressUpdates: saved.progressUpdates.slice(-40),
  };
  try {
    const encoded = JSON.stringify(bounded);
    return encoded.length <= MAX_SAVED_SESSION_BYTES ? encoded : null;
  } catch {
    return null;
  }
}

function savedSessionBytes(entries: SessionEntry[]): number {
  return entries.reduce((total, entry) => {
    try {
      return total + (localStorage.getItem(scopedTurnKey(entry.id))?.length ?? 0);
    } catch {
      return total;
    }
  }, 0);
}

function forgetSession(id: string) {
  try {
    localStorage.removeItem(scopedTurnKey(id));
  } catch {
    // Nothing to do.
  }
  commitSessions(sessionSnapshot().filter((entry) => entry.id !== id));
}

function emptySavedSession(): SavedSession {
  return {
    version: 2,
    turns: [],
    traceNodes: [],
    liveFiles: [],
    agentOutput: null,
    submittedMessage: null,
    phase: "Ready",
    error: null,
    progressUpdates: [],
  };
}

function readSavedSession(id: string): SavedSession {
  try {
    const raw = localStorage.getItem(scopedTurnKey(id));
    if (!raw) return emptySavedSession();
    const parsed: unknown = JSON.parse(raw);
    // Migration from the first transcript-only persistence format.
    if (Array.isArray(parsed)) return { ...emptySavedSession(), turns: parsed as TurnEntry[] };
    if (!parsed || typeof parsed !== "object") return emptySavedSession();
    const value = parsed as Partial<SavedSession>;
    return {
      ...emptySavedSession(),
      ...value,
      version: 2,
      turns: Array.isArray(value.turns) ? value.turns : [],
      traceNodes: Array.isArray(value.traceNodes) ? value.traceNodes : [],
      liveFiles: Array.isArray(value.liveFiles) ? value.liveFiles : [],
      progressUpdates: Array.isArray(value.progressUpdates) ? value.progressUpdates : [],
    };
  } catch {
    return emptySavedSession();
  }
}

/** First line of the opening message, which is what the user will recognise it by. */
function sessionTitleFrom(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 52 ? `${line.slice(0, 52)}…` : line || "New conversation";
}

function relativeTime(at: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

function isBridgeError(message: string): boolean {
  return /WebContainer bridge unavailable|Client disconnected before the WebContainer/i.test(message);
}

/** Keep implementation receipts out of the customer-facing failure card. The
 * detailed, saved progress view already records what completed; the error card
 * should explain the next useful action rather than leak file paths or steps. */
function presentError(message: string): string {
  if (/files? written|planned but not run|step \d+|tool call/i.test(message)) {
    return "The workspace paused before the build was fully finished. Completed work is saved, and retry will continue from the next unfinished step.";
  }
  return message;
}

/** A real composer grows with a thought. Capping it keeps long prompts from
 * swallowing the workspace while avoiding the surprising manual resize grip. */
function resizeComposer(textarea: HTMLTextAreaElement) {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
}

/** A workspace build needs a real browser snapshot; ordinary conversation
 * does not. Keeping this separate from the account gate avoids a slow sandbox
 * boot for "hello" while preserving the readiness boundary for actual tools. */
function likelyNeedsWorkspace(text: string): boolean {
  return /\b(?:build|create|make|implement|develop|code|debug|fix|refactor|redesign|website|web\s*app|landing\s*page|dashboard|component|api|project|repository|codebase|file|folder|preview|run\s+(?:the|a|npm)|install|test|lint)\b/i.test(text);
}


/**
 * Clarifications remain normal assistant text in the protocol, but numbered
 * alternatives are a real usability affordance: the user can choose one with
 * a click rather than retype it.  This deliberately parses only the concise
 * `1. Choice` shape emitted by clarification.ts; it is not a second question
 * system, a hidden tool, or a plan card.
 */
function clarificationChoices(question: string | null): { prompt: string; choices: string[] } {
  if (!question) return { prompt: "", choices: [] };
  const lines = question.split("\n");
  const choices = lines
    .map((line) => line.match(/^\s*\d+\.\s+(.+?)\s*$/)?.[1]?.trim() ?? null)
    .filter((choice): choice is string => Boolean(choice));
  const prompt = lines
    .filter((line) => !/^\s*\d+\.\s+/.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return { prompt: prompt || question, choices: choices.slice(0, 4) };
}

export default function Home() {
  const mode = AGENT_MODE;
  const [model, setModel] = useState<AgentModel>("trion-1.4");
  // 1.4 is always the safe initial route. The server confirms any extra,
  // explicitly configured tiers after hydration; no provider model ids ever
  // reach the browser.
  const [availableModels, setAvailableModels] = useState<AgentModel[]>(["trion-1.4"]);
  const [capacity, setCapacity] = useState<CapacityStatus | null>(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  // Read through an external store, never in a state initializer.
  //
  // Computing this from localStorage and window.innerWidth during the first
  // render is something the server cannot do, so on any viewport at or below
  // the breakpoint the server rendered an open sidebar, the client rendered a
  // closed one, and React threw a hydration error (#418) on every phone-sized
  // load. useSyncExternalStore is the supported way to say "the server sees
  // one value, the client sees another": it renders the server value, then
  // swaps in the real one without a mismatch.
  const sidebarCollapsed = useSyncExternalStore(subscribeSidebar, sidebarSnapshot, sidebarServerSnapshot);
  const [activeConnection, setActiveConnection] = useState<ByokConfig | null>(() => typeof window === "undefined" ? null : readConnection());
  const [message, setMessage] = useState("");
  const [submittedMessage, setSubmittedMessage] = useState<string | null>(null);
  const [outputs, setOutputs] = useState<LegacyAgentOutput[]>([]);
  const [phase, setPhase] = useState("Ready");
  const [agentState, setAgentState] = useState<AgentState>("complete");

  const [busy, setBusy] = useState(false);
  /** Shown after a few seconds of continuous work so free-tier slowness reads
   *  as expected, not frozen. Calm copy only — no internals, no model names. */
  const [slowNotice, setSlowNotice] = useState(false);
  const slowNoticeTimer = useRef<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [allowanceDismissed, setAllowanceDismissed] = useState(false);
  // Match BootIntro's first render. This avoids kicking off landing animations
  // behind the opaque intro before the boot overlay has released the page.
  // The boot splash is gone (it was a full-screen animated gate in front of a
  // workspace that was already usable), so there is nothing left to wait for:
  // the WebContainer prewarms on mount instead of after an animation.
  const introActive = false;
  const [traceNodes, setTraceNodes] = useState<TraceNode[]>([]);
  const [agentOutput, setAgentOutput] = useState<AgentOutput | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [approvalPending, setApprovalPending] = useState(false);
  const [approvalPlan, setApprovalPlan] = useState<Plan | null>(null);
  /** After a rejection, Trion asks — formally, once — what was wrong. Declining
   *  to answer is allowed; the gate closes either way. */
  const [rejectPrompt, setRejectPrompt] = useState(false);
  /** Messages typed while a turn was running. The ref is the authority (handlers
   *  close over stale state); the array mirrors it for rendering. */
  const queueRef = useRef<string[]>([]);
  // Identity of the plan currently awaiting approval. Echoed with the
  // decision so the server can reject a stale approval for a superseded plan.
  const approvalHashRef = useRef<string | null>(null);
  const [queuedMessages, setQueuedMessages] = useState<string[]>([]);
  /** Files written this conversation, shown live in the side panel. */
  const [liveFiles, setLiveFiles] = useState<LiveFile[]>([]);
  const [workPanelOpen, setWorkPanelOpen] = useState(false);
  /** Which option is ticked in the composer question. Null until the user picks. */
  const [gateChoice, setGateChoice] = useState<string | null>(null);
  /** Plain-language reason THIS approval was asked for, supplied by the server. */
  const [approvalReason, setApprovalReason] = useState("");
  const [traceCollapsed, setTraceCollapsed] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [turns, setTurns] = useState<TurnEntry[]>([]);
  const [progressUpdates, setProgressUpdates] = useState<ProgressUpdate[]>([]);
  /** The answer as it is being written. Replaced by the committed turn once the
   *  `result` event lands, so there is never a moment with both on screen. */
  const [streamingText, setStreamingText] = useState("");
  /** Which assistant row's copy button was just pressed. */
  const [copiedTurn, setCopiedTurn] = useState<number | null>(null);
  /** Seconds the current turn has been working. A long wait with no number on
   *  it reads as a hang; the same wait with a running count reads as work. */
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  /** The top bar grows a rule only once something is scrolled under it. */
  const [topBarScrolled, setTopBarScrolled] = useState(false);
  const turnSeqRef = useRef(0);
  const currentTurnSeqRef = useRef(0);
  const [currentTurnSeq, setCurrentTurnSeq] = useState(0);
  const toolCallCounts = useRef<Record<number, number>>({});
  const abortRef = useRef<AbortController | null>(null);
  // A monotonic request identity protects the UI from a cancelled/old stream
  // settling after the user has already started another turn. `turnSeq` is a
  // display identity and resets on New thread, so it cannot safely do this job.
  const activeRequestRef = useRef(0);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const traceRef = useRef<HTMLDivElement | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const previewUrlRef = useRef<string | null>(null);
  // Snapshotting a fresh browser-owned WebContainer can take longer than an
  // interactive turn should wait. Keep the last successful snapshot here and
  // hydrate it opportunistically; submitting a request must never depend on a
  // filesystem walk finishing first.
  const workspaceSnapshotRef = useRef<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const executor = useWebContainerExecutor();
  const [sessionId, setSessionId] = useState(() => crypto.randomUUID());
  const sessionHydratedRef = useRef(false);
  const sessions = useSyncExternalStore(subscribeSessions, sessionSnapshot, sessionServerSnapshot);

  /** There is no separate landing PAGE any more — there is an empty thread.
   *  This is the single condition that decides whether the composer sits in the
   *  middle of the screen or docked under a transcript. */
  const conversationStarted = turns.length > 0 || submittedMessage !== null;

  function restoreSavedSession(saved: SavedSession) {
    setTurns(saved.turns);
    setTraceNodes(saved.traceNodes);
    setLiveFiles(saved.liveFiles);
    setAgentOutput(saved.agentOutput);
    setSubmittedMessage(saved.submittedMessage);
    setPhase(saved.phase);
    setError(saved.error);
    setProgressUpdates(saved.progressUpdates);
    setWorkPanelOpen(saved.liveFiles.length > 0);
    setTraceCollapsed(Boolean(saved.traceNodes.length));
    const lastUserId = saved.turns.filter((turn) => turn.role === "user").at(-1)?.id ?? 0;
    turnSeqRef.current = lastUserId;
    currentTurnSeqRef.current = lastUserId;
    setCurrentTurnSeq(lastUserId);
  }

  // A refresh opens a fresh visible conversation. Saved conversations remain
  // in the sidebar, but automatically restoring the active one made reloads
  // feel like reopening a stuck task rather than arriving at a ready composer.
  // Later session-id changes are intentional New thread/open-session actions.
  useEffect(() => {
    if (!sessionHydratedRef.current) {
      sessionHydratedRef.current = true;
    }
    try {
      localStorage.setItem(scopedStorageKey(ACTIVE_SESSION_KEY), sessionId);
    } catch {
      // The active conversation is still usable for this page lifetime.
    }
  }, [sessionId]);

  /** Persist the transcript and visible task checkpoint. Server-side task state
   * remains authoritative for retries; this gives a reopened thread its work
   * context immediately instead of looking empty. */
  useEffect(() => {
    if (turns.length === 0) return;
    saveSession(sessionId, {
      version: 2,
      turns,
      traceNodes,
      liveFiles,
      agentOutput,
      submittedMessage,
      phase,
      error,
      progressUpdates,
    });
  }, [agentOutput, error, liveFiles, phase, progressUpdates, sessionId, submittedMessage, traceNodes, turns]);

  // Mirror the executor's preview URL into a ref so event handlers (which
  // close over older render state) always see the latest dev-server URL.
  useEffect(() => {
    previewUrlRef.current = executor.previewUrl;
  }, [executor.previewUrl]);

  useEffect(() => {
    let disposed = false;
    void fetch("/api/health")
      .then(async (response) => {
        if (!response.ok) return null;
        return response.json() as Promise<{ availableModels?: unknown }>;
      })
      .then((health) => {
        if (disposed || !Array.isArray(health?.availableModels)) return;
        const valid = health.availableModels.filter(
          (tier): tier is AgentModel => typeof tier === "string" && MODEL_TIERS.includes(tier as AgentModel)
        );
        if (valid.includes("trion-1.4")) setAvailableModels(valid);
      })
      .catch(() => {
        // The default tier remains usable if a non-critical availability check
        // cannot reach the local server during boot.
      });
    return () => {
      disposed = true;
    };
  }, []);

  // The capacity badge is a product status surface, not token telemetry. It
  // refreshes after each turn and reports which provider lane is active plus
  // context pressure, without exposing raw token counts or model identifiers.
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => {
      void fetch(`/api/trion/capacity?sessionId=${encodeURIComponent(sessionId)}`, { signal: controller.signal })
        .then((response) => response.ok ? response.json() as Promise<CapacityStatus> : null)
        .then((next) => { if (next) setCapacity(next); })
        .catch(() => undefined);
    };
    refresh();
    const interval = busy ? window.setInterval(refresh, 2_000) : null;
    return () => {
      controller.abort();
      if (interval !== null) window.clearInterval(interval);
    };
  }, [agentOutput?.status, busy, sessionId]);

  useEffect(() => {
    if (!modelMenuOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!modelMenuRef.current?.contains(event.target as Node)) setModelMenuOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [modelMenuOpen]);

  useEffect(() => {
    const refreshConnection = () => setActiveConnection(readConnection());
    window.addEventListener("nomin-connection-change", refreshConnection);
    return () => window.removeEventListener("nomin-connection-change", refreshConnection);
  }, []);


  function updateNode(id: string, patch: Partial<TraceNode>) {
    setTraceNodes((current) => current.map((node) => (node.id === id ? { ...node, ...patch } : node)));
  }

  function addNode(node: TraceNode) {
    setTraceNodes((current) => (current.some((n) => n.id === node.id) ? current : [...current, node]));
  }

  // Boot the sandbox as soon as the intro clears, not after the first message.
  // This overlaps the user's landing-page reading and typing with WebContainer
  // startup, which prevents a correct plan from appearing to stall at its
  // first real file operation.
  useEffect(() => {
    if (!introActive) executor.prewarm();
  }, [introActive, executor]);

  useEffect(() => {
    if (!conversationStarted) return;
    let disposed = false;
    void executor.getSnapshot().then((snapshot) => {
      if (!disposed && snapshot.length) workspaceSnapshotRef.current = snapshot;
    });
    return () => { disposed = true; };
  }, [conversationStarted, executor]);

  // Keep the newest content in view as the turn streams.
  //
  // Without this the thread stayed where the user left it: the task tree, the
  // answer and the live preview all appeared BELOW the fold, so a turn that had
  // finished successfully looked like it had produced nothing. Auto-scroll stops
  // the moment the user scrolls up — reading back through a long trace must not
  // be yanked away — and resumes when they return to the bottom.
  useEffect(() => {
    const scroller = chatScrollRef.current;
    if (!scroller || !stickToBottomRef.current) return;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
  }, [turns, traceNodes, phase, agentOutput, approvalPending, executor.previewUrl]);

  function handleThreadScroll() {
    const scroller = chatScrollRef.current;
    if (!scroller) return;
    const distanceFromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 120;
    setTopBarScrolled(scroller.scrollTop > 4);
  }

  // The turn clock. Started by `busy`, stopped by it, and reset between turns
  // so a new turn never inherits the previous one's count.
  useEffect(() => {
    if (!busy) return;
    const startedAt = Date.now();
    const tick = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1_000);
    return () => {
      window.clearInterval(tick);
      setElapsedSeconds(0);
    };
  }, [busy]);

  function collapseSidebar(collapsed: boolean) {
    setSidebarPreference(collapsed);
  }

  async function copyText(text: string, id: number) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedTurn(id);
      window.setTimeout(() => setCopiedTurn((current) => (current === id ? null : current)), 1_600);
    } catch {
      // Clipboard access can be denied; the text is still selectable.
    }
  }

  function newThread() {
    // A NEW THREAD is the only thing that destroys the sandbox. Tearing it down
    // at the end of every turn deleted the files the agent had just written and
    // killed the dev server the preview was pointing at, so nothing survived
    // long enough to build on.
    resetTurnState();
    void executor.reset();
    setSessionId(crypto.randomUUID());
    setTurns([]);
  }

  /** Clear everything that belongs to the turn loop, without touching which
   *  conversation we are in. Shared by "new thread" and switching sessions. */
  function resetTurnState() {
    abortRef.current?.abort();
    abortRef.current = null;
    activeRequestRef.current += 1;
    setMessage("");
    setSubmittedMessage(null);
    setOutputs([]);
    setTraceNodes([]);
    setAgentOutput(null);
    setPanelOpen(false);
    setError(null);
    setPhase("Ready");
    setAgentState("complete");
    setBusy(false);
    if (slowNoticeTimer.current !== null) window.clearTimeout(slowNoticeTimer.current);
    slowNoticeTimer.current = null;
    setSlowNotice(false);
    setApprovalPending(false);
    setApprovalPlan(null);
    approvalHashRef.current = null;
    setRejectPrompt(false);
    setTraceCollapsed(false);
    setAttachedFiles([]);
    setLiveFiles([]);
    setProgressUpdates([]);
    setStreamingText("");
    setWorkPanelOpen(false);
    setGateChoice(null);
    setApprovalReason("");
    queueRef.current = [];
    setQueuedMessages([]);
    turnSeqRef.current = 0;
    currentTurnSeqRef.current = 0;
    setCurrentTurnSeq(0);
    toolCallCounts.current = {};
    stickToBottomRef.current = true;
  }

  /** Reopen a saved conversation. The sandbox is rebuilt, because the files a
   *  previous conversation created do not belong to this one. */
  function openSession(id: string) {
    if (id === sessionId) return;
    resetTurnState();
    void executor.reset();
    setSessionId(id);
    restoreSavedSession(readSavedSession(id));
  }

  function deleteSession(id: string, event: React.MouseEvent) {
    event.stopPropagation();
    forgetSession(id);
    writeCheckpoint(id, null);
    if (id === sessionId) newThread();
  }

  /**
   * Submit the composer question.
   *
   * Three ways out, and the user picks any of them: tick an option, type an
   * answer of their own, or cancel. Typing wins over a ticked option when both
   * are present — words the user chose to write are more specific than a
   * checkbox they may have clicked first.
   */
  function submitGate() {
    const typed = message.trim();

    if (rejectPrompt) {
      if (typed) {
        setMessage("");
        submitRejectReason(typed);
        return;
      }
      if (gateChoice) submitRejectReason(gateChoice);
      setGateChoice(null);
      return;
    }

    // Approval. A typed answer means "not that — this", which is a rejection
    // with an explanation attached, so it goes straight back as the next turn.
    if (typed) {
      setMessage("");
      setGateChoice(null);
      releaseGate();
      setPhase("Adjusting");
      void sendTurn(typed);
      return;
    }

    const choice = gateChoice;
    setGateChoice(null);
    if (choice === "approve") approvePlan();
    else if (choice === "adjust") adjustPlan();
    else if (choice === "reject") cancelPlan();
  }

  function stopTurn() {
    abortRef.current?.abort();
    abortRef.current = null;
    activeRequestRef.current += 1;
    void fetch("/api/trion/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
    }).catch(() => undefined);
    // Stopping a turn stops the AGENT, not the workspace. The files it already
    // wrote and any running dev server stay exactly as they are. Anything the
    // user queued is dropped too: firing a stale follow-up after an explicit
    // Stop is never what was asked for.
    setBusy(false);
    if (slowNoticeTimer.current !== null) window.clearTimeout(slowNoticeTimer.current);
    slowNoticeTimer.current = null;
    setSlowNotice(false);
    setApprovalPending(false);
    setApprovalPlan(null);
    approvalHashRef.current = null;
    queueRef.current = [];
    setQueuedMessages([]);
    setPhase("Stopped");
    setAgentState("complete");
    setTraceNodes((current) => settleNodes(current, "cancelled"));
    setTraceCollapsed(true);
  }

  /** Answer the plan-approval gate (Step 1.5). The server is blocked until
   *  this POST lands — nothing executes while the gate is open. */
  async function postApproval(decision: "approve" | "cancel") {
    const planHash = approvalHashRef.current;
    approvalHashRef.current = null;
    setApprovalPending(false);
    setApprovalPlan(null);
    try {
      await fetch("/api/trion/approval", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, decision, ...(planHash ? { planHash } : {}) }),
      });
    } catch {
      // If the POST never lands the server-side gate times out into "cancel".
    }
  }

  function approvePlan() {
    void postApproval("approve");
    setPhase("Approved — executing");
  }

  /** Release the gate AND close out the client stream.
   *
   *  Releasing alone is not enough. `sendTurn` reassigns `abortRef`, so if the
   *  rejected turn's reader is still running when a follow-up starts, the old
   *  stream goes on dispatching events — its terminal "cancelled" result lands
   *  after the new turn has begun and wipes the new turn's state. Every exit
   *  from the gate has to stop reading, not just unblock the server. */
  function releaseGate() {
    void postApproval("cancel");
    abortRef.current?.abort();
    abortRef.current = null;
    activeRequestRef.current += 1;
    setBusy(false);
  }

  /** Reject releases the gate immediately — the server turn must never stay
   *  blocked while we ask a follow-up — and then asks why, once, formally. */
  function cancelPlan() {
    releaseGate();
    setPhase("Plan declined");
    setRejectPrompt(true);
  }

  /** The cross: decline to decide. The plan does not run and Trion does not
   *  follow up — closing a dialog is not an invitation to be asked more. */
  function dismissGate() {
    releaseGate();
    setPhase("Ready");
  }

  /** Dismissing the "why" is a real answer. Nothing is sent and the gate closes. */
  function dismissRejectPrompt() {
    setRejectPrompt(false);
    setPhase("Ready");
  }

  /** The reason becomes the next turn, so Trion replans against the objection
   *  rather than the user having to restate the whole request. */
  function submitRejectReason(reason: string) {
    const trimmed = reason.trim();
    setRejectPrompt(false);
    if (!trimmed) {
      setPhase("Ready");
      return;
    }
    void sendTurn(trimmed);
  }

  function adjustPlan() {
    releaseGate();
    setPhase("Adjusting — describe the change");
    composerRef.current?.focus();
  }

  function openFilePicker() {
    fileInputRef.current?.click();
  }

  async function handleFilePick(event: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(event.target.files ?? []);
    // Allow re-picking the same file next time.
    event.target.value = "";

    if (picked.length === 0) return;
    if (attachedFiles.length + picked.length > MAX_ATTACHMENTS) {
      setError(`You can attach up to ${MAX_ATTACHMENTS} files.`);
      return;
    }

    const next: AttachedFile[] = [...attachedFiles];
    for (const file of picked) {
      const content = await file.text();
      if (content.length > MAX_ATTACHMENT_CHARS) {
        setError(`"${file.name}" is too large to attach (limit ~200 KB).`);
        continue;
      }
      next.push({ name: file.name, content, size: file.size });
    }
    setAttachedFiles(next);
    setError(null);
    setPhase(next.length > 0 ? `Attached: ${next.map((f) => f.name).join(", ")}` : "Ready");
  }

  function removeAttachment(name: string) {
    setAttachedFiles((current) => current.filter((file) => file.name !== name));
  }

  async function submitMessage() {
    const submitted = message.trim();
    if (!submitted) return;
    // A decision is open. Nothing may be sent past it — that is the whole point
    // of the gate being modal.
    if (gateOpen) return;

    // QUEUE rather than drop.
    //
    // Sending while a turn is running used to be simply ignored, so a second
    // thought typed mid-build vanished with no feedback at all. It is now held
    // and sent the moment the current turn ends — the message is never lost and
    // never races the turn in flight.
    if (busy) {
      queueRef.current = [...queueRef.current, submitted];
      setQueuedMessages(queueRef.current);
      setMessage("");
      return;
    }

    // Clear the input immediately on send (not when the response arrives).
    setMessage("");
    await sendTurn(submitted);
  }

  function removeQueued(index: number) {
    queueRef.current = queueRef.current.filter((_, i) => i !== index);
    setQueuedMessages(queueRef.current);
  }

  /** Re-send the failed turn without requiring the user to retype it. */
  async function retrySubmission() {
    const submitted = submittedMessage;
    if (!submitted || busy) return;
    await sendTurn(submitted, true);
  }

  async function sendTurn(submitted: string, resume = false) {
    performance.mark("trion.submit.start");
    setBusy(true);
    // Free-tier turns routinely take 30s+. If nothing has resolved after 5s,
    // say so plainly instead of leaving a bare spinner.
    setSlowNotice(false);
    if (slowNoticeTimer.current !== null) window.clearTimeout(slowNoticeTimer.current);
    slowNoticeTimer.current = window.setTimeout(() => setSlowNotice(true), 5_000);
    setAllowanceDismissed(false);
    setError(null);
    setOutputs([]);
    setSubmittedMessage(submitted);
    setPhase("Responding");
    setAgentState("working");
    setTraceNodes([]);
    setAgentOutput(null);
    setProgressUpdates([]);
    setStreamingText("");
    setPanelOpen(false);
    // This is a per-turn preview list, not the workspace itself. Carrying it
    // into a new/retried request made a pause at zero actions claim that an
    // unrelated previous file had just been created. The WebContainer and any
    // running preview intentionally remain alive.
    setLiveFiles([]);
    setWorkPanelOpen(false);
    toolCallCounts.current = {};
    const controller = new AbortController();
    abortRef.current = controller;
    const requestId = ++activeRequestRef.current;
    // The server emits a status or tool event at every genuine state boundary.
    // A live HTTP connection with no event is therefore not progress; it is a
    // stalled turn. Keep this above the longest bounded planning retry (two
    // 45-second attempts plus backoff) while preventing the old multi-minute
    // locked-composer failure mode.
    const MAX_SILENT_STREAM_MS = 105_000;
    let stalled = false;
    let connectionTimedOut = false;
    let stallWatchdog: number | null = null;
    // Workspace boot/snapshot has its own deadlines. Do not count that local
    // preparation against the network-response deadline: a cold browser
    // workspace can take longer than 30 seconds before the chat request is
    // even sent.
    let connectionWatchdog: number | null = null;
    const armStallWatchdog = () => {
      if (stallWatchdog !== null) window.clearTimeout(stallWatchdog);
      stallWatchdog = window.setTimeout(() => {
      stalled = true;
      controller.abort();
      }, MAX_SILENT_STREAM_MS);
    };

    // Persist the user message in the running conversation — history survives
    // new turns (the old behavior cleared everything on every send).
    if (resume) {
      // A retry is a continuation command, not a second copy of the same user
      // message. Remove only the old terminal report for this request; the
      // server will rebuild the plan from its checkpoint and append the new,
      // evidence-based outcome under the original message.
      const turnSeq = currentTurnSeqRef.current;
      setTurns((current) => current.filter((turn) => !(turn.id === turnSeq && turn.role === "assistant")));
      setCurrentTurnSeq(turnSeq);
    } else {
      const turnSeq = ++turnSeqRef.current;
      currentTurnSeqRef.current = turnSeq;
      setCurrentTurnSeq(turnSeq);
      setTurns((current) => [...current, { id: turnSeq, role: "user", content: submitted }]);
    }

    try {
      // Plan-mode and conversation do not need a browser workspace. An execute
      // turn does: starting the agent before WebContainer has mounted was the
      // root of the repeated "plan succeeded, zero actions ran" failure. Wait
      // here for the real workspace and send its actual tree with the request.
      // This is a readiness gate, not a retry and not a new model request.
      let snapshot = workspaceSnapshotRef.current;
      if (mode === "execute" && likelyNeedsWorkspace(submitted)) {
        setPhase(executor.booting ? "Preparing workspace" : "Checking workspace");
        snapshot = await executor.prepareForExecution();
        workspaceSnapshotRef.current = snapshot;
      }
      performance.mark("trion.submit.beforeFetch");
      connectionWatchdog = window.setTimeout(() => {
        connectionTimedOut = true;
        stalled = true;
        controller.abort();
      }, 30_000);

      const response = await fetch("/api/trion/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          sessionId,
          userText: submitted,
          mode,
          model,
          workspacePath: "workspace",
          snapshot,
          history: turns.map(({ role, content }) => ({ role, content })),
          attachments: attachedFiles.map((file) => ({ path: file.name, content: file.content })),
          resume,
          // Client-held checkpoint for server-map misses after a restart.
          // Only ever sent on an explicit retry of the same thread.
          ...(resume ? { checkpoint: readCheckpoint(sessionId) ?? undefined } : {}),
          byok: readConnection() ?? undefined,
        })
      });
      if (connectionWatchdog !== null) window.clearTimeout(connectionWatchdog);
      connectionWatchdog = null;
      performance.mark("trion.submit.response");

      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "Request failed.");
      }

      armStallWatchdog();

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let receivedTerminalEvent = false;

      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.trim() && activeRequestRef.current === requestId) {
            const event = parseAgentStreamEvent(JSON.parse(line));
            armStallWatchdog();
            if (event.type === "result" || event.type === "error") receivedTerminalEvent = true;
            handleStreamEvent(event);
          }
        }

        if (done) break;
      }

      if (buffer.trim() && activeRequestRef.current === requestId) {
        const event = parseAgentStreamEvent(JSON.parse(buffer));
        armStallWatchdog();
        if (event.type === "result" || event.type === "error") receivedTerminalEvent = true;
        handleStreamEvent(event);
      }

      // A proxy, dev-server restart, or server-side stream fault can close a
      // response cleanly without a final NDJSON event. Treating that as a
      // completed turn left the UI in "Working" with a disabled composer.
      // This costs no model request and gives the user an actionable retry.
      if (!receivedTerminalEvent && activeRequestRef.current === requestId) {
        setError("The response ended before the task finished. Your completed workspace changes are still available; retry the task to continue.");
        setPhase("Needs attention");
        setAgentState("error");
      }
    } catch (requestError) {
      performance.mark("trion.submit.error");
      if (controller.signal.aborted) {
        if (stalled) {
          setError(connectionTimedOut
            ? "The Trion server did not accept the request in time. The page was protected from hanging; restart the local server, then retry. Your workspace was not restarted."
            : "The task stopped reporting progress, so Trion paused it instead of leaving the composer locked. Completed workspace changes are still available; retry to continue from them.");
          setPhase("Needs attention");
          setAgentState("error");
        } else {
          // User pressed Stop — this is expected, not an error
          setPhase("Stopped");
          setAgentState("complete");
        }
        return;
      }
      const messageText = requestError instanceof Error ? requestError.message : "Trion request failed.";
      setError(messageText);
      setPhase("Needs attention");
      setAgentState("error");
    } finally {
      if (connectionWatchdog !== null) window.clearTimeout(connectionWatchdog);
      if (stallWatchdog !== null) window.clearTimeout(stallWatchdog);
      // A newer turn owns these controls now. An old request must never clear
      // its busy state, erase its abort controller, or drain its queue.
      if (activeRequestRef.current === requestId) {
        if (abortRef.current === controller) abortRef.current = null;
        setBusy(false);
        if (slowNoticeTimer.current !== null) window.clearTimeout(slowNoticeTimer.current);
        slowNoticeTimer.current = null;
        setSlowNotice(false);
        drainQueue();
      }
    }
  }

  /** Send the next queued message, if the turn that just ended left one behind.
   *
   *  Called from `finally`, so it runs whether the turn completed, errored or
   *  was stopped — a queue that only drained on success would strand messages
   *  the moment anything went wrong. */
  function drainQueue() {
    if (queueRef.current.length === 0) return;
    const [next, ...rest] = queueRef.current;
    queueRef.current = rest;
    setQueuedMessages(rest);
    void sendTurn(next);
  }

  function handleStreamEvent(event: AgentStreamEvent) {
    if (event.type === "progress") {
      setProgressUpdates((current) => {
        const update: ProgressUpdate = {
          id: `${event.stage}-${Date.now()}-${current.length}`,
          stage: event.stage,
          message: event.message,
          at: Date.now(),
        };
        return [...current, update].slice(-4);
      });
      return;
    }

    // The answer, arriving as it is written. `reset` means the server retried
    // and threw away what it had already sent.
    if (event.type === "delta") {
      if (event.reset) {
        setStreamingText("");
        return;
      }
      if (event.text) setStreamingText((current) => current + event.text);
      return;
    }

    // Status events drive the thinking indicator (Agent Reasoning phase)
    if (event.type === "status") {
      const status = toAgentStatus(event.status, "responding");
      const label = ACTIVITY_LABELS[status] || "Working";
      setPhase(label);
      setAgentState(status === "done" ? "complete" : status === "error" ? "error" : "working");

      // THE TREE BEGINS AT THE PLAN.
      //
      // It used to begin here, on "thinking" — which the state machine emits at
      // STEP 0, before classification has even run. So every turn spawned a
      // node, including "hi": the turn then short-circuited to a direct answer
      // and emitted nothing else, leaving "Classify intent" spinning forever
      // under a conversational reply, with a task counter beneath it.
      //
      // A checklist is only honest once there is work to check off. Statuses
      // before the plan now drive the phase text and nothing else, so a turn
      // that never plans never renders a tree at all.
      const isPipeline = PIPELINE_STATUSES.has(status);
      if (!isPipeline) {
        // AI-chosen activity. Only relabels a node that already exists — it
        // never brings the tree into being.
        setTraceNodes((current) =>
          current.map((node) => (node.id === "intent" ? { ...node, label, status: "running" } : node))
        );
      }

      if (status === "planning") {
        addNode({ id: "plan-root", kind: "plan", label: "Build execution plan", status: "running", parentId: null });
      }
      if (status === "executing") {
        updateNode("plan-root", { status: "done" });
        // Steps go running one at a time, driven by plan_update. Flipping every
        // pending step to "running" here lit the whole checklist at once, so the
        // tree showed six tasks in flight when one was.
      }
      if (status === "synthesizing") {
        // Same rule: only extend a tree that already exists. Synthesis runs on
        // every turn, so adding a node unconditionally would put a one-item
        // checklist under every conversational reply.
        setTraceNodes((current) => {
          if (current.length === 0) return current;
          const settled = current.map((node) => (node.status === "running" ? { ...node, status: "done" as const } : node));
          if (settled.some((node) => node.id === "synthesis")) return settled;
          return [...settled, { id: "synthesis", kind: "synthesis" as const, label: "Write the result", status: "running" as const, parentId: null }];
        });
      }
      // A step still "pending" when the turn ends never ran — that is a
      // cancellation, not a completion. Marking it done put a green check on
      // work nobody did.
      if (status === "done") {
        setTraceNodes((current) => settleNodes(current));
      }
      if (status === "error") {
        setTraceNodes((current) => settleNodes(current, "error"));
      }
      if (status === "cancelled") {
        setPhase("Cancelled");
        setAgentState("complete");
        setApprovalPending(false);
        setApprovalPlan(null);
        setTraceNodes((current) => settleNodes(current, "cancelled"));
        addNode({ id: "synthesis", kind: "synthesis", label: "Turn cancelled — nothing executed", status: "cancelled", parentId: null });
      }
      return;
    }

    if (event.type === "plan_skipped") {
      // Plan-only mode: the orchestrator explicitly reports why Step 3 did
      // not run instead of skipping silently.
      setPhase("Plan mode — no execution");
      addNode({ id: "plan-skip", kind: "intent", label: "Plan mode — execution skipped (no steps ran)", status: "done", parentId: null });
      return;
    }

    if (event.type === "plan_approval") {
      setApprovalPlan(event.plan);
      approvalHashRef.current = event.planHash;
      setApprovalReason(event.reason ?? "");
      setGateChoice(null);
      setApprovalPending(true);
      setPhase("Awaiting your approval");
      setAgentState("working");
      return;
    }

    if (event.type === "plan") {
      // A plan with no summary is a server bug, but rendering the words
      // "Plan — undefined" into the user's conversation is ours. Fall back to
      // the step count, which the plan always has.
      const planSummary = typeof event.plan.summary === "string" && event.plan.summary.trim()
        ? event.plan.summary.trim()
        : `${event.plan.steps.length} ${event.plan.steps.length === 1 ? "step" : "steps"}`;
      setPhase(`Plan: ${planSummary}`);
      setAgentState("working");
      updateNode("intent", { status: "done" });
      addNode({ id: "plan-root", kind: "plan", label: `Plan — ${planSummary}`, status: "done", parentId: null });
      event.plan.steps.forEach((step, index) => {
        addNode({
          id: `step-${step.step_id}`,
          kind: "step",
          label: `Step ${index + 1}: ${step.description}`,
          status: "pending",
          parentId: "plan-root",
          stepId: step.step_id,
        });
      });
      return;
    }

    if (event.type === "plan_update") {
      // The server sends every state verbatim, including "cancelled" for steps
      // skipped by an early finish. Collapsing them all to done/error/running
      // discarded that distinction and showed skipped steps as completed.
      updateNode(`step-${event.step_id}`, { status: event.state });
      setPhase(
        event.state === "error"
          ? "Step failed — retrying"
          : event.state === "running"
            ? "Working through the plan"
            : "Executing steps"
      );
      return;
    }

    if (event.type === "tool_call") {
      setPhase(`Running: ${event.call.tool_name}`);
      setAgentState("working");
      // Open the work surface for the first real tool call, not only after a
      // write_file. Install/read/search steps can legitimately happen before
      // the first file exists; hiding the panel made an active build look
      // frozen and left Preview with no honest status context.
      setWorkPanelOpen(true);

      // Capture what is being written so the side panel can show it live.
      // The content is already in flight for the WebContainer — nothing extra
      // is requested, so watching the build costs no tokens and no round trip.
      if (event.call.tool_name === "write_file") {
        const input = event.call.tool_input as { path?: unknown; content?: unknown };
        if (typeof input?.path === "string" && typeof input?.content === "string") {
          const path = input.path;
          const content = input.content;
          setLiveFiles((current) => {
            const existing = current.findIndex((file) => file.path === path);
            if (existing >= 0) {
              const next = [...current];
              next[existing] = { path, content };
              return next;
            }
            return [...current, { path, content }];
          });
          setWorkPanelOpen(true);
        }
      }
      const stepId = event.call.step_id;
      const count = (toolCallCounts.current[stepId] ?? 0) + 1;
      toolCallCounts.current[stepId] = count;
      const isRetry = count > 1;
      addNode({
        id: `tool-${stepId}-${count}`,
        kind: isRetry ? "retry" : "tool",
        label: `${event.call.tool_name}${isRetry ? " (retry)" : ""}`,
        status: "running",
        parentId: `step-${stepId}`,
        stepId,
        toolName: event.call.tool_name,
        attempt: count,
        detail: JSON.stringify(event.call.tool_input, null, 2),
      });

      // Execute in the WebContainer via the client executor (server is waiting)
      if (event.call.execution_id) {
        void executor.executeTool(
          {
            tool_name: event.call.tool_name,
            tool_input: event.call.tool_input,
            step_id: event.call.step_id,
            execution_id: event.call.execution_id,
          },
          sessionId
        );
      }
      return;
    }

    if (event.type === "tool_result") {
      setPhase(event.status === "success" ? "Verifying result" : event.status === "approval_required" ? "Approval required" : "Fixing error");
      setAgentState(event.status === "approval_required" ? "complete" : "working");
      const count = toolCallCounts.current[event.step_id] ?? 1;
      const nodeId = `tool-${event.step_id}-${count}`;
      updateNode(nodeId, {
        status: event.status === "success" ? "done" : event.status === "approval_required" ? "done" : "error",
        result: event.output ?? (event.status === "success" ? "tool completed successfully" : event.status === "approval_required" ? "Approval required" : "Tool failed — retrying"),
      });
      return;
    }


    if (event.type === "output") {
      setOutputs((current: LegacyAgentOutput[]) => current.some((output) => sameOutput(output, event.output)) ? current : [...current, event.output]);
      if (event.output.type === "chat_reply") {
        // Commit the completed answer to the running conversation so it stays
        // visible after the next message (the live block only shows the
        // current turn's widgets).
        const seq = currentTurnSeqRef.current;
        setTurns((current) =>
          current.some((turn) => turn.id === seq && turn.role === "assistant")
            ? current
            : [...current, { id: seq, role: "assistant", content: event.output.type === "chat_reply" ? event.output.content : "" }]
        );
        // The committed turn now renders this text; keeping the streamed copy
        // would show it twice.
        setStreamingText("");
      }
      if (event.output.type === "error") {
        setError(event.output.message);
        setAgentState("error");
      }
      return;
    }

    if (event.type === "error") {
      setError(event.error.message);
      setPhase("Needs attention");
      setAgentState("error");
      return;
    }

    // A turn emits exactly ONE result event, carrying the AgentOutput. The
    // legacy AgentResult event was removed server-side: both fired, both ran
    // this end-of-turn block, and the sandbox was torn down twice.
    if (event.type === "result" && event.data && "artifacts" in event.data) {
      const output = event.data as AgentOutput;
      const cancelled = output.status === "cancelled";
      setAgentState(output.status === "error" ? "error" : "complete");
      setPhase(cancelled ? "Cancelled" : output.status === "error" ? "Needs attention" : "Done");
      setApprovalPending(false);
      setApprovalPlan(null);
      setAgentOutput(output);
      // The browser is the durable side of the resume checkpoint: the server
      // map is process-local and dies on restart. Snapshot errored turns with
      // a plan; anything else clears the checkpoint (done, cancelled, plan-less).
      writeCheckpoint(sessionId, snapshotCheckpointFrom(output));
      // Turn is complete — collapse the trace into the docked pill. The sandbox
      // stays up: it holds the user's project.
      setTraceCollapsed(true);

      if (output.artifacts.length > 0 && output.status === "done") setPanelOpen(true);
      if (previewUrlRef.current && output.status === "done") setPanelOpen(true);

      // Enrich tool/retry nodes with the real per-attempt output from tool_trace
      if (output.tool_trace.length > 0) {
        setTraceNodes((current) =>
          current.map((node) => {
            if (node.kind !== "tool" && node.kind !== "retry") return node;
            const entry = output.tool_trace.find(
              (t) => t.step_id === node.stepId && t.tool_name === node.toolName && t.attempt === (node.attempt ?? 1)
            );
            if (!entry) return node;
            return {
              ...node,
              status: entry.status === "success" ? "done" : "error",
              result: entry.output,
              attempt: entry.attempt,
            };
          })
        );
      }

      // Close the tree out — but only if there IS one. A direct answer reaches
      // here with an empty trace, and capping it with a "Synthesize answer" node
      // is what put a one-item checklist under every "hi".
      if (!cancelled && output.tool_trace.length === 0 && !output.plan) return;

      addNode({
        id: "synthesis",
        kind: "synthesis",
        label: cancelled ? "Turn cancelled" : "Synthesize answer",
        status: cancelled ? "done" : output.status === "done" ? "done" : "error",
        parentId: null,
        result: output.message,
      });
      // A terminal error must never be painted as completed work.  This was
      // the source of the contradictory "0 actions" / "3 of 6 complete"
      // state: a failed runner returned while its step node was still running,
      // then this unconditional mapper turned it green in the collapsed pill.
      setTraceNodes((current) => settleNodes(current, output.status === "done" ? "done" : "error"));
    }
  }

const chatReply = [...outputs].reverse().find((output): output is Extract<LegacyAgentOutput, { type: "chat_reply" }> => output.type === "chat_reply");
  const showAgentStatus = agentState === "working" || traceNodes.length > 0;

  // The last turn ended by asking something. The composer becomes the answer bar
  // until the user replies.
  const pendingQuestion = agentOutput?.status === "needs_clarification" && !busy ? agentOutput.message : null;
  const questionPrompt = clarificationChoices(pendingQuestion);

  /** Any modal decision is open, so the rest of the interface is inert. */
  const gateOpen = (approvalPending && Boolean(approvalPlan)) || rejectPrompt;

  const stepNodes = traceNodes.filter((node) => node.kind === "step");
  const doneSteps = stepNodes.filter((node) => node.status === "done").length;
  const taskSummaryLabel = stepNodes.length
    ? doneSteps === stepNodes.length
      ? "Work completed"
      : `${doneSteps} of ${stepNodes.length} steps complete`
    : "Show progress";
  const failedTool = [...traceNodes]
    .reverse()
    .find((node) => (node.kind === "tool" || node.kind === "retry") && node.status === "error");
  const isAllowanceFailure = /included building allowance|building allowance (?:is|was) (?:currently )?(?:exhausted|reached)/i.test(`${error ?? ""} ${agentOutput?.message ?? ""}`);
  const allowanceExhausted = !allowanceDismissed && isAllowanceFailure;

  // NOTE: there is deliberately no "previewRequested" any more.
  //
  // It derived panel visibility from executor.previewUrl, which OUTLIVES the
  // turn that started the dev server. So after any build, every subsequent
  // message — including "thanks" — reopened a preview panel beside a one-line
  // chat reply. Visibility is now driven by what THIS turn did (a write_file
  // call opens the panel) plus the user's own choice.

  /** The assistant row for the turn that is on screen now.
   *
   *  It has three possible sources, in order: the text still streaming, the
   *  committed transcript entry for this turn, and the chat_reply output. They
   *  are one expression because they are one row — rendering the committed
   *  entry from the transcript list instead put this turn's ANSWER above its
   *  own status line and step list, since the transcript is drawn before the
   *  live block. */
  const committedAnswer = turns.find((turn) => turn.id === currentTurnSeq && turn.role === "assistant")?.content;
  const liveAnswer = streamingText || committedAnswer || chatReply?.content || "";

  // Held back for the first two seconds: a counter that flashes "1s" on every
  // quick turn is noise, and the number only means anything once a wait is
  // long enough to wonder about.
  const elapsedLabel = elapsedSeconds < 2
    ? null
    : elapsedSeconds < 60
      ? `${elapsedSeconds}s`
      : `${Math.floor(elapsedSeconds / 60)}m ${elapsedSeconds % 60}s`;

  const currentThreadTitle = sessions.find((entry) => entry.id === sessionId)?.title
    ?? (turns.find((turn) => turn.role === "user")?.content ?? "New chat");

  /* ONE composer, rendered either in the middle of an empty thread or docked
     under a transcript. It used to exist twice, in two slightly different
     forms, which is why the landing box had no queue, no attachments and no
     stop button. */
  const composer = (
    <>
      {gateOpen ? (
        <div className="nmGate" role="group" aria-label="Trion needs an answer">
          <div className="nmGateHead">
            {rejectPrompt ? <MessageCircleQuestion size={14} /> : <BadgeCheck size={14} />}
            <span>{rejectPrompt ? "One question" : "Before I run this"}</span>
            <button
              type="button"
              onClick={() => {
                setGateChoice(null);
                if (rejectPrompt) dismissRejectPrompt();
                else dismissGate();
              }}
            >
              Cancel
            </button>
          </div>

          <p className="nmGateAsk">{rejectPrompt ? "What was wrong with that plan?" : "Do you want me to run this?"}</p>
          <p className="nmGateWhy">
            {rejectPrompt
              ? "Pick the closest one, or write your own below. It shapes the next attempt."
              : approvalReason || "This makes changes worth seeing first. Pick an answer, or write what you’d rather I do."}
          </p>

          {!rejectPrompt && approvalPlan ? (
            <ol className="nmGateSteps">
              {approvalPlan.steps.map((step) => <li key={step.step_id}>{step.description}</li>)}
            </ol>
          ) : null}

          <div className="nmGateChoices" role="radiogroup">
            {(rejectPrompt
              ? REJECT_REASONS.map((reason, index) => ({ id: reason.value, label: reason.label, hint: reason.hint, recommended: index === 0 }))
              : APPROVAL_CHOICES.map((choice) => ({ ...choice, recommended: "recommended" in choice && choice.recommended }))
            ).map((option) => {
              const picked = gateChoice === option.id;
              return (
                <button
                  className={picked ? "nmGateChoice picked" : "nmGateChoice"}
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={picked}
                  onClick={() => setGateChoice(picked ? null : option.id)}
                >
                  <span className="nmGateTick" aria-hidden="true">{picked ? <Check size={11} /> : null}</span>
                  <span className="nmGateChoiceBody">
                    <strong>
                      {option.label}
                      {option.recommended ? <em className="nmGateTag">Recommended</em> : null}
                    </strong>
                    <small>{option.hint}</small>
                  </span>
                </button>
              );
            })}
          </div>

          <div className="nmGateFoot">
            <span>{gateChoice ? "Ready to submit." : "Tick one, or type your own answer below."}</span>
            <button className="nmGateSubmit" type="button" disabled={!gateChoice && !message.trim()} onClick={submitGate}>
              Submit
            </button>
          </div>
        </div>
      ) : null}

      {queuedMessages.length > 0 ? (
        <div className="nmQueued">
          <span>{queuedMessages.length} queued — {busy ? "sending after this turn" : "sending now"}</span>
          {queuedMessages.map((text, index) => (
            <span className="nmQueuedChip" key={`${index}-${text.slice(0, 12)}`}>
              <span>{text}</span>
              <button type="button" onClick={() => removeQueued(index)} aria-label="Remove from queue"><X size={11} /></button>
            </span>
          ))}
        </div>
      ) : null}

      <div className="nmComposer">
        {!approvalPending && pendingQuestion ? (
          <div className="nmGate" style={{ margin: 10, marginBottom: 0 }}>
            <div className="nmGateHead"><MessageCircleQuestion size={14} /><span>One answer to continue</span></div>
            <p className="nmGateAsk">{questionPrompt.prompt}</p>
            {questionPrompt.choices.length > 0 ? (
              <div className="nmSuggestions" style={{ justifyContent: "flex-start" }}>
                {questionPrompt.choices.map((choice) => (
                  <button
                    className="nmSuggestion"
                    key={choice}
                    type="button"
                    onClick={() => {
                      setMessage(choice);
                      requestAnimationFrame(() => composerRef.current?.focus());
                    }}
                  >
                    {choice}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        <textarea
          aria-label={pendingQuestion ? "Answer Trion" : "Message Trion"}
          placeholder={
            gateOpen
              ? "…or answer in your own words"
              : busy
                ? "Type to queue a follow-up…"
                : pendingQuestion
                  ? "Type your answer…"
                  : "Message Trion…"
          }
          onChange={(event) => {
            setMessage(event.target.value);
            resizeComposer(event.currentTarget);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (gateOpen) submitGate();
              else void submitMessage();
            }
          }}
          ref={composerRef}
          rows={1}
          spellCheck={false}
          value={message}
        />

        {attachedFiles.length > 0 ? (
          <div className="nmAttachments">
            {attachedFiles.map((file) => (
              <span className="nmAttachment" key={file.name}>
                <FileText size={12} />
                <span>{file.name}</span>
                <button type="button" onClick={() => removeAttachment(file.name)} aria-label={`Remove ${file.name}`}><X size={11} /></button>
              </span>
            ))}
          </div>
        ) : null}

        <input aria-label="Attach files" className="fileInputHidden" multiple onChange={(event) => void handleFilePick(event)} ref={fileInputRef} type="file" />

        <div className="nmComposerRow">
          <button className="nmComposerTool" type="button" title="Attach file" aria-label="Attach file" onClick={openFilePicker}>
            <Paperclip size={17} />
          </button>
          <span className="nmComposerSpacer" />
          <div className="nmModelMenu" ref={modelMenuRef}>
            <button
              className="nmModelTrigger"
              type="button"
              aria-haspopup="menu"
              aria-expanded={modelMenuOpen}
              onClick={() => setModelMenuOpen((open) => !open)}
            >
              <Sparkles size={13} />
              <span>{activeConnection ? safeConnectionLabel(activeConnection) : `Trion ${MODEL_LABELS[model]}`}</span>
              <ChevronDown size={12} />
            </button>
            <div className={`nmModelPopover${modelMenuOpen ? " open" : ""}`} role="menu" aria-label="Model" aria-hidden={!modelMenuOpen}>
              {activeConnection ? (
                <a className="nmModelOption" href="/connections">
                  <span><strong>Connected model</strong><small>{activeConnection.model}</small></span>
                  <Check size={14} />
                </a>
              ) : null}
              {MODEL_TIERS.map((tier) => {
                const available = availableModels.includes(tier);
                return (
                  <button
                    className="nmModelOption"
                    disabled={!available}
                    key={tier}
                    role="menuitem"
                    type="button"
                    tabIndex={modelMenuOpen ? 0 : -1}
                    onClick={() => { setModel(tier); setModelMenuOpen(false); }}
                  >
                    <span><strong>Trion {MODEL_LABELS[tier]}</strong><small>{available ? "Available in this build" : "Not configured"}</small></span>
                    {model === tier ? <Check size={14} /> : null}
                  </button>
                );
              })}
              <a className="nmModelLink" href="/connections">Connect or manage your own model</a>
            </div>
          </div>
          {busy ? (
            <button className="nmSend stop" onClick={stopTurn} type="button" title="Stop" aria-label="Stop the current turn">
              <span className="nmStopSquare" />
            </button>
          ) : (
            <button className="nmSend" disabled={!message.trim() || gateOpen} onClick={submitMessage} type="button" title="Send (Enter)" aria-label="Send">
              <ArrowUp size={18} />
            </button>
          )}
        </div>
      </div>
      {busy && slowNotice ? (
        <p className="nmComposerHint" role="status">Still working — this can take up to a minute on the shared service.</p>
      ) : null}
    </>
  );

  return (
    <main className={`nmShell${sidebarCollapsed ? " collapsed" : ""}`}>
      {allowanceExhausted ? (
        <section className="allowanceModal" role="dialog" aria-modal="true" aria-labelledby="allowance-title">
          <div className="allowanceCard">
            <NominMark size={44} title="Nomin" />
            <p>Building paused</p>
            <h2 id="allowance-title">You’ve reached your included building allowance.</h2>
            <span>It will become available again when your connected plan resets. If you do not want to wait, connect your own model and continue this saved build from the next unfinished step.</span>
            <div>
              <a href="/connections">Connect your own model</a>
              <button type="button" onClick={() => setAllowanceDismissed(true)}>Not now</button>
            </div>
          </div>
        </section>
      ) : null}

      {/* ONE sidebar, for every state of the app. It used to be written twice —
          once for the landing screen and once for the workspace — which is how
          the landing copy ended up without an active-conversation state. */}
      <aside className="nmSidebar" aria-label="Conversations">
        <div className="nmSidebarHead">
          <span className="nmBrand"><NominMark size={26} title="Nomin" /><span className="nominWordmark">Nomin</span></span>
          <button className="nmIconButton" type="button" onClick={() => collapseSidebar(true)} title="Close sidebar" aria-label="Close sidebar">
            <PanelLeftClose size={17} />
          </button>
        </div>

        <button className="nmNewChat" type="button" onClick={newThread}>
          <Plus size={16} />
          <span>New chat</span>
        </button>

        <div className="nmSidebarScroll">
          <p className="nmSideLabel">Chats</p>
          {sessions.length === 0 ? (
            <p className="nmEmptyHistory">Your conversations appear here.</p>
          ) : (
            <ul className="nmThreadList">
              {sessions.map((entry) => (
                <li key={entry.id}>
                  <button
                    className={entry.id === sessionId ? "nmThreadItem active" : "nmThreadItem"}
                    type="button"
                    onClick={() => openSession(entry.id)}
                    title={`${entry.title} · ${relativeTime(entry.updatedAt)}`}
                  >
                    {entry.title}
                  </button>
                  <button
                    className="nmThreadDelete"
                    type="button"
                    onClick={(event) => deleteSession(entry.id, event)}
                    title="Delete conversation"
                    aria-label={`Delete ${entry.title}`}
                  >
                    <X size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="nmSidebarFoot">
          <button
            className={workPanelOpen ? "nmNavItem active" : "nmNavItem"}
            type="button"
            onClick={() => { setWorkPanelOpen(true); setPanelOpen(false); }}
          >
            <Code2 size={16} />
            <span>Workspace</span>
          </button>
          <button
            className={panelOpen ? "nmNavItem active" : "nmNavItem"}
            type="button"
            onClick={() => { setPanelOpen(true); setWorkPanelOpen(false); }}
          >
            <FileText size={16} />
            <span>Artifacts</span>
          </button>
          <a className="nmNavItem" href="/connections"><Plug size={16} /><span>Connections</span></a>
          <a className="nmNavItem" href="/capacity"><Gauge size={16} /><span>Capacity{capacity?.context ? ` · ${capacity.context}` : ""}</span></a>
        </div>
      </aside>

      {/* Tapping the page closes the drawer on a phone; inert on a desktop,
          where the sidebar is part of the layout rather than over it. */}
      <button className="nmScrim" type="button" aria-label="Close sidebar" tabIndex={-1} onClick={() => collapseSidebar(true)} />

      <section className="nmMain">
        {sidebarCollapsed ? (
          <button className="nmIconButton nmReveal" type="button" onClick={() => collapseSidebar(false)} title="Open sidebar" aria-label="Open sidebar">
            <PanelLeftOpen size={18} />
          </button>
        ) : null}

        <header className={`nmTopBar${topBarScrolled ? " scrolled" : ""}`}>
          <span className="nmTopTitle" style={{ marginLeft: sidebarCollapsed ? 40 : 4 }}>
            {conversationStarted ? currentThreadTitle : "New chat"}
          </span>
          <div className="nmTopActions">
            <span
              className={`nmChip ${executor.bootError ? "error" : executor.previewUrl ? "live" : executor.booting ? "busy" : ""}`}
              title={executor.bootError ?? "In-browser sandbox running your project"}
            >
              <span className="nmDot" aria-hidden="true" />
              {executor.bootError
                ? "Sandbox error"
                : executor.previewUrl
                  ? "Preview live"
                  : executor.state === "installing"
                    ? "Installing"
                    : executor.state === "booting"
                      ? "Booting"
                      : executor.state === "ready"
                        ? "Sandbox ready"
                        : "Sandbox idle"}
            </span>
            <ThemeToggle />
            <AccountMenu />
          </div>
        </header>

        {conversationStarted ? (
          <div
            className="nmScroll"
            ref={chatScrollRef}
            onScroll={handleThreadScroll}
            onClick={() => {
              if (!workPanelOpen) return;
              if (!window.getSelection()?.isCollapsed) return;
              setWorkPanelOpen(false);
            }}
          >
            <div className="nmColumn">
              {/* Every turn is the same row. The live one is simply the last:
                  previously only the in-flight turn could show its trace, its
                  status or its error, so scrolling up through a conversation
                  showed answers with no evidence attached to them. */}
              {turns
                // The current turn's answer belongs to the live block below,
                // which also carries its status, steps and errors.
                .filter((turn) => !(submittedMessage && turn.role === "assistant" && turn.id === currentTurnSeq))
                .map((turn) =>
                turn.role === "user" ? (
                  <section className="nmTurn" key={`u-${turn.id}`}>
                    <div className="nmUser">{turn.content}</div>
                  </section>
                ) : (
                  <section className="nmTurn" key={`a-${turn.id}`}>
                    <Markdown className="nmAssistant">{turn.content}</Markdown>
                    <div className="nmRowActions">
                      <button className="nmRowAction" type="button" onClick={() => void copyText(turn.content, turn.id)}>
                        {copiedTurn === turn.id ? <Check size={13} /> : <Copy size={13} />}
                        <span>{copiedTurn === turn.id ? "Copied" : "Copy"}</span>
                      </button>
                    </div>
                  </section>
                )
              )}

              {submittedMessage ? (
                <section className="nmTurn" aria-live="polite">
                  {showAgentStatus ? (
                    <div className="nmThinking" role="status">
                      {agentState === "complete" ? (
                        <span className="nmStatusDone"><Check size={11} /></span>
                      ) : agentState === "error" ? (
                        <span className="nmStatusError"><X size={11} /></span>
                      ) : (
                        <ThinkingMark size={17} />
                      )}
                      {/* The label shimmers only while work is in flight; a
                          finished or failed turn states its outcome plainly. */}
                      <span className={agentState === "working" ? "nmThinkingLabel" : undefined}>{phase}</span>
                      {agentState === "working" && elapsedLabel ? (
                        <span className="nmThinkingElapsed">{elapsedLabel}</span>
                      ) : null}
                    </div>
                  ) : null}

                  {progressUpdates.length > 0 ? (
                    <div className="nmUpdates" aria-label="Work updates">
                      {progressUpdates.map((update) => (
                        <span key={update.id}>{update.message}</span>
                      ))}
                    </div>
                  ) : null}

                  {traceNodes.length > 0 ? (
                    <div ref={traceRef}>
                      {traceCollapsed ? (
                        <button className="nmTraceToggle" type="button" onClick={() => setTraceCollapsed(false)}>
                          <ListTree size={13} />
                          <span>{taskSummaryLabel}</span>
                          <ChevronDown size={13} />
                        </button>
                      ) : (
                        <>
                          {/* No panel around it. The tree IS the content: a
                              border here made the execution look like an
                              embedded widget rather than part of the turn. */}
                          <TraceTree nodes={traceNodes} />
                          <button className="nmTraceToggle" type="button" style={{ marginTop: 12 }} onClick={() => setTraceCollapsed(true)}>
                            <ChevronDown size={13} style={{ transform: "rotate(180deg)" }} />
                            <span>Hide steps</span>
                          </button>
                        </>
                      )}
                    </div>
                  ) : null}

                  {/* The answer, live. `streamingText` is what the model has
                      written so far; once the turn commits, the same text is a
                      normal transcript row and this clears. */}
                  {liveAnswer ? (
                    <Markdown className={busy ? "nmAssistant streaming" : "nmAssistant"}>{liveAnswer}</Markdown>
                  ) : null}

                  {error ? (
                    <div className="nmNotice error" role="alert">
                      <span>
                        {isBridgeError(error) ? (
                          <>
                            <strong>{failedTool?.toolName ? `Couldn’t complete ${failedTool.toolName.replace("_", " ")}.` : "Browser workspace unavailable."}</strong>{" "}
                            Keep this tab open so the workspace can run it, then retry.
                            {executor.bootError ? ` Details: ${executor.bootError}` : ""}
                          </>
                        ) : presentError(error)}
                      </span>
                      {isAllowanceFailure ? (
                        <a className="nmNoticeAction primary" href="/connections">Connect your own model</a>
                      ) : (
                        <button className="nmNoticeAction primary" type="button" onClick={() => void retrySubmission()}>Retry</button>
                      )}
                      <button className="nmNoticeAction" type="button" onClick={newThread}>New chat</button>
                    </div>
                  ) : null}

                  {phase === "Stopped" && !busy ? (
                    <div className="nmNotice" role="status">
                      <span>Stopped. Everything already written to the workspace is kept.</span>
                      <button className="nmNoticeAction primary" type="button" onClick={() => void retrySubmission()}>Continue</button>
                    </div>
                  ) : null}

                  {!workPanelOpen && liveFiles.length > 0 && agentOutput?.status === "done" ? (
                    <button className="nmTraceToggle" type="button" onClick={() => setWorkPanelOpen(true)}>
                      <Code2 size={13} />
                      <span>
                        {liveFiles.length} {liveFiles.length === 1 ? "file" : "files"}
                        {executor.previewUrl ? " · preview running" : ""}
                      </span>
                    </button>
                  ) : null}
                </section>
              ) : null}
            </div>
          </div>
        ) : (
          /* The empty state is not a different page. Same shell, same composer
             component, centred — so sending the first message moves the box
             down rather than replacing the screen. */
          <div className="nmWelcome">
            <div className="nmWelcomeHead">
              <NominMark size={56} title="Nomin" />
              <h1>What are you building?</h1>
              <p>Describe the outcome. Nomin plans it, builds it in a sandbox in this tab, and shows you what runs.</p>
            </div>
            {composer}
            <div className="nmSuggestions">
              {LANDING_SUGGESTIONS.map((suggestion) => (
                <button
                  className="nmSuggestion"
                  key={suggestion}
                  type="button"
                  onClick={() => {
                    setMessage(suggestion);
                    requestAnimationFrame(() => {
                      const box = composerRef.current;
                      if (!box) return;
                      box.focus();
                      resizeComposer(box);
                    });
                  }}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        {conversationStarted ? <div className="nmDock">{composer}</div> : null}

        <WorkPanel
          open={workPanelOpen}
          files={liveFiles}
          working={busy}
          previewUrl={executor.previewUrl}
          previewStatus={executor.state}
          serverCommand={executor.serverCommand}
          logs={executor.logs}
          error={executor.bootError}
          onStop={executor.stopDevServer}
          onClose={() => setWorkPanelOpen(false)}
        />

        <ArtifactPanel
          artifacts={agentOutput?.artifacts ?? []}
          open={panelOpen}
          onClose={() => setPanelOpen(false)}
          previewUrl={executor.previewUrl}
        />
      </section>
    </main>
  );
}


/** Close out the tree at the end of a turn.
 *
 *  A node still "running" finished (nothing reports back after the turn ends);
 *  a node still "pending" never started, so it is cancelled, not done. Marking
 *  both "done" was how a turn that stopped after step 2 of 6 rendered six green
 *  checks — a claim the user could see was false by scrolling up. */
function settleNodes(nodes: TraceNode[], runningOutcome: TraceNode["status"] = "done"): TraceNode[] {
  return nodes.map((node) => {
    if (node.status === "running") return { ...node, status: runningOutcome };
    if (node.status === "pending") return { ...node, status: "cancelled" as const };
    return node;
  });
}

function sameOutput(left: LegacyAgentOutput, right: LegacyAgentOutput) {
  if (left.type !== right.type) return false;
  if (left.type === "chat_reply" && right.type === "chat_reply") return left.content === right.content;
  if (left.type === "code_artifact" && right.type === "code_artifact") return left.path === right.path && left.code === right.code;
  if (left.type === "tool_call" && right.type === "tool_call") return left.action === right.action && JSON.stringify(left.input) === JSON.stringify(right.input);
  if (left.type === "error" && right.type === "error") return left.code === right.code && left.message === right.message;
  return false;
}




