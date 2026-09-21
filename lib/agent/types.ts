// ---------------------------------------------------------------------------
// Agent Contract Types — matches the Nomin Input/Output contract exactly.
// Field names, types, and nesting are part of the public surface the UI and
// orchestrator depend on. Do not rename or nest differently without updating
// both the input and output contracts documented in the architecture plan.
// ---------------------------------------------------------------------------

import type { TurnBudget } from "./turn-budget";

// -- INPUT CONTRACT ---------------------------------------------------------

/** Discriminator: "plan" produces a plan-only response, "execute" runs tools. */
export type AgentMode = "plan" | "execute";

/** Trion model tier selected by the user. The orchestrator may escalate
 *  a single high-complexity step to "trion-2.3" regardless of this choice. */
export type AgentModel = "trion-1.4" | "trion-1.9" | "trion-2.3";

/** Type alias for tier string used in model gateway */
export type TrionTier = AgentModel;

/** Single turn in conversation_history. "tool" results are appended by the
 *  orchestrator after each tool execution; "user" / "assistant" come from
 *  prior turns. */
export type ConversationTurn = {
  role: "user" | "assistant" | "tool";
  content: string;
  /** Set on "tool" rows: which tool produced the content. */
  tool_name?: string;
  /** Set on "assistant" rows that asked the user a clarifying question and
   *  ended the turn. The NEXT turn's classification MUST see this row —
   *  without it a short reply ("yes a simple clicker") gets reclassified from
   *  scratch as ambiguous and the agent asks the same question forever.
   *  The history trimmer pins this row for that reason. */
  clarifying?: boolean;
  /** Open thread: an unanswered clarifying question, or work paused mid-flight
   *  (e.g. at the approval gate). Context assembly NEVER trims a turn carrying
   *  this flag, however old it gets, until it is resolved. The session store
   *  clears it when the user's next message arrives. */
  unresolved?: boolean;
  /** Internal deterministic digest of resolved turns that were compacted out of
   *  the in-memory transcript. It is context, never a user-visible turn, and
   *  must remain available even when a session outlives the raw-history cap. */
  compacted?: boolean;
};

/** Message format for model gateway */
export type NimMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

/** Raw model output turn */
export type AgentTurn = {
  thought: string;
  action: "read_file" | "write_file" | "run_command" | "search_codebase" | "web_fetch" | "finish";
  action_input: Record<string, unknown>;
  summary?: string;
  done: boolean;
  /**
   * Set when the provider's reply could not be parsed as a decision at all, so
   * the client wrapped the raw text into a shape the loop can carry.
   *
   * This flag is the difference between "the model chose to finish" and "the
   * model said something we could not read". They used to be indistinguishable:
   * an unparseable reply became `finish` + `done: true` with the raw text as its
   * summary, so on the LAST step of a plan a malformed response was reported to
   * the user as a completed build. The executor now treats a flagged turn as a
   * decision error and re-asks, which is what it does for every other
   * unreadable response.
   */
  parse_error?: string;
};

/** Optional context attached to the current turn only. */
export type AttachedContext = {
  type: "file" | "image" | "text";
  path?: string;
  content?: string;
};

/** Live snapshot of the workspace — regenerated on every turn. */
export type WorkspaceSnapshot = {
  file_tree: string[];
  open_files: string[];
};

/** The shape assembled fresh on every turn before any model call. */
export type NormalInput = {
  session_id: string;
  workspace_path: string;
  mode: AgentMode;
  model: AgentModel;
  user_message: string;
  conversation_history: ConversationTurn[];
  attached_context: AttachedContext[];
  workspace_snapshot: WorkspaceSnapshot;
  /** Per-turn call budget. Set by the orchestrator per runTurn; absent in
   *  offline/bench contexts, where enforcement is deliberately off. */
  budget?: TurnBudget;
};

// -- OUTPUT CONTRACT --------------------------------------------------------

/** What the UI uses to drive its thinking-indicator animation. The orchestrator
 *  guarantees this resolves to "done" or "error" by the end of the turn.
 *
 *  Pipeline statuses (thinking → planning → executing → synthesizing → done)
 *  are emitted by the orchestrator as the turn progresses. Activity statuses
 *  (responding, coding, debugging, …) are chosen by the model itself in the
 *  intent classifier, matching what the task actually is. */
