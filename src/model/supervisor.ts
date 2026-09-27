import { NvidiaProvider } from "./nvidia.js";
import { parseLooseJson } from "./tooltext.js";
import { SUPERVISOR, type ModelDescriptor } from "./registry.js";
import type { ContentPart, Message } from "./types.js";

/**
 * The monitor — Nomin Code's manager AI.
 *
 * Its job is to answer one question honestly: *was the work actually
 * delivered?* It never writes code and never touches the workspace; it only
 * judges what the worker model produced.
 *
 * Three deliberate architectural choices:
 *
 * 1. **Evidence before opinion.** Most failures are detectable without a model
 *    at all — an empty answer, a failing test with no fix after it, a claim of
 *    "done" with no build or test event behind it. Those checks are free, run
 *    on every turn, and can settle a verdict on their own.
 *
 * 2. **It looks at the result.** When the work is previewable, the monitor is
 *    given a rendering of it. Reading code tells you whether a page exists;
 *    only looking tells you whether it is finished or a skeleton.
 *
 * 3. **Off the hot path, on its own key.** The model pass runs after the user
 *    already has their answer, on a compact digest rather than the transcript,
 *    under its own credentials and its own retry policy — so review traffic
 *    never competes with the worker's rate limit.
 *
 * With no monitor key configured it still runs, in evidence-only mode, and it
 * never upgrades a verdict to "verified" on the worker's own say-so.
 */

export type VerificationStatus = "verified" | "concerns" | "failed" | "unverified";

export interface Verdict {
  status: VerificationStatus;
  /** One user-facing line. Safe to show in the work tree. */
  summary: string;
  issues: string[];
  /** What was actually checked, so the verdict can be audited. */
  evidence: string[];
  usedModel: boolean;
  /** True when the monitor looked at a rendering, not only at the code. */
  sawRendering?: boolean;
  /** The written report, in markdown. Present when the model pass ran. */
  report?: string;
  /**
   * The approval gate. Only the manager sets this, and only on "verified".
   * Nothing downstream may present work as finished while it is false — that
   * is the whole contract between the worker and its reviewer.
   */
  approved: boolean;
  /**
   * Why the model pass did not run, when it did not. Kept deliberately free of
   * credentials, endpoints and backend ids; it says which stage gave up, so a
   * deployment with a silent manager is diagnosable instead of mysterious.
   */
  note?: string;
}

/** The compact record a turn leaves behind. Kept small on purpose. */
export interface TurnDigest {
  request: string;
  answer: string;
  events: Array<{ type: string; label?: string; detail?: string }>;
  durationMs: number;
  rateLimited: boolean;
  /** True when the worker finished without producing any answer text. */
  empty: boolean;
  /** Files the turn produced, for judging completeness. */
  files?: Array<{ name: string; lines: number }>;
  /** A PNG data URL of the rendered result, when one could be captured. */
  screenshot?: string;
  /** What happened when the page was actually executed. */
  runtime?: { ran: boolean; errors: string[]; nodes: number };
}

export interface SupervisorConfig {
  model: ModelDescriptor;
  apiKey: string;
  /** No events for this long while running counts as stalled. */
  stallMs: number;
  /** Backends to try when the primary seat will not answer. In order. */
  fallbacks: string[];
}

/** Phrases that assert success — they must be backed by real events. */
const CLAIMS = [
  "all tests pass",
  "tests pass",
  "build succeeds",
  "build passed",
  "verified",
  "it works",
  "working correctly",
  "successfully built",
  "done and tested",
];

const PASS_EVENTS = new Set([
  "test.passed",
  "build.completed",
  "verification.passed",
  "command.completed",
]);

const FAIL_EVENTS = new Set([
  "test.failed",
  "build.failed",
  "step.failed",
  "tool.failed",
  "command.failed",
  "verification.failed",
]);

const EVENT_PHASE: Record<string, string> = {
  "test.passed": "test", "test.failed": "test",
  "build.completed": "build", "build.failed": "build",
  "step.completed": "step", "step.failed": "step",
  "tool.started": "tool", "tool.failed": "tool",
  "command.completed": "command", "command.started": "command", "command.failed": "command",
  "verification.passed": "verify", "verification.failed": "verify",
};

const WORK_EVENTS = new Set([
  "file.created",
  "file.modified",
  "command.started",
  "build.started",
  "test.started",
  "tool.started",
  "artifact.created",
]);

