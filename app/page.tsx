"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ArrowUp,
  BadgeCheck,
  Check,
  ChevronDown,
  Code2,
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
import { AmbientCanvas } from "@/app/components/AmbientCanvas";
import { BootIntro } from "@/app/components/BootIntro";
import { JellyfishMark } from "@/app/components/JellyfishMark";
import { LandingJellyfish } from "@/app/components/LandingJellyfish";
import { readConnection, safeConnectionLabel, type ByokConfig } from "@/app/lib/byok-client";
import { Markdown } from "@/app/components/Markdown";
import { ThemeToggle } from "@/app/components/ThemeToggle";
import { TraceTree, type TraceNode } from "@/app/components/TraceTree";
import { WorkPanel, type LiveFile } from "@/app/components/WorkPanel";
import { ArtifactPanel } from "@/app/components/ArtifactPanel";
import { AccountMenu } from "@/app/components/AccountMenu";
import { useAuth } from "@/app/components/AuthProvider";
import { deleteCloudSession, loadCloudSessions, saveCloudSession } from "@/app/lib/cloud-sessions";
import { useWebContainerExecutor } from "@/app/hooks/useWebContainerExecutor";
import type { AgentMode, AgentModel, Plan } from "@/lib/agent/types";
import { ACTIVITY_LABELS, toAgentStatus } from "@/lib/agent/types";
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
  stage: "plan" | "paused" | "complete";
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

/** Account-owned browser state stays unavailable until auth hydration ends. */
let activeSessionScope = "pending";

function scopedStorageKey(key: string): string {
  return `${key}:${encodeURIComponent(activeSessionScope)}`;
}

function scopedTurnKey(id: string): string {
  return scopedStorageKey(`${SESSION_TURNS_PREFIX}${id}`);
}

function readSessionIndex(): SessionEntry[] {
  try {
    if (!activeSessionScope.startsWith("user:")) return [];
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
    if (activeSessionScope.startsWith("user:")) {
      localStorage.setItem(scopedStorageKey(SESSION_INDEX_KEY), JSON.stringify(next));
    }
  } catch {
    // Quota or private mode — the list is still correct for this session.
  }
  for (const listener of sessionListeners) listener();
}

function switchSessionScope(scope: string) {
  if (!scope || scope === activeSessionScope) return;
  activeSessionScope = scope;
  sessionCache = null;
  for (const listener of sessionListeners) listener();
}

