// Input Normalization & Validation
// Builds NormalInput fresh on every turn. The workspace snapshot is supplied
// by the client (the WebContainer file tree) — this module never reads the
// host disk.

import type { AgentMode, AgentModel, AttachedContext, ConversationTurn, NormalInput, WorkspaceSnapshot } from "./types";
import { getSession } from "./session-store";
import { perf } from "./perf";
import { isProtectedTurn } from "./context";
import { AGENT_MODEL_TIERS, isModelTierAvailable } from "./model-tiers";
import { isSensitiveWorkspacePath } from "./path-policy";
import { validateClientCheckpoint, type ClientCheckpoint } from "./resume-checkpoint";
import type { ByokProviderConfig } from "@/lib/nim/byok-context";

// The client reports its WebContainer workspace root as a label; it is never a
// host path. Empty string is the neutral fallback when the client sends none.
const DEFAULT_WORKSPACE = "workspace";
const MAX_MESSAGE_CHARS = 12_000;
const MAX_SESSION_ID_CHARS = 128;
const MAX_WORKSPACE_CHARS = 512;
const MAX_SNAPSHOT_FILES = 5_000;
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_CHARS = 200_000;
const MAX_CLIENT_HISTORY_TURNS = 40;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const ROLE_INJECTION = /(^|\n)\s*(system|assistant|developer)\s*:/i;

export class InputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputValidationError";
  }
}

export type ValidatedChatRequest = {
  sessionId: string;
  userText: string;
  mode: AgentMode;
  model: AgentModel;
  workspacePath: string;
  /** Optional WebContainer file tree snapshot supplied by the client. */
  snapshot?: string[];
  /** Files attached by the user through the upload control. */
  attachments?: AttachedContext[];
  /** Bounded user-visible transcript used only to rehydrate a reopened thread
   * when the server no longer has its in-memory session. */
  history?: ConversationTurn[];
  /** Explicit Retry action: continue a saved, approved execution plan. */
  resume?: boolean;
  /** Client-persisted resume checkpoint (plan + evidence from the last turn's
   *  result event). Used ONLY to rehydrate the server map on lookup miss after
   *  a restart — a present server checkpoint always wins. Invalid shapes are
   *  treated as absent (graceful fallback), never a hard validation failure,
   *  so client/server version skew cannot brick a retry. */
  checkpoint?: ClientCheckpoint | null;
  /** Ephemeral browser-tab connection. It is used for this turn only and is
   * never written to the session store, trace, logs, or exported output. */
  byok?: ByokProviderConfig;
};