export function createSupervisor(env = process.env): Supervisor {
  // The manager must actually run. It prefers its own key, then the vision
  // key, then the worker's — evidence-only is the last resort, not the first
  // accident. `||` rather than `??` on purpose: a variable set to the empty
  // string is an unset variable, and `??` would stop on it and leave the
  // manager silently disabled with a key sitting right behind it.
  const key =
    env[SUPERVISOR.apiKeyEnv ?? "NOMIN_SUPERVISOR_API_KEY"] ||
    env.NOMIN_VISION_API_KEY ||
    env.NVIDIA_API_KEY ||
    "";
  const model: ModelDescriptor = {
    ...SUPERVISOR,
    backend: env.NOMIN_SUPERVISOR_MODEL || SUPERVISOR.backend,
    endpoint: env.NOMIN_SUPERVISOR_URL || env.NOMIN_BASE_URL || SUPERVISOR.endpoint,
  };
  // The 90B seat is the intended reviewer, but the provider serves it
  // intermittently — it answers 504 for long stretches. Rather than let that
  // turn into "the manager never approves anything", the review falls through
  // to a smaller seat in the same family that is reliably available.
  const fallbacks = (env.NOMIN_SUPERVISOR_FALLBACKS ?? SUPERVISOR_FALLBACKS.join(","))
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return new Supervisor({ model, apiKey: key, stallMs: 45_000, fallbacks });
}

export class Supervisor {
  private readonly config: SupervisorConfig;

  constructor(config: SupervisorConfig) {
    this.config = config;
  }

  /** "model" once a separate key is configured; "evidence" otherwise. */
  get mode(): "evidence" | "model" {
    return this.config.apiKey ? "model" : "evidence";
  }

  get canSee(): boolean {
    return this.mode === "model" && this.config.model.capabilities.vision;
  }

  /**
   * Whether a model review is worth an API call. Trivial conversational turns
   * are settled by evidence alone — that is what keeps this affordable.
   */
  shouldReview(digest: TurnDigest): boolean {
    if (this.mode !== "model") return false;
    const didWork = digest.events.some((event) => WORK_EVENTS.has(event.type));
    return didWork || Boolean(digest.files?.length) || claimsSuccess(digest.answer);
  }

  /**
   * Evidence pass, then — only if needed and configured — a model review.
   *
   * A verdict that never reached the model is never approved, however clean
   * the evidence looks: approval is the manager's signature, and the evidence
   * pass cannot forge it.
   */
  async review(digest: TurnDigest): Promise<Verdict> {
    const verdict = this.inspect(digest);
    if (verdict.status === "failed") {
      return { ...verdict, note: "Settled on evidence; the manager was not asked." };
    }
    if (!this.shouldReview(digest)) {
      return {
        ...verdict,
        note:
          this.mode === "model"
            ? "Nothing substantial to review in this turn."
            : "No manager credentials on this deployment — evidence only.",
      };
    }

    try {
      const judged = await this.ask(digest, verdict);
      if (judged) return judged;
      return {
        ...verdict,
        note: this.lastFailure ?? "The manager returned nothing readable.",
      };
    } catch (error) {
      // A manager outage must never fail the user's turn — but it must also
      // never be mistaken for approval.
      return {
        ...verdict,
        issues: [...verdict.issues, "The manager could not be reached"],
        note: error instanceof Error ? shortReason(error.message) : "The manager could not run.",
      };
    }
  }

  /** Why the last model pass gave up. Read once, by `review`. */
  private lastFailure: string | null = null;