export type AgentStatus =
  // --- pipeline (emitted by the orchestrator) ---
  | "thinking"
  | "planning"
  | "executing"
  | "synthesizing"
  | "done"
  | "error"
  | "cancelled"
  | "needs_clarification"
  // --- conversation & Q&A ---
  | "responding"
  | "greeting"
  | "thanking"
  | "clarifying"
  | "understanding"
  | "answering"
  | "explaining"
  | "defining"
  | "discussing"
  | "summarizing"
  | "paraphrasing"
  | "translating"
  | "comparing"
  | "recommending"
  | "brainstorming"
  | "ideating"
  | "exploring"
  | "storytelling"
  | "teaching"
  | "quoting"
  | "factchecking"
  | "suggesting"
  // --- writing & editing ---
  | "writing"
  | "drafting"
  | "composing"
  | "editing"
  | "revising"
  | "rewriting"
  | "polishing"
  | "proofreading"
  | "grammar"
  | "style"
  | "formatting"
  | "outlining"
  | "structuring"
  | "expanding"
  | "condensing"
  | "copywriting"
  | "emailing"
  | "documenting"
  | "blogging"
  | "scriptwriting"
  | "notetaking"
  | "commenting"
  | "headlines"
  // --- coding & engineering ---
  | "coding"
  | "designing"
  | "architecting"
  | "scaffolding"
  | "generating"
  | "implementing"
  | "wiring"
  | "integrating"
  | "connecting"
  | "configuring"
  | "installing"
  | "refactoring"
  | "renaming"
  | "cleaning"
  | "fixing"
  | "debugging"
  | "tracing"
  | "reproducing"
  | "reading_logs"
  | "inspecting"
  | "testing"
  | "writing_tests"
  | "running"
  | "compiling"
  | "building"
  | "linting"
  | "formatting_code"
  | "reviewing"
  | "checking_code"
  | "optimizing"
  | "profiling"
  | "benchmarking"
  | "securing"
  | "migrating"
  | "upgrading"
  | "versioning"
  | "deploying"
  | "shipping"
  | "packaging"
  | "monitoring"
  | "verifying"
  | "analyzing"
  | "troubleshooting"
  | "auditing"
  // --- data, research & ops ---
  | "converting"
  | "extracting"
  | "transforming"
  | "organizing"
  | "classifying"
  | "researching"
  | "searching"
  | "reading"
  | "fetching"
  | "downloading"
  | "uploading"
  | "syncing"
  | "preparing"
  | "composing_media";

/** Human-readable label for every status. The UI renders these verbatim. */
export const ACTIVITY_LABELS: Record<AgentStatus, string> = {
  // pipeline
  thinking: "Thinking",
  planning: "Planning",
  executing: "Executing",
  synthesizing: "Synthesizing",
  done: "Done",
  error: "Needs attention",
  cancelled: "Cancelled",
  needs_clarification: "Needs clarification",
  // conversation & Q&A
  responding: "Responding",
  greeting: "Greeting",
  thanking: "Acknowledging",
  clarifying: "Clarifying",
  understanding: "Understanding",
  answering: "Answering",
  explaining: "Explaining",
  defining: "Defining terms",
  discussing: "Discussing",
  summarizing: "Summarizing",
  paraphrasing: "Paraphrasing",
  translating: "Translating",
  comparing: "Comparing options",
  recommending: "Recommending",
  brainstorming: "Brainstorming",
  ideating: "Ideating",
  exploring: "Exploring ideas",
  storytelling: "Storytelling",
  teaching: "Teaching",
  quoting: "Citing sources",
  factchecking: "Fact-checking",
  suggesting: "Suggesting improvements",
  // writing & editing
  writing: "Writing",
  drafting: "Drafting",
  composing: "Composing",
  editing: "Editing",
  revising: "Revising",
  rewriting: "Rewriting",
  polishing: "Polishing",
  proofreading: "Proofreading",
  grammar: "Checking grammar",
  style: "Refining style",
  formatting: "Formatting",
  outlining: "Outlining",
  structuring: "Structuring",
  expanding: "Expanding",
  condensing: "Condensing",
  copywriting: "Copywriting",
  emailing: "Writing an email",
  documenting: "Documenting",
  blogging: "Writing a blog post",
  scriptwriting: "Writing a script",
  notetaking: "Taking notes",
  commenting: "Writing comments",
  headlines: "Writing headlines",
  // coding & engineering
  coding: "Coding",
  designing: "Designing",
  architecting: "Architecting",
  scaffolding: "Scaffolding",
  generating: "Generating code",
  implementing: "Implementing",
  wiring: "Wiring up",
  integrating: "Integrating",
  connecting: "Connecting APIs",
  configuring: "Configuring",
  installing: "Installing",
  refactoring: "Refactoring",
  renaming: "Renaming",
  cleaning: "Cleaning up",
  fixing: "Fixing",
  debugging: "Debugging",
  tracing: "Tracing errors",
  reproducing: "Reproducing the issue",
  reading_logs: "Reading logs",
  inspecting: "Inspecting",
  testing: "Testing",
  writing_tests: "Writing tests",
  running: "Running",
  compiling: "Compiling",
  building: "Building",
  linting: "Linting",
  formatting_code: "Formatting code",
  reviewing: "Reviewing",
  checking_code: "Checking code",
  optimizing: "Optimizing",
  profiling: "Profiling",
  benchmarking: "Benchmarking",
  securing: "Hardening security",
  migrating: "Migrating",
  upgrading: "Upgrading",
  versioning: "Managing versions",
  deploying: "Deploying",
  shipping: "Shipping",
  packaging: "Packaging",
  monitoring: "Monitoring",
  verifying: "Verifying",
  analyzing: "Analyzing",
  troubleshooting: "Troubleshooting",
  auditing: "Auditing",
  // data, research & ops
  converting: "Converting",
  extracting: "Extracting data",
  transforming: "Transforming data",
  organizing: "Organizing",
  classifying: "Classifying",
  researching: "Researching",
  searching: "Searching",
  reading: "Reading",
  fetching: "Fetching data",
  downloading: "Downloading",
  uploading: "Uploading",
  syncing: "Syncing",
  preparing: "Preparing",
  composing_media: "Composing media",
};