export function parseChatRequest(payload: unknown): ValidatedChatRequest {
  if (!isRecord(payload)) throw new InputValidationError("Request body must be a JSON object.");

  const userText = normalizeText(payload.userText);
  if (!userText) throw new InputValidationError("Message cannot be empty.");
  if (userText.length > MAX_MESSAGE_CHARS) {
    throw new InputValidationError(`Message is too large. The limit is ${MAX_MESSAGE_CHARS.toLocaleString()} characters.`);
  }
  if (ROLE_INJECTION.test(userText)) {
    throw new InputValidationError("Messages cannot contain forged system, developer, or assistant role headers.");
  }

  const suppliedSessionId = typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
  if (suppliedSessionId.length > MAX_SESSION_ID_CHARS) throw new InputValidationError("Session identifier is too long.");
  if (suppliedSessionId && !/^[a-zA-Z0-9_-]+$/.test(suppliedSessionId)) {
    throw new InputValidationError("Session identifier contains unsupported characters.");
  }

  const workspacePath = typeof payload.workspacePath === "string" && payload.workspacePath.trim()
    ? payload.workspacePath.trim()
    : DEFAULT_WORKSPACE;
  if (workspacePath.length > MAX_WORKSPACE_CHARS || workspacePath.includes("\0")) {
    throw new InputValidationError("Workspace path is invalid.");
  }

  const mode: AgentMode = payload.mode === "execute" ? "execute" : "plan";

  // Model tier — unknown labels retain the backwards-compatible 1.4 default,
  // but a known tier without a configured route is a clear client error. It
  // must never masquerade as a different tier at provider dispatch time.
  const model: AgentModel = AGENT_MODEL_TIERS.includes(payload.model as AgentModel)
    ? (payload.model as AgentModel)
    : "trion-1.4";
  if (!isModelTierAvailable(model)) {
    throw new InputValidationError(`Trion ${model.slice("trion-".length)} is not configured in this environment.`);
  }

  // Attached files (client-read content, POSIX-safe names)
  let attachments: AttachedContext[] | undefined;
  if (Array.isArray(payload.attachments)) {
    const clean: AttachedContext[] = [];
    for (const entry of payload.attachments) {
      if (clean.length >= MAX_ATTACHMENTS) break;
      if (!isRecord(entry)) continue;
      const path = typeof entry.path === "string" ? entry.path.trim() : "";
      const content = typeof entry.content === "string" ? entry.content : "";
      if (!path || path.length > MAX_WORKSPACE_CHARS || path.includes("\0") || !content || isSensitiveWorkspacePath(path)) continue;
      if (content.length > MAX_ATTACHMENT_CHARS) continue;
      if (/^[a-zA-Z]:/.test(path.replace(/\\/g, "/"))) continue; // No host drive paths
      clean.push({ type: "file", path, content });
    }
    if (clean.length > 0) attachments = clean;
  }

  // Optional client-supplied WebContainer snapshot (POSIX relative paths)
  let snapshot: string[] | undefined;
  if (Array.isArray(payload.snapshot)) {
    const cleanSnapshot = payload.snapshot
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.replace(/\\/g, "/"))
      .filter((entry) => entry.length <= MAX_WORKSPACE_CHARS && !entry.includes("..") && !entry.startsWith("/") && !/^[a-zA-Z]:/.test(entry) && !isSensitiveWorkspacePath(entry))
      .slice(0, MAX_SNAPSHOT_FILES);
    if (cleanSnapshot.length > 0) snapshot = cleanSnapshot;
  }

  let history: ConversationTurn[] | undefined;
  if (Array.isArray(payload.history)) {
    const clean = payload.history
      .filter(isRecord)
      .filter((entry) => entry.role === "user" || entry.role === "assistant")
      .map((entry) => ({
        role: entry.role as "user" | "assistant",
        content: normalizeText(entry.content).slice(0, MAX_MESSAGE_CHARS),
      }))
      .filter((entry) => entry.content.length > 0)
      .slice(-MAX_CLIENT_HISTORY_TURNS);
    if (clean.length > 0) history = clean;
  }

  let byok: ByokProviderConfig | undefined;
  if (isRecord(payload.byok)) {
    const provider = payload.byok.provider;
    const apiKey = typeof payload.byok.apiKey === "string" ? payload.byok.apiKey.trim() : "";
    const modelName = typeof payload.byok.model === "string" ? payload.byok.model.trim() : "";
    if ((provider !== "openai" && provider !== "anthropic" && provider !== "openrouter" && provider !== "nvidia" && provider !== "compatible") || !apiKey || !modelName) {
      throw new InputValidationError("Your connection is incomplete. Reconnect it in Settings.");
    }
    if (apiKey.length > 512 || modelName.length > 200) throw new InputValidationError("Your connection details are too long.");
    let baseUrl = provider === "openai" ? "https://api.openai.com/v1" : provider === "anthropic" ? "https://api.anthropic.com/v1" : provider === "openrouter" ? "https://openrouter.ai/api/v1" : provider === "nvidia" ? "https://integrate.api.nvidia.com/v1" : "";
    if (provider === "compatible") {
      try {
        const parsed = new URL(typeof payload.byok.baseUrl === "string" ? payload.byok.baseUrl : "");
        const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
        if (!local || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) throw new Error("unsafe");
        baseUrl = parsed.toString().replace(/\/$/, "");
      } catch {
        throw new InputValidationError("Compatible connections currently support a reachable local endpoint.");
      }
    }
    const fastModel = typeof payload.byok.fastModel === "string" && payload.byok.fastModel.trim() ? payload.byok.fastModel.trim().slice(0, 200) : undefined;
    const maxContextChars = typeof payload.byok.maxContextChars === "number" && Number.isFinite(payload.byok.maxContextChars)
      ? Math.max(2_000, Math.min(200_000, Math.floor(payload.byok.maxContextChars))) : undefined;
    byok = { provider, apiKey, baseUrl, model: modelName, fastModel, maxContextChars };
  }

  return {
    sessionId: suppliedSessionId || crypto.randomUUID(),
    userText,
    mode,
    model,
    workspacePath,
    snapshot,
    attachments,
    history,
    resume: payload.resume === true,
    checkpoint: validateClientCheckpoint(payload.checkpoint ?? null),
    byok,
  };
}