  /** The free pass: what the event log and the answer themselves prove. */
  inspect(digest: TurnDigest): Verdict {
    const issues: string[] = [];
    const evidence: string[] = [];

    if (digest.empty || !digest.answer.trim()) {
      return {
        status: "failed",
        summary: "The turn produced no answer",
        issues: ["Worker finished without output"],
        evidence: ["answer length 0"],
        usedModel: false,
        approved: false,
      };
    }

    // A page that throws on load is broken however good it looks.
    if (digest.runtime?.errors.length) {
      return {
        status: "concerns",
        summary: `The page throws at runtime: ${digest.runtime.errors[0]}`,
        issues: digest.runtime.errors,
        evidence: ["ran the page"],
        usedModel: false,
        approved: false,
      };
    }

    const failures = digest.events.filter((event) => FAIL_EVENTS.has(event.type));
    const passes = digest.events.filter((event) => PASS_EVENTS.has(event.type));
    const work = digest.events.filter((event) => WORK_EVENTS.has(event.type));

    if (work.length) evidence.push(`${work.length} work steps`);
    if (passes.length) evidence.push(`${passes.length} passing checks`);
    if (digest.files?.length) evidence.push(`${digest.files.length} files`);
    if (digest.runtime?.ran) {
      evidence.push(
        digest.runtime.errors.length ? "ran with errors" : `ran clean (${digest.runtime.nodes} elements)`,
      );
    }
    if (digest.rateLimited) evidence.push("resumed after a rate limit");

    // A failure is only forgiven if something passed after it.
    for (const failure of failures) {
      const failedAt = digest.events.indexOf(failure);
      const failPhase = EVENT_PHASE[failure.type];
      const recovered = digest.events
        .slice(failedAt + 1)
        .some((event) => PASS_EVENTS.has(event.type) && EVENT_PHASE[event.type] === failPhase);
      if (!recovered) issues.push(`Unresolved failure: ${failure.label ?? failure.type}`);
    }

    if (claimsSuccess(digest.answer) && !passes.length) {
      issues.push("Claimed success with no passing build, test or verification");
    }

    if (digest.durationMs > this.config.stallMs && !work.length && !passes.length && !digest.files?.length) {
      issues.push("Long turn with no observable work");
    }

    if (issues.length) {
      return { status: "concerns", summary: issues[0]!, issues, evidence, usedModel: false, approved: false };
    }

    // No evidence of verification is not the same as verified.
    const status: VerificationStatus = passes.length ? "verified" : "unverified";
    return {
      status,
      summary:
        status === "verified"
          ? `Checked against ${evidence.join(", ")}`
          : evidence.length
            ? `Produced ${evidence.join(", ")}; not yet verified`
            : "Answered; nothing to verify against",
      issues: [],
      evidence,
      // Evidence alone never approves. Only the manager's own "verified"
      // does, which is what stops a turn calling itself done unreviewed.
      approved: false,
      usedModel: false,
    };
  }

  /**
   * The paid pass. When a rendering was captured the monitor *looks* at it —
   * the only way to tell a finished page from a skeleton that merely parses.
   */
  private async ask(digest: TurnDigest, base: Verdict): Promise<Verdict | null> {
    this.lastFailure = null;
    for (const backend of this.backends()) {
      const judged = await this.askOne(digest, base, backend);
      if (judged) return judged;
    }
    return null;
  }

  /**
   * The manager's model, and what to fall back to.
   *
   * The 90B vision reviewer is the one this is designed around, but a provider
   * lists models it cannot always serve — that seat answers 504 for minutes at
   * a time. A manager that is merely slow to be available is a manager that
   * never approves anything, so a second, smaller seat from the same family
   * takes the review rather than leaving the work unjudged. Which one actually
   * answered is recorded on the verdict.
   */
  private backends(): string[] {
    const primary = this.config.model.backend ?? "";
    const seen = new Set<string>();
    return [primary, ...this.config.fallbacks].filter((backend) => {
      if (!backend || seen.has(backend)) return false;
      seen.add(backend);
      return true;
    });
  }

  private async askOne(
    digest: TurnDigest,
    base: Verdict,
    backend: string,
  ): Promise<Verdict | null> {
    const provider = new NvidiaProvider({ ...this.config.model, backend }, this.config.apiKey);
    const seeing = Boolean(digest.screenshot) && this.canSee;
    const body: string | ContentPart[] = seeing
      ? [
          { type: "text", text: renderDigest(digest) },
          { type: "image_url", image_url: { url: digest.screenshot! } },
        ]
      : renderDigest(digest);

    const messages: Message[] = [
      { role: "system", content: seeing ? VISION_PROMPT : TEXT_PROMPT },
      { role: "user", content: body },
    ];

    let raw = "";
    for await (const event of provider.stream({
      messages,
      maxTokens: this.config.model.maxOutputTokens ?? 900,
      temperature: 0,
      // This model has no private reasoning channel to spend the budget on,
      // and a verdict is a short structured answer, not a deliberation.
      thinking: false,
    })) {
      if (event.type === "delta") raw += event.text;
      if (event.type === "error") {
        this.lastFailure = event.message || "The manager model refused the request.";
        return null;
      }
    }

    if (!raw.trim()) {
      this.lastFailure = "The manager model answered with nothing.";
      return null;
    }

    const parsed = parseVerdict(raw);
    if (!parsed) {
      this.lastFailure = "The manager answered, but not in a shape that could be read.";
      return null;
    }
    return {
      status: parsed.status,
      summary: parsed.summary || base.summary,
      issues: parsed.issues.length ? parsed.issues : base.issues,
      evidence: seeing ? [...base.evidence, "rendering reviewed"] : base.evidence,
      usedModel: true,
      sawRendering: seeing,
      report: parsed.report,
      // The signature. Anything short of the manager's own "verified" leaves
      // the work unapproved, and the interface will not call it finished.
      approved: parsed.status === "verified",
      note:
        backend === this.config.model.backend
          ? undefined
          : "The primary reviewer was unavailable; a standby seat reviewed this.",
    };
  }
}