/** The vocabulary the intent classifier may choose an activity from.
 *  Pipeline statuses are excluded — those belong to the orchestrator. */
const PIPELINE_STATUSES: readonly string[] = [
  "thinking",
  "planning",
  "executing",
  "synthesizing",
  "done",
  "error",
  "cancelled",
  // Omitting this one let the classifier pick "needs_clarification" as an
  // ACTIVITY, which the UI then rendered as a pipeline node on a normal turn.
  "needs_clarification",
];

export const ACTIVITY_LIST: readonly AgentStatus[] = Object.keys(ACTIVITY_LABELS).filter(
  (status): status is AgentStatus => !PIPELINE_STATUSES.includes(status)
);

/**
 * The subset of ACTIVITY_LIST actually offered to the classifier.
 *
 * ACTIVITY_LIST is ~100 entries; spelled out in the intent system prompt it cost
 * a measured ~290 tokens on EVERY turn — roughly a third of that prompt — to
 * choose a cosmetic UI label. Nothing depends on the model picking a rare one:
 * `toAgentStatus` still accepts any key in ACTIVITY_LABELS, so a model that
 * answers "proofreading" or "benchmarking" is honoured exactly as before, and
 * `heuristicActivity` supplies the fallback when it answers something invalid.
 *
 * This shortlist covers every category the UI groups by, and every value the
 * classifier's own heuristics can produce.
 */
export const CLASSIFIER_ACTIVITY_LIST: readonly AgentStatus[] = [
  "greeting", "thanking", "responding", "answering", "clarifying", "explaining", "discussing", "summarizing", "comparing",
  "writing", "editing", "proofreading", "documenting",
  "coding", "implementing", "refactoring", "debugging", "fixing", "testing", "reviewing", "optimizing",
  "designing", "architecting", "scaffolding", "configuring", "installing", "migrating",
  "searching", "reading", "researching", "analyzing",
  "running", "building", "deploying", "packaging",
];

/** Coerce any string into a valid AgentStatus, or a safe fallback. */
export function toAgentStatus(value: unknown, fallback: AgentStatus): AgentStatus {
  return typeof value === "string" && (ACTIVITY_LABELS as Record<string, string>)[value] ? (value as AgentStatus) : fallback;
}

/** A single step in the planner-emitted plan. */
export type PlanStep = {
  step_id: number;
  description: string;
  /** State is rendered by the UI; the orchestrator updates it as work proceeds. */
  state: "pending" | "running" | "done" | "error" | "cancelled";
  /** Optional tool hint the planner provided. */
  tool?: string | null;
};

/** The plan block in the output contract. Null when no plan was emitted. */
export type Plan = {
  summary: string;
  steps: Array<{
    step_id: number;
    description: string;
    state: PlanStep["state"];
    /** Which tool the step will use. Present so the approval gate can show what
     *  is actually about to happen — approving "update the config" without
     *  knowing it means `run_command` is not informed consent. */
    tool?: string | null;
  }>;
};

/** A single row of tool_trace. The UI collapses this by default. */
export type ToolTraceEntry = {
  step_id: number;
  tool_name: string;
  input: Record<string, unknown>;
  output: string;
  status: "success" | "error";
  attempt: number;
  /** Internal provider audit only. Removed before the public AgentOutput. */
    path_used?: "hosted" | "gemini" | "deterministic";
};