/** Record (or refresh) one conversation and its visible work checkpoint. */
function saveSession(id: string, saved: SavedSession) {
  // Signed-out conversations are intentionally ephemeral. This prevents a
  // later account from inheriting history created by another browser user.
  if (!activeSessionScope.startsWith("user:")) return;
  const firstUserTurn = saved.turns.find((turn) => turn.role === "user");
  if (!firstUserTurn) return;

  const current = sessionSnapshot();
  const entry: SessionEntry = { id, title: sessionTitleFrom(firstUserTurn.content), updatedAt: Date.now() };
  const next = [entry, ...current.filter((item) => item.id !== id)].slice(0, MAX_SAVED_SESSIONS);

  try {
    localStorage.setItem(scopedTurnKey(id), JSON.stringify(saved));
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
  void saveCloudSession({ id, title: entry.title, updatedAt: entry.updatedAt, checkpoint: saved }).catch(() => undefined);
}

function forgetSession(id: string) {
  try {
    if (activeSessionScope.startsWith("user:")) localStorage.removeItem(scopedTurnKey(id));
  } catch {
    // Nothing to do.
  }
  commitSessions(sessionSnapshot().filter((entry) => entry.id !== id));
  void deleteCloudSession(id).catch(() => undefined);
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
    if (!activeSessionScope.startsWith("user:")) return emptySavedSession();
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

/**
 * The account gate intentionally lives in the browser, before fetch. It is a
 * conservative cost-control decision, not a second intent classifier: simple
 * conversation stays instant, while work that can consume planning/building
 * capacity asks the person to sign in before a provider request is created.
 */
function requiresAccountForRequest(text: string): boolean {
  return /\b(?:build|create|make|implement|develop|code|debug|fix|refactor|redesign|design|website|web\s*app|landing\s*page|dashboard|component|api|project|repository|codebase|architecture|deep(?:ly)?\s+(?:analy[sz]e|reason|research)|research\s+(?:and|the|this)|compare\s+(?:the|these)|plan\s+(?:a|the)|review\s+(?:my|this)\s+code)\b/i.test(text);
}

/** A workspace build needs a real browser snapshot; ordinary conversation
 * does not. Keeping this separate from the account gate avoids a slow sandbox
 * boot for "hello" while preserving the readiness boundary for actual tools. */
function likelyNeedsWorkspace(text: string): boolean {
  return /\b(?:build|create|make|implement|develop|code|debug|fix|refactor|redesign|website|web\s*app|landing\s*page|dashboard|component|api|project|repository|codebase|file|folder|preview|run\s+(?:the|a|npm)|install|test|lint)\b/i.test(text);
}

function capacityLabel(capacity: CapacityStatus | null): string {
  if (!capacity) return "Checking";
  if (capacity.requestWindow.saturation >= 1) return "At capacity";
  if (capacity.requestWindow.saturation >= 0.75) return "Busy";
  return capacity.activity.building ? "Building" : capacity.activity.planning ? "Planning" : "Ready";
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
  // Landing page shows first; the chat interface mounts once the user starts.
  const [landing, setLanding] = useState(true);
  const mode = AGENT_MODE;
  const [model, setModel] = useState<AgentModel>("trion-1.4");
  // 1.4 is always the safe initial route. The server confirms any extra,
  // explicitly configured tiers after hydration; no provider model ids ever
  // reach the browser.
  const [availableModels, setAvailableModels] = useState<AgentModel[]>(["trion-1.4"]);
  const [capacity, setCapacity] = useState<CapacityStatus | null>(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    const saved = window.localStorage.getItem("nomin-sidebar-collapsed");
    return saved === "1" || (saved === null && window.innerWidth <= 720);
  });
  const [activeConnection, setActiveConnection] = useState<ByokConfig | null>(() => typeof window === "undefined" ? null : readConnection());
  const [message, setMessage] = useState("");
  const [submittedMessage, setSubmittedMessage] = useState<string | null>(null);
  const [outputs, setOutputs] = useState<LegacyAgentOutput[]>([]);
  const [phase, setPhase] = useState("Ready");
  const [agentState, setAgentState] = useState<AgentState>("complete");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allowanceDismissed, setAllowanceDismissed] = useState(false);
  const [signInGateRequest, setSignInGateRequest] = useState<string | null>(null);
  // Match BootIntro's first render. This avoids kicking off landing animations
  // behind the opaque intro before the boot overlay has released the page.
  const [introActive, setIntroActive] = useState(true);
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
  const switchExecutorScope = executor.switchScope;
  const [sessionId, setSessionId] = useState(() => crypto.randomUUID());
  const sessionHydratedRef = useRef(false);
  const sessions = useSyncExternalStore(subscribeSessions, sessionSnapshot, sessionServerSnapshot);
  const { user, loading: authLoading } = useAuth();
  const identityScope = authLoading ? "pending" : user ? `user:${user.uid}` : "anonymous";
  const identityScopeRef = useRef("pending");

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

  // Swap every account-owned browser surface as one boundary. The old user's
  // checkpoint stays under their UID; the incoming identity starts with no
  // inherited transcript or workspace while its own records hydrate.
  useEffect(() => {
    if (identityScope === identityScopeRef.current) return;
    identityScopeRef.current = identityScope;
    switchSessionScope(identityScope);
    activeRequestRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    setLanding(true);
    setSessionId(crypto.randomUUID());
    restoreSavedSession(emptySavedSession());
    workspaceSnapshotRef.current = [];
    void switchExecutorScope(identityScope);
  }, [identityScope, switchExecutorScope]);

  // A refresh opens a fresh visible conversation. Saved conversations remain
  // in the sidebar, but automatically restoring the active one made reloads
  // feel like reopening a stuck task rather than arriving at a ready composer.
  // Later session-id changes are intentional New thread/open-session actions.
  useEffect(() => {
    if (!sessionHydratedRef.current) {
      sessionHydratedRef.current = true;
    }
    try {
      if (activeSessionScope.startsWith("user:")) {
        localStorage.setItem(scopedStorageKey(ACTIVE_SESSION_KEY), sessionId);
      }
    } catch {
      // The active conversation is still usable for this page lifetime.
    }
  }, [sessionId]);

  // Firestore is the signed-in cross-device copy; localStorage remains the
  // immediate/offline cache. Hydration is additive and newest-wins so signing
  // in never erases a newer conversation already present in this browser.
  useEffect(() => {
    if (!user || identityScope !== `user:${user.uid}`) return;
    let disposed = false;
    void loadCloudSessions().then((remote) => {
      if (disposed || !remote.length) return;
      const local = sessionSnapshot();
      const merged = new Map(local.map((entry) => [entry.id, entry]));
      for (const entry of remote) {
        const current = merged.get(entry.id);
        if (!current || entry.updatedAt > current.updatedAt) {
          merged.set(entry.id, { id: entry.id, title: entry.title, updatedAt: entry.updatedAt });
          try { localStorage.setItem(scopedTurnKey(entry.id), JSON.stringify(entry.checkpoint)); } catch { /* offline cache is best-effort */ }
        }
      }
      commitSessions([...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SAVED_SESSIONS));
    }).catch(() => undefined);
    return () => { disposed = true; };
  }, [identityScope, user]);

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
    if (landing) return;
    let disposed = false;
    void executor.getSnapshot().then((snapshot) => {
      if (!disposed && snapshot.length) workspaceSnapshotRef.current = snapshot;
    });
    return () => { disposed = true; };
  }, [landing, executor]);

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
    setSignInGateRequest(null);
    setPhase("Ready");
    setAgentState("complete");
    setBusy(false);
    setApprovalPending(false);
    setApprovalPlan(null);
    setRejectPrompt(false);
    setTraceCollapsed(false);
    setAttachedFiles([]);
    setLiveFiles([]);
    setProgressUpdates([]);
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
    setLanding(false);
  }

  function deleteSession(id: string, event: React.MouseEvent) {
    event.stopPropagation();
    forgetSession(id);
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

  /** Leave the landing card straight into a running turn, carrying whatever the
   *  user already typed. `message` is current at click time, so submitMessage
   *  picks it up without a round trip through state. */
  function beginFromLanding() {
    const submitted = message.trim();
    if (!submitted) return;
    if (!authLoading && !user && requiresAccountForRequest(submitted)) {
      setSignInGateRequest(submitted);
      return;
    }
    setLanding(false);
    void submitMessage();
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
    // wrote and any running dev server stay exactly as they are.
    setBusy(false);
    setApprovalPending(false);
    setApprovalPlan(null);
    setPhase("Stopped");
    setAgentState("complete");
    setTraceNodes((current) => settleNodes(current, "cancelled"));
    setTraceCollapsed(true);
  }

  /** Answer the plan-approval gate (Step 1.5). The server is blocked until
   *  this POST lands — nothing executes while the gate is open. */
  async function postApproval(decision: "approve" | "cancel") {
    setApprovalPending(false);
    setApprovalPlan(null);
    try {
      await fetch("/api/trion/approval", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, decision }),
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

    // This must happen before queueing, WebContainer preparation, or fetch.
    // A signed-out build is not a partially started build; it has zero model
    // requests and zero workspace mutations until the person signs in.
    if (!authLoading && !user && requiresAccountForRequest(submitted)) {
      setSignInGateRequest(submitted);
      return;
    }

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
    setAllowanceDismissed(false);
    setError(null);
    setOutputs([]);
    setSubmittedMessage(submitted);
    setPhase("Responding");
    setAgentState("working");
    setTraceNodes([]);
    setAgentOutput(null);
    setProgressUpdates([]);
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
      setApprovalReason(event.reason ?? "");
      setGateChoice(null);
      setApprovalPending(true);
      setPhase("Awaiting your approval");
      setAgentState("working");
      return;
    }

    if (event.type === "plan") {
      setPhase(`Plan: ${event.plan.summary}`);
      setAgentState("working");
      updateNode("intent", { status: "done" });
      addNode({ id: "plan-root", kind: "plan", label: `Plan — ${event.plan.summary}`, status: "done", parentId: null });
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

  return (
    <main
      className={[
        "zenApp",
        introActive ? "introActive" : "",
        sidebarCollapsed ? "sidebarCollapsed" : "",
        // The composer is position:fixed, so it cannot see the side panel in
        // the flex row. This tells it to stop where the panel starts —
        // otherwise the input bar runs underneath the code view.
        workPanelOpen && !landing ? "withPanel" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <AmbientCanvas />
      <div className="ambientVeil" />
      <BootIntro onActiveChange={setIntroActive} />

      {allowanceExhausted ? <section className="allowanceModal" role="dialog" aria-modal="true" aria-labelledby="allowance-title">
        <div className="allowanceCard">
          <JellyfishMark size={48} title="Nomin" />
          <p>Building paused</p>
          <h2 id="allowance-title">You’ve reached your included building allowance.</h2>
          <span>It will become available again when your connected plan resets. If you do not want to wait, connect your own model and continue this saved build from the next unfinished step.</span>
          <div><a href="/connections">Connect your own model</a><button type="button" onClick={() => setAllowanceDismissed(true)}>Not now</button></div>
        </div>
      </section> : null}
      {signInGateRequest ? <section className="allowanceModal signInGateModal" role="dialog" aria-modal="true" aria-labelledby="sign-in-gate-title">
        <div className="allowanceCard signInGateCard">
          <JellyfishMark size={48} title="Nomin" />
          <p>Save your work</p>
          <h2 id="sign-in-gate-title">Sign in before starting this build.</h2>
          <span>Your request has not been sent yet. Signing in lets Trion keep the conversation and any project work with your account, so you can safely return to it later.</span>
          <div><a href={`/login?next=${encodeURIComponent("/")}`}>Sign in to continue</a><button type="button" onClick={() => setSignInGateRequest(null)}>Not now</button></div>
        </div>
      </section> : null}

      {landing ? (
        <section className={`landingPage${sidebarCollapsed ? " sidebarCollapsed" : " withLandingSidebar"}`}>
          <aside className={`landingSidebar${sidebarCollapsed ? " collapsed" : ""}`} aria-label="Conversations">
            <div className="landingSidebarHead">
              <span className="landingSidebarBrand"><JellyfishMark size={38} title="Nomin" /><span className="nominWordmark">Nomin</span></span>
              <button type="button" onClick={() => { setSidebarCollapsed(true); localStorage.setItem("nomin-sidebar-collapsed", "1"); }} title="Collapse sidebar" aria-label="Collapse sidebar"><PanelLeftClose size={17} /></button>
            </div>
            <button className="newThreadButton" type="button" onClick={newThread}><Plus size={17} /><span>New thread</span></button>
            {user ? <nav className="primaryNav landingPrimaryNav" aria-label="Settings and status">
              <a className="primaryNavItem" href="/connections"><Plug size={17} /><span>Connections</span></a>
            </nav> : null}
            <section className="sideModule historyModule">
              <p className="sideLabel">Conversations</p>
              {sessions.length === 0 ? <p className="historyEmpty">No conversations yet. Start one here.</p> : (
                <ul className="historyList">{sessions.map((entry) => (
                  <li key={entry.id}>
                    <button className="historyItem" type="button" onClick={() => openSession(entry.id)} title={entry.title}><span className="historyTitle">{entry.title}</span><span className="historyMeta">{relativeTime(entry.updatedAt)}</span></button>
                    <button className="historyDelete" type="button" onClick={(event) => deleteSession(entry.id, event)} aria-label={`Delete ${entry.title}`}><X size={13} /></button>
                  </li>
                ))}</ul>
              )}
            </section>
          </aside>
          {sidebarCollapsed ? <button className="landingSidebarReveal" type="button" onClick={() => { setSidebarCollapsed(false); localStorage.setItem("nomin-sidebar-collapsed", "0"); }} title="Open conversations" aria-label="Open conversations"><PanelLeftOpen size={18} /></button> : null}
          <div className="landingThemeSlot">
            {user ? <a className="capacityChip compact" href="/capacity" title="View context and provider capacity">
              <Gauge size={15} />
              <span>{capacity?.context ?? "Capacity"}</span>
            </a> : null}
            <ThemeToggle />
            <AccountMenu />
          </div>
          <div className="landingCard">
            {/* The welcome animation is its own thing. The thinking indicator's
                motion is a WORKING signal and must stay unique to that state —
                reusing it here would teach the user that the shape moving means
                "busy", then contradict it on the first screen they ever see. */}
            <div className="landingGlyph welcoming">
              <LandingJellyfish size={112} title="Nomin" />
            </div>
            <h1>What are you building?</h1>
            <p className="landingSub">
              Describe the outcome. Nomin will plan, build, and show you what is running.
            </p>
            <p className="landingBrand">NOMIN <span>CODING AGENT</span></p>

            {/* A composer, not a Start button. The first thing you see is the
                thing you type into — the pattern every serious assistant now
                uses, because a landing screen that only says "Start" makes the
                user pay for an extra click before saying anything. */}
            {/* Same shell as the docked composer in the workspace — one
                component's worth of visual language, so crossing from the
                landing card into a conversation reads as the box moving down
                rather than a different screen loading. */}
            <div className="composerShell landing">
              <textarea
                aria-label="Describe what you want built"
                placeholder="What should we build?"
                ref={composerRef}
                value={message}
                onChange={(event) => {
                  setMessage(event.target.value);
                  resizeComposer(event.currentTarget);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    if (message.trim()) beginFromLanding();
                  }
                }}
                spellCheck={false}
              />
              <div className="composerControls">
                <div className="leftComposerTools">
                  <button type="button" title="Attach file" aria-label="Attach file" onClick={openFilePicker}>
                    <Paperclip size={18} />
                  </button>
                </div>
                <div className="rightComposerTools">
                  {user ? <a className="composerModelTag" href="/connections" title="Choose a model connection">{activeConnection ? safeConnectionLabel(activeConnection) : `Trion ${MODEL_LABELS[model]}`}</a> : <span className="composerModelTag">{`Trion ${MODEL_LABELS[model]}`}</span>}
                  <button
                    className="sendOrb"
                    type="button"
                    disabled={!message.trim()}
                    onClick={beginFromLanding}
                    title="Send to Trion"
                    aria-label="Send to Trion"
                  >
                    <ArrowUp size={20} />
                  </button>
                </div>
              </div>
            </div>

            <div className="landingSuggestions">
              {LANDING_SUGGESTIONS.map((suggestion) => (
                <button
                  className="landingSuggestion"
                  key={suggestion}
                  type="button"
                  onClick={() => {
                    setMessage(suggestion);
                    composerRef.current?.focus();
                  }}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        </section>
      ) : (
      <>
      <aside className={`zenSidebar${sidebarCollapsed ? " collapsed" : ""}`}>
        <div className="sidebarCaustic" aria-hidden="true" />
        <div className="studioBrand">
          <div className="brandGlyph"><JellyfishMark size={54} /></div>
          <div>
            <h1 className="nominWordmark">Nomin</h1>
            <p>Coding agent</p>
          </div>
          <button className="sidebarCollapse" type="button" onClick={() => { setSidebarCollapsed(true); localStorage.setItem("nomin-sidebar-collapsed", "1"); }} title="Collapse sidebar" aria-label="Collapse sidebar"><PanelLeftClose size={17} /></button>
        </div>

        <button className="newThreadButton" type="button" onClick={newThread} title="Start a new thread" aria-label="Start a new thread">
          <Plus size={18} />
          <span>New thread</span>
        </button>

        <nav className="primaryNav" aria-label="Primary navigation">
          <button
            className={!workPanelOpen && !panelOpen ? "primaryNavItem active" : "primaryNavItem"}
            type="button"
            aria-pressed={!workPanelOpen && !panelOpen}
            onClick={() => { setWorkPanelOpen(false); setPanelOpen(false); }}
          >
            <MessageCircleQuestion size={17} />
            <span>Agent</span>
          </button>
          <button
            className={workPanelOpen ? "primaryNavItem active" : "primaryNavItem"}
            type="button"
            aria-pressed={workPanelOpen}
            onClick={() => { setWorkPanelOpen(true); setPanelOpen(false); }}
          >
            <Code2 size={17} />
            <span>Workspace</span>
          </button>
          <button
            className={panelOpen ? "primaryNavItem active" : "primaryNavItem"}
            type="button"
            aria-pressed={panelOpen}
            onClick={() => { setPanelOpen(true); setWorkPanelOpen(false); }}
          >
            <FileText size={17} />
            <span>Artifacts</span>
          </button>
          {user ? <a className="primaryNavItem" href="/connections">
            <Plug size={17} />
            <span>Connections</span>
          </a> : null}
        </nav>

        {/* Conversations, not shortcuts. The old "Write / Code / Test / Deploy"
            grid advertised the machinery and threw away the one thing a user
            actually comes back for: what they were doing yesterday. */}
        <section className="sideModule historyModule">
          <p className="sideLabel">Conversations</p>
          {sessions.length === 0 ? (
            <p className="historyEmpty">Your conversations will appear here.</p>
          ) : (
            <ul className="historyList">
              {sessions.map((entry) => (
                <li key={entry.id}>
                  <button
                    className={entry.id === sessionId ? "historyItem active" : "historyItem"}
                    type="button"
                    onClick={() => openSession(entry.id)}
                    title={entry.title}
                  >
                    <span className="historyTitle">{entry.title}</span>
                    <span className="historyMeta">{relativeTime(entry.updatedAt)}</span>
                  </button>
                  <button
                    className="historyDelete"
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
        </section>
      </aside>
      {sidebarCollapsed ? <button className="workspaceSidebarReveal" type="button" onClick={() => { setSidebarCollapsed(false); localStorage.setItem("nomin-sidebar-collapsed", "0"); }} title="Open sidebar" aria-label="Open sidebar"><PanelLeftOpen size={18} /></button> : null}

      <section className="zenWorkspace">
        <header className="workspaceTopBar">
          {/* The mark alone. The bar used to read "Nomin | Trion Execute · 1.4"
              — a vendor name, a product name, a mode and a version number, none
              of which is about the conversation on screen. */}
          <div className="topBarLead">
            <div className="topBarTitle">
              <span className="topBarBrand"><JellyfishMark size={21} title="Nomin" /></span>
              <span><span className="nominWordmark">Nomin</span> workspace</span>
              <ChevronDown size={14} />
            </div>
          </div>
          <div className="topBarActions">
            {user ? <a
              className={`capacityChip ${busy && capacity?.activity.building ? "building" : busy && capacity?.activity.planning ? "planning" : ""}`}
              href="/capacity"
              title={
                busy && capacity?.activity.building
                  ? "Building project changes"
                  : busy && capacity?.activity.planning
                    ? "Planning your request"
                    : "View context and provider capacity"
              }
            >
              <Gauge size={14} />
              <span className="capacityChipContext">Context <strong>{capacity?.context ?? "Checking"}</strong></span>
              <span className="capacityChipLimit">{capacityLabel(capacity)}</span>
            </a> : null}
            <span
              className={`sandboxChip ${
                executor.bootError ? "error" : executor.previewUrl ? "live" : executor.booting ? "busy" : ""
              }`}
              title={executor.bootError ?? "In-browser sandbox running your project"}
            >
              <span className="sandboxDot" aria-hidden="true" />
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

        <div className="workspaceSplit">
          <div
            className="chatScroll"
            ref={chatScrollRef}
            onScroll={handleThreadScroll}
            // Clicking back into the conversation dismisses the panel — reading
            // the thread and reading the code are different intentions. Guarded
            // on the selection being collapsed so that dragging to select text
            // does not count as "I'm done with the panel".
            onClick={() => {
              if (!workPanelOpen) return;
              if (!window.getSelection()?.isCollapsed) return;
              setWorkPanelOpen(false);
            }}
          >
          <div className="threadColumn">
            {turns.length === 0 ? (
              <section className="heroMessage revealItem">
                <h2>What would you like to build?</h2>
                <p className="heroSub">Start with the outcome. Trion will work through the implementation with you.</p>
              </section>
            ) : null}

            {turns.map((turn) =>
              turn.role === "user" ? (
                <section className="userBubble revealItem" key={`u-${turn.id}`}><p>{turn.content}</p></section>
              ) : (
                <section className="assistantTurn revealItem delayOne" key={`a-${turn.id}`}>
                  <div className="assistantCopy"><Markdown className="assistantResult">{turn.content}</Markdown></div>
                </section>
              )
            )}

            {submittedMessage ? (
              <>
                <section className="assistantTurn revealItem delayTwo" aria-live="polite">
                  {showAgentStatus ? (
                    <div className={`agentPhase ${agentState}`}>
                      {agentState === "complete" ? <span className="phaseDone"><Check size={13} /></span> : agentState === "error" ? <span className="phaseError"><X size={13} /></span> : <JellyfishThinking />}
                      <span className="phaseText" key={phase}>{phase}</span>{agentState === "working" ? <span className="thinkingDots" aria-hidden="true"><i /><i /><i /></span> : null}
                    </div>
                  ) : null}

                  {progressUpdates.length > 0 ? (
                    <section className="progressDigest" aria-label="Work updates" aria-live="polite">
                      <p>Work update</p>
                      {progressUpdates.map((update) => (
                        <span key={update.id}>{update.message}</span>
                      ))}
                    </section>
                  ) : null}

                  {/* ONE execution surface. There used to be two — this live
                      panel and a second, near-identical one further down driven
                      by the legacy `trace` events — so a running turn showed
                      "Live execution" twice. The legacy path is gone. */}
                  <div className="traceWrap" ref={traceRef}>
                    {traceNodes.length > 0 ? (
                      traceCollapsed ? (
                        <button
                          className="tracePill"
                          type="button"
                          onClick={() => setTraceCollapsed(false)}
                          title="Show what Trion did"
                        >
                          <ListTree size={14} />
                          <span>{taskSummaryLabel}</span>
                          <ChevronDown size={13} />
                        </button>
                      ) : (
                        <div className="tracePanel">
                          <TraceTree nodes={traceNodes} />
                          <button
                            className="traceCollapseButton"
                            type="button"
                            onClick={() => setTraceCollapsed(true)}
                          >
                            Hide tasks
                          </button>
                        </div>
                      )
                    ) : null}
                  </div>

                  <div className="assistantCopy">
                    {chatReply && !turns.some((turn) => turn.id === currentTurnSeq && turn.role === "assistant") ? (
                      <Markdown className="assistantResult">{chatReply.content}</Markdown>
                    ) : null}
                  </div>

                  {error ? (
                    <div className="errorNote">
                      <span>
                        {isBridgeError(error) ? (
                          <>
                            <strong>{failedTool?.toolName ? `Couldn’t complete ${failedTool.toolName.replace("_", " ")}.` : "Browser workspace unavailable."}</strong>{" "}
                            Keep this Trion tab open so the workspace can run it, then retry.
                          </>
                        ) : presentError(error)}
                      </span>
                      {!isAllowanceFailure ? <button className="retryButton" type="button" onClick={() => void retrySubmission()}>
                        Retry request
                      </button> : <a className="retryButton" href="/connections">Connect your own model</a>}
                      <button className="retryButton secondary" type="button" onClick={newThread}>
                        Start new thread
                      </button>
                    </div>
                  ) : null}

                  {phase === "Stopped" && !busy && submittedMessage ? (
                    <div className="pausedNote" role="status">
                      <span>The build is paused. Completed workspace changes are kept.</span>
                      <button className="continueButton" type="button" onClick={() => void retrySubmission()}>
                        Continue build
                      </button>
                    </div>
                  ) : null}

                  {/* Collapsed handle. When the panel is closed but this
                      conversation has produced files, the work is still one
                      click away rather than gone — the same affordance Claude
                      uses for a dismissed artifact. */}
                  {!workPanelOpen && liveFiles.length > 0 && agentOutput?.status === "done" ? (
                    <button className="workReopen" type="button" onClick={() => setWorkPanelOpen(true)}>
                      <Code2 size={14} />
                      <span>
                        {liveFiles.length} {liveFiles.length === 1 ? "file" : "files"}
                        {executor.previewUrl ? " · preview running" : ""}
                      </span>
                      <span className="workReopenHint">Open</span>
                    </button>
                  ) : null}
                </section>
              </>
            ) : null}
          </div>
        </div>

        <WorkPanel
          // `workPanelOpen` is the ONLY authority. It used to be OR'd with
          // previewRequested, which reads executor.previewUrl — and that URL
          // outlives the turn that created it, so once any build had started a
          // dev server the panel forced itself open on every later message,
          // including plain conversation. The panel now opens when this turn
          // writes a file, and otherwise only when the user asks for it.
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
      </div>

      <div className="composerDock revealItem delayThree">
          {/* The composer IS the answer bar. An approval or a clarifying
              question takes it over in place, with the actions on the bar the
              user's hands are already on — rather than sending them back up the
              transcript to hunt for a card. Typing a reply also answers. */}
          {/* THE QUESTION LIVES IN THE COMPOSER.
              Not a floating modal beside it — the answer is given with the same
              hands, in the same place, as everything else the user types. Three
              exits, all present at once: tick an option, write your own answer
              in the box below, or cancel. */}
          {gateOpen ? (
            <div className="composerGate" role="group" aria-label="Trion needs an answer">
              <div className="composerGateHead">
                <span className="composerGateKicker">
                  {rejectPrompt ? <MessageCircleQuestion size={14} /> : <BadgeCheck size={14} />}
                  {rejectPrompt ? "One question" : "Before I run this"}
                </span>
                <button
                  className="composerGateCancel"
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

              <p className="composerGateAsk">
                {rejectPrompt ? "What was wrong with that plan?" : "Do you want me to run this?"}
              </p>
              <p className="composerGateWhy">
                {rejectPrompt
                  ? "Pick the closest one, or write your own below. It shapes the next attempt."
                  : approvalReason ||
                    "This makes changes worth seeing first. Pick an answer, or write what you'd rather I do."}
              </p>

              {!rejectPrompt && approvalPlan ? (
                <ol className="composerGateSteps">
                  {approvalPlan.steps.map((step, index) => (
                    <li key={step.step_id}>
                      <span className="composerGateIndex">{index + 1}</span>
                      <span>{step.description}</span>
                    </li>
                  ))}
                </ol>
              ) : null}

              <div className="composerGateChoices" role="radiogroup">
                {(rejectPrompt
                  ? REJECT_REASONS.map((reason, index) => ({
                      id: reason.value,
                      label: reason.label,
                      hint: reason.hint,
                      recommended: index === 0,
                    }))
                  : APPROVAL_CHOICES.map((choice) => ({ ...choice, recommended: "recommended" in choice && choice.recommended }))
                ).map((option) => {
                  const picked = gateChoice === option.id;
                  return (
                    <button
                      className={picked ? "composerGateChoice picked" : "composerGateChoice"}
                      key={option.id}
                      type="button"
                      role="radio"
                      aria-checked={picked}
                      onClick={() => setGateChoice(picked ? null : option.id)}
                    >
                      <span className="composerGateTick" aria-hidden="true">
                        {picked ? <Check size={12} /> : null}
                      </span>
                      <span className="composerGateChoiceBody">
                        <span className="composerGateChoiceLabel">
                          {option.label}
                          {option.recommended ? <em className="composerGateTag">Recommended</em> : null}
                        </span>
                        <span className="composerGateChoiceHint">{option.hint}</span>
                      </span>
                    </button>
                  );
                })}
              </div>

              <div className="composerGateFoot">
                <span className="composerGateFootHint">
                  {gateChoice ? "Ready to submit." : "Tick one, or type your own answer below."}
                </span>
                <button
                  className="composerGateSubmit"
                  type="button"
                  disabled={!gateChoice && !message.trim()}
                  onClick={submitGate}
                >
                  Submit
                </button>
              </div>
            </div>
          ) : null}

          {/* Held, not lost. Shown above the composer so a queued follow-up is
              visibly waiting rather than silently pending, and removable while
              it still hasn't been sent. */}
          {queuedMessages.length > 0 ? (
            <div className="queuedStrip">
              <span className="queuedLabel">
                {queuedMessages.length} queued — {busy ? "sending after this turn" : "sending now"}
              </span>
              {queuedMessages.map((text, index) => (
                <span className="queuedChip" key={`${index}-${text.slice(0, 12)}`}>
                  <span className="queuedChipText">{text}</span>
                  <button
                    className="queuedChipRemove"
                    type="button"
                    onClick={() => removeQueued(index)}
                    title="Remove from queue"
                    aria-label="Remove from queue"
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          ) : null}

          <div className="composerShell">
            {!approvalPending && pendingQuestion ? (
              <div className="composerInlineQuestion">
                <div className="composerPromptHead">
                  <MessageCircleQuestion size={15} />
                  <span>Trion needs one answer to continue</span>
                </div>
                <p className="composerPromptQuestion">{questionPrompt.prompt}</p>
                {questionPrompt.choices.length > 0 ? (
                  <div className="composerQuestionChoices" role="group" aria-label="Suggested answers">
                    {questionPrompt.choices.map((choice) => {
                      const selected = message.trim().toLowerCase() === choice.toLowerCase();
                      return (
                        <button
                          aria-pressed={selected}
                          className={selected ? "composerQuestionChoice selected" : "composerQuestionChoice"}
                          key={choice}
                          onClick={() => {
                            setMessage(choice);
                            requestAnimationFrame(() => composerRef.current?.focus());
                          }}
                          type="button"
                        >
                          {choice}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
                <span className="composerPromptHint">
                  {questionPrompt.choices.length > 0 ? "Choose one, or write your own answer below." : "Write your answer below."}
                </span>
              </div>
            ) : null}
            <textarea
              aria-label={pendingQuestion ? "Answer Trion" : "Ask Trion"}
              // Never disabled. While a question is open this box IS the "tell
              // me something yourself" option — locking it would leave ticking
              // a box as the only way to answer, which is exactly the rigid
              // behaviour the modal version had.
              placeholder={
                gateOpen
                  ? "…or answer in your own words"
                  : busy
                    ? "Type to queue a follow-up…"
                    : pendingQuestion
                      ? "Type your answer…"
                      : "Describe what you want built…"
              }
              onChange={(event) => {
                setMessage(event.target.value);
                resizeComposer(event.currentTarget);
              }}
              onKeyDown={(event) => {
                // Enter answers the open question, sends while idle, queues
                // while busy. Shift+Enter always inserts a newline.
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  if (gateOpen) submitGate();
                  else void submitMessage();
                }
              }}
              ref={composerRef}
              spellCheck={false}
              value={message}
            />
            {attachedFiles.length > 0 ? (
              <div className="attachedChips">
                {attachedFiles.map((file) => (
                  <span className="attachedChip" key={file.name}>
                    <FileText size={13} />
                    <span className="attachedChipName">{file.name}</span>
                    <button
                      aria-label={`Remove ${file.name}`}
                      className="attachedChipRemove"
                      onClick={() => removeAttachment(file.name)}
                      title="Remove attachment"
                      type="button"
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
            <input
              aria-label="Attach files"
              className="fileInputHidden"
              multiple
              onChange={(event) => void handleFilePick(event)}
              ref={fileInputRef}
              type="file"
            />
            <div className="composerControls">
              <div className="leftComposerTools">
                <button type="button" title="Attach file" aria-label="Attach file" onClick={openFilePicker}><Paperclip size={18} /></button>
              </div>
              <div className="rightComposerTools">
                <div className="modelMenu" ref={modelMenuRef}>
                  <button className="modelTrigger" type="button" aria-haspopup="menu" aria-expanded={modelMenuOpen} onClick={() => setModelMenuOpen((open) => !open)} title="Choose model"><Sparkles size={14} /><span>{activeConnection ? safeConnectionLabel(activeConnection) : `Trion ${MODEL_LABELS[model]}`}</span><ChevronDown size={13} /></button>
                  <div className={`modelPopover${modelMenuOpen ? " open" : ""}`} role="menu" aria-label="Trion model tiers" aria-hidden={!modelMenuOpen}>
                    {user && activeConnection ? <a className="modelConnectionActive" href="/connections"><span><strong>Connected model</strong><small>{activeConnection.model}</small></span><Check size={14} /></a> : null}
                    {MODEL_TIERS.map((tier) => {
                      const available = availableModels.includes(tier);
                      return <button className={`modelOption${model === tier ? " active" : ""}${!available ? " unavailable" : ""}`} disabled={!available} key={tier} role="menuitem" type="button" tabIndex={modelMenuOpen ? 0 : -1} onClick={() => { setModel(tier); setModelMenuOpen(false); }}><span><strong>Trion {MODEL_LABELS[tier]}</strong><small>{available ? "Available in this build" : "Provider route not configured"}</small></span>{model === tier ? <Check size={14} /> : null}</button>;
                    })}
                    {user ? <a className="modelConnectionLink" href="/connections">Connect or manage your own model</a> : null}
                  </div>
                </div>
                {busy ? (
                  <button className="sendOrb stopOrb" onClick={stopTurn} type="button" title="Stop the current turn" aria-label="Stop the current turn">
                    <span className="stopSquare" />
                  </button>
                ) : (
                  <button className="sendOrb" disabled={!message.trim() || gateOpen} onClick={submitMessage} type="button" title="Send to Trion (Enter)" aria-label="Send to Trion">
                    <ArrowUp size={20} />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>
      </>
      )}
    </main>
  );
}

/** The ONE place the mark moves fully. Everywhere else it just blinks, so
 *  motion in the interface means "Trion is working" and nothing else. */
function JellyfishThinking() {
  return (
    <span className="jellyThinkerShell" aria-hidden="true">
      <JellyfishMark size={26} className="jellyThinkerSvg" motion="full" />
    </span>
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