/** Reviewers to fall through to, in order, when the primary will not answer. */
const SUPERVISOR_FALLBACKS = ["meta/llama-3.2-11b-vision-instruct"];

/** A failure reason worth showing: short, and never carrying a credential. */
const shortReason = (message: string) =>
  message.replace(/(key|token|bearer)[^\s]*/gi, "").trim().slice(0, 140) ||
  "The manager could not run.";

const VERDICT_SHAPE = `Reply with JSON only:
{"status":"verified|concerns|failed|unverified","summary":"one short line","issues":["..."],"report":"markdown, 4-8 short lines"}

"verified" needs real evidence AND means the manager approves — only then may the worker say the work is done. "unverified" means it looks fine but nothing proves it — do NOT approve yet. "concerns" means missing requirements, unresolved failures or unsupported claims — send back with specifics. "failed" means it was not delivered. Be strict and brief.`;

const TEXT_PROMPT = `You are Nomin's manager (Llama 3.2 90B Instruct). You review an engineering agent's work and judge only whether it was actually delivered — you never do the work yourself. Your verdict is the approval gate: the worker must not tell the user the work is done until you return "verified". Never complain to the user; provide clear, constructive feedback so the agent can redo the work properly.

${VERDICT_SHAPE}

The report covers: what was requested, what was produced, what is missing, and what to check next. End with an explicit approval line: either "APPROVED" or "NOT APPROVED: <reason>".`;

const VISION_PROMPT = `You are Nomin's manager (Llama 3.2 90B Vision Instruct). You are shown what an engineering agent produced and a rendering of the result. Judge whether the delivered work actually matches the request. Your verdict is the approval gate: the worker must not tell the user the work is done until you return "verified". Never complain to the user; provide clear, constructive feedback so the agent can redo the work properly.

Look at the rendering and say what is really there: complete and presentable, or a skeleton — placeholder text, unstyled elements, collapsed layout, missing sections, overlapping or unreadable content. The RUNTIME line says what happened when the page was actually executed; a page that threw is not verified no matter how it looks.

${VERDICT_SHAPE}

The report covers: what was requested, what the rendering actually shows, what is missing or broken, and what to fix next. Judge the rendering, not the intention. End with an explicit approval line: either "APPROVED" or "NOT APPROVED: <reason>".`;

/** The digest the monitor sees: capped, structured, no private reasoning. */
function renderDigest(digest: TurnDigest): string {
  const files = digest.files?.length
    ? digest.files.map((file) => `${file.name} (${file.lines} lines)`).join(", ")
    : "none";
  const events = digest.events
    .slice(-24)
    .map(
      (event) =>
        `${event.type}${event.label ? ` ${event.label}` : ""}${event.detail ? ` (${event.detail})` : ""}`,
    )
    .join("\n");
  const runtime = digest.runtime?.ran
    ? digest.runtime.errors.length
      ? `threw: ${digest.runtime.errors.join("; ").slice(0, 300)}`
      : `ran with no errors, ${digest.runtime.nodes} elements rendered`
    : "not executed";

  return [
    `REQUEST: ${digest.request.slice(0, 400)}`,
    `RUNTIME: ${runtime}`,
    `ANSWER (${digest.answer.length} chars): ${digest.answer.slice(0, 900)}`,
    `FILES PRODUCED: ${files}`,
    `DURATION: ${Math.round(digest.durationMs / 1000)}s${digest.rateLimited ? " (rate limited, resumed)" : ""}`,
    `EVENTS:\n${events || "none"}`,
  ].join("\n\n");
}

type ParsedVerdict = {
  status: VerificationStatus;
  summary: string;
  issues: string[];
  report?: string;
};