/** Inline renderable artifact surfaced alongside the message. */
export type Artifact = {
  /** "code_diff" when modifying an existing file, "file" when creating new. */
  type: "code_diff" | "file" | "preview";
  language?: string;
  content: string;
  preview_url?: string;
};

/** Trace-derived evidence for whether runnable changes were actually checked. */
export type VerificationSummary = {
  required: boolean;
  /** "started" means a dev server began serving (process startup) without any
   *  build/test/lint proving the change is correct. It is honest final
   *  evidence — not a pass, and not a reason to pause the turn. */
  status: "not_needed" | "passed" | "started" | "not_run" | "failed";
  command?: string;
  message: string;
};

/** The final shape every agent turn must resolve into. */
export type AgentOutput = {
  message: string;
  status: AgentStatus;
  plan: Plan | null;
  tool_trace: ToolTraceEntry[];
  artifacts: Artifact[];
  /** Omitted for direct answers and plan-only turns. Never model-authored. */
  verification?: VerificationSummary | null;
  next_action_hint?: string | null;
};

// -- INTERNAL HELPERS (not part of the public contract) ---------------------

/** A raw tool call emitted by the orchestrator inside STEP 3. */
export type ToolCall = {
  tool_name: string;
  tool_input: Record<string, unknown>;
  step_id: number;
  /** Set by the planner when a step needs more reasoning power. */
  high_complexity?: boolean;
  /** Set when the tool must be executed by the client WebContainer executor.
   *  The server awaits the result via the execution bridge. */
  execution_id?: string;
};

/** The result of running a tool inside the sandboxed environment. */
export type ToolResult = {
  step_id: number;
  ok: boolean;
  status: "success" | "error";
  output: string;
  error?: string;
  artifacts?: Artifact[];
};

/** Raw planner output shape. */
export type PlanDoc = {
  plan_summary: string;
  steps: Array<{
    step_id: number;
    description: string;
    tool: string | null;
  }>;
};

/** Raw synthesis call output — the natural-language final message. */
export type SynthesisDoc = {
  message: string;
  next_action_hint?: string | null;
};

/** Raw intent-classification output (always produced by trion-1.4). */
export type IntentDoc = {
  intent: "direct_answer" | "task" | "needs_clarification";
  /** The activity status chosen by the model from ACTIVITY_LIST. */
  activity: AgentStatus;
  reason?: string;
  /** A concrete workspace/session convention used to avoid an unnecessary
   * question. It is surfaced in the plan summary, never hidden from the user. */
  assumption?: string;
};

/** Legacy trace entry for UI compatibility */
export type AgentTrace = {
  id: string;
  iteration: number;
  stage: string;
  label: string;
  status: "started" | "succeeded" | "failed";
  startedAt: string;
  durationMs?: number;
  action?: string;
  error?: string;
};

/** Legacy validated request for UI compatibility */
export type ValidatedChatRequest = {
  sessionId: string;
  userText: string;
  mode: AgentMode;
  workspacePath: string;
  inputKind: "conversation" | "coding_task" | "tool_task";
};

/** Legacy result format for UI compatibility */
export type AgentResult = {
  sessionId: string;
  inputKind: "conversation" | "coding_task" | "tool_task";
  outputs: AgentOutput[];
  traces: AgentTrace[];
  stopReason: "completed" | "approval_required" | "max_iterations" | "error" | "cancelled" | "needs_clarification";
};

/** Streaming status events the orchestrator emits during a turn. These are
 *  internal — the public output contract is AgentOutput (returned once at end). */
export type StreamEvent =
  | { type: "status"; status: AgentStatus }
  /** An evidence-based progress update for the person following the work. */
  | { type: "progress"; stage: "plan" | "paused" | "complete" | "notice" | "working"; message: string }
  /** A slice of the assistant's visible answer, as the model produces it.
   *  `reset` means a retry discarded everything streamed so far for this turn. */
  | { type: "delta"; text?: string; reset?: true }
  | { type: "plan"; plan: Plan }
  | { type: "plan_update"; step_id: number; state: PlanStep["state"] }
  | { type: "tool_call"; call: ToolCall }
  | { type: "tool_result"; step_id: number; status: ToolResult["status"] | "approval_required"; output?: string }
  | { type: "plan_skipped"; reason: "plan_mode" }
  | { type: "plan_approval"; plan: Plan; reason?: string; planHash: string }
  | { type: "result"; data: AgentOutput }
  | { type: "error"; error: ErrorOutput };

/** Error output for stream events */
export type ErrorOutput = {
  code: "validation_error" | "model_error" | "tool_error" | "timeout" | "internal_error";
  message: string;
  retryable: boolean;
};