export async function normalizeInput(
  request: ValidatedChatRequest,
  session: {
    id: string;
    mode: AgentMode;
    model: AgentModel;
    workspacePath: string;
    history: ConversationTurn[];
  },
  attachedContext: AttachedContext[] = []
): Promise<NormalInput> {
  // Get session to access the full history (which has been appended by orchestrator)
  const sessionData = getSession(request.sessionId);
  const fullHistory = sessionData?.history || session.history;

  // Workspace snapshot is captured by the CLIENT from its WebContainer file
  // tree. No host filesystem access here.
  const start = Date.now();
  const fileTree = request.snapshot ?? [];
  perf("snapshot.capture", Date.now() - start, { files: fileTree.length });

  const workspaceSnapshot: WorkspaceSnapshot = {
    file_tree: fileTree,
    open_files: [],
  };

  // Trim history to fit tier's context budget
  const trimmedHistory = trimHistoryForTier(fullHistory, session.model, request.byok?.maxContextChars);
  // The session store compacts resolved rows only after its resident-history
  // cap. Keep that digest as protected context rather than pretending those
  // turns never happened. It is deliberately marked as historical data, not a
  // fresh instruction, and costs no model request to create.
  const compactedMemory = sessionData?.compactionSummary
    ? [{ role: "user" as const, content: sessionData.compactionSummary, compacted: true }]
    : [];

  const input: NormalInput = {
    session_id: session.id,
    workspace_path: request.workspacePath,
    mode: session.mode,
    model: session.model,
    user_message: request.userText,
    conversation_history: [...compactedMemory, ...trimmedHistory],
    attached_context: attachedContext,
    workspace_snapshot: workspaceSnapshot,
  };

  if (workspaceSnapshot.file_tree.length === 0) {
    console.warn("Workspace snapshot is empty — the client WebContainer snapshot was not supplied.");
  }

  return input;
}

export function trimHistoryForTier(history: ConversationTurn[], model: AgentModel, overrideChars?: number): ConversationTurn[] {
  // Tier context budgets (approximate token limits)
  const budgets: Record<AgentModel, number> = {
    "trion-1.4": 8_000,   // ~8k chars
    "trion-1.9": 16_000,  // ~16k chars
    "trion-2.3": 32_000,  // ~32k chars
  };
  
  const budget = overrideChars ? Math.max(2_000, Math.min(200_000, overrideChars)) : budgets[model] || budgets["trion-1.4"];

  // Selection is done over INDICES and emitted in chronological order at the
  // end. The earlier version built the array with a mix of push/unshift across
  // three passes, which interleaved old error rows after newer turns — the
  // model was handed a conversation whose events were out of order, which reads
  // as the agent answering a question that was never asked.
  const keep = new Set<number>();
  let charCount = 0;

  const costOf = (index: number) => JSON.stringify(history[index]).length;

  // PINNED: unresolved threads are never trimmed, at any budget — an unanswered
  // clarifying question, or work paused mid-flight. Dropping the question turns
  // "yes a simple clicker" back into unclassifiable input and loops forever.
  // Same predicate the context assembler uses, so the two layers cannot disagree
  // about what counts as protected.
  for (let i = 0; i < history.length; i++) {
    if (isProtectedTurn(history[i], i, history)) {
      keep.add(i);
      charCount += costOf(i);
    }
  }

  // Unresolved tool errors, newest first — the model must see what just broke.
  for (let i = history.length - 1; i >= 0; i--) {
    if (keep.has(i)) continue;
    const turn = history[i];
    if (turn.role !== "tool" || !turn.content.includes("Error:")) continue;
    const cost = costOf(i);
    if (charCount + cost > budget) continue;
    keep.add(i);
    charCount += cost;
  }

  // Then the recency window, newest first, until the budget runs out.
  for (let i = history.length - 1; i >= 0; i--) {
    if (keep.has(i)) continue;
    const cost = costOf(i);
    if (charCount + cost > budget) break;
    keep.add(i);
    charCount += cost;
  }

  return [...keep].sort((a, b) => a - b).map((i) => history[i]);
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.replace(CONTROL_CHARACTERS, "").trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