const STATUSES: VerificationStatus[] = ["verified", "concerns", "failed", "unverified"];

/**
 * Read the manager's answer.
 *
 * JSON is what it is asked for, and the strict path is tried first. But a
 * reviewer that writes its verdict in a sentence has still reviewed the work,
 * and throwing that away meant every such turn came back "the manager could
 * not run" — which is how a working manager looked broken. So a prose answer
 * is salvaged from its approval line rather than discarded.
 */
export function parseVerdict(raw: string): ParsedVerdict | null {
  return parseJsonVerdict(raw) ?? parseProseVerdict(raw);
}

function parseProseVerdict(raw: string): ParsedVerdict | null {
  const text = raw.trim();
  if (!text) return null;
  const lower = text.toLowerCase();

  /**
   * The status the manager actually declared.
   *
   * An explicit `"status": "concerns"` is the answer, full stop — it is what
   * was asked for, and a reviewer that wrote it has decided. Only when there
   * is no such field does the word itself count, and then it is the *first*
   * one in the text, not the first one in this list: scanning the list in
   * order found "verified" wherever it appeared later in a report and handed
   * back an approval for work the manager had just rejected in its opening
   * line. Nothing is more important than this being right.
   */
  const declared = /"?\bstatus"?\s*[:=]\s*"?(verified|concerns|failed|unverified)\b/.exec(lower);
  let status: VerificationStatus | null = (declared?.[1] as VerificationStatus) ?? null;

  // Then the approval line the prompt asks for. It comes before the bare-word
  // scan because it is a verdict, and a bare word in running prose is not:
  // "NOT APPROVED — nothing can be verified until the menu exists" was read as
  // an approval, on the strength of the word "verified" in the explanation of
  // why it was being refused. "not approved" is tested first so it is never
  // mistaken for the word it contains.
  if (!status) {
    if (/\bnot approved\b/.test(lower)) status = "concerns";
    else if (/\bapproved\b/.test(lower)) status = "verified";
  }

  // Last, a bare status word — the earliest one in the text, not the first in
  // this list, which is a different thing and was the other half of the bug.
  if (!status) {
    let earliest = Infinity;
    for (const candidate of STATUSES) {
      const at = new RegExp(`\\b${candidate}\\b`).exec(lower)?.index ?? -1;
      if (at !== -1 && at < earliest) {
        earliest = at;
        status = candidate;
      }
    }
  }
  if (!status) return null;

  // Bulleted lines are the findings; the first ordinary sentence is the summary.
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const issues = cleanIssues(
    lines.filter((line) => /^[-*•]\s+/.test(line)).map((line) => line.replace(/^[-*•]\s+/, "")),
  );
  // A summary field the model wrote beats the first line of the raw reply —
  // which, when the reply was JSON that failed to parse, was the JSON itself.
  const written = /"summary"\s*:\s*"([^"]{4,200})"/.exec(text)?.[1];
  const summary =
    written ??
    lines
      .find((line) => !/^[-*•#{[]/.test(line) && !line.includes('":') && line.length > 12)
      ?.slice(0, 160) ??
    (status === "verified" ? "The manager approved the work." : "The manager sent the work back.");

  return { status, summary, issues, report: text.slice(0, 2400) };
}

function parseJsonVerdict(raw: string): ParsedVerdict | null {
  // `parseLooseJson` closes what the token ceiling cut off. A verdict whose
  // `report` field ran out of room is still a verdict, and rejecting it sent
  // the whole thing to the prose reader — which then had to guess at a status
  // the model had stated plainly in the first field.
  const parsed = parseLooseJson(raw) as {
    status?: string;
    summary?: string;
    issues?: unknown;
    report?: string;
  } | null;
  if (!parsed || typeof parsed !== "object") return null;

  const status = parsed.status as VerificationStatus | undefined;
  if (!status || !STATUSES.includes(status)) return null;
  return {
    status,
    summary: (parsed.summary ?? "").slice(0, 160),
    issues: cleanIssues(parsed.issues),
    report: typeof parsed.report === "string" ? parsed.report.slice(0, 2400) : undefined,
  };
}

/** Findings worth showing: real strings, trimmed, no blanks, no repeats. */
function cleanIssues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    const text = String(item ?? "").trim().slice(0, 200);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length === 5) break;
  }
  return out;
}

const claimsSuccess = (answer: string) => {
  const text = answer.toLowerCase();
  return CLAIMS.some((claim) => text.includes(claim));
};
