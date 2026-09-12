// STEP 1: Intent Classification (always trion-1.4)
// Classifies user message as "direct_answer", "task", or "needs_clarification"
// and picks the activity status (from ACTIVITY_LIST) that best matches what the task actually is.

import type { NormalInput, IntentDoc } from "../types";
import { modelGateway } from "../model-gateway";
import { currentTurnSignal } from "../turn-control";
import type { NimMessage } from "../types";
import { toAgentStatus } from "../types";
import { INTENT_SYSTEM_PROMPT } from "../static-prompts";
import { canUseClarificationContext, clarificationContextFor } from "../clarification-context";

const GREETING_WORDS = /\b(hi|hey|yo|sup|howdy|hola)\b|\bhello\b(?!-)/i;
const THANKS_WORDS = /\b(thanks|thank\s?you|thx|appreciate)\b/i;
const QUESTION_WORDS = /\b(what|how|why|when|where|who|which|explain|tell\s?me|is\s?it|can\s?you|does)\b/i;
const IDENTITY_WORDS = /\b(who\s+(?:(?:are|r)\s+you|(?:made|created|built|developed)\s+(?:you|u|trion))|what\s+(are|r)\s+you|wt\s+(are|r)\s+u|wt\s+is\s+u|wt\s+si\s+ur?\s+name|wt\s+is\s+ur?\s+name|who\s+am\s+i\s+talking\s+to)\b/i;
const CAPABILITY_QUESTIONS =
  /\b(?:wt|what|which)\s+(?:can|could)\s+(?:you|u)\s+(?:do|help|make|build)\b|\b(?:wt|what)\s+(?:you|u)\s+can\s+do\b|\bwhat\s+are\s+(?:your|ur)\s+capabilities\b|\bshow\s+me\s+what\s+(?:you|u)\s+can\s+do\b/i;
// Vague/ambiguous patterns that suggest the user hasn't expressed a clear intent yet
// These match general capability/exploration questions that need clarification before action
// EXPLICITLY EXCLUDE clear identity questions ("what are you") and clear capability questions ("what can you do")
const AMBIGUOUS_PATTERNS = [
  /\bwt\s+(canwe|can\s+we|do\s+we|is\s+this)\b/i,  // "wt canwe", "wt can we", "wt do we", "wt is this"
  /\bwhat\s+(can|do)\s+we\b/i,           // "what can we", "what do we"
  /\bhow\s+(can|do)\s+we\b/i,            // "how can we", "how do we"
  /\bcan\s+we\s+(do|work)\b/i,           // "can we do", "can we work"
  /^\s*can\s+u\s+(build|make|create|do|fix)\s+(something|anything|a\s+thing|stuff)\b/i,  // "can u build something" - vague object
  /^\s*can\s+you\s+(build|make|create|do|fix)\s+(something|anything|a\s+thing|stuff)\b/i, // "can you build something" - vague object
  /^\s*could\s+(?:you|u)\s+(?:build|make|create)\s+(?:literally\s+)?(?:something|anything|a\s+thing|stuff)\b/i, // exploratory request, not consent to invent a product
  /^\s*help\s+(me|us)\s+(?:build|make|create|do|fix)\s+(something|anything|a\s+thing|stuff)\b/i, // delegated work with no actual outcome
  /\bhelp\s+(me|us)\b(?!\s+(with|do|fix|create|build|write|code|debug|test|deploy))/i, // "help me" without specific context
  /\bwhat\s+(should|do)\s+(i|we)\b/i,    // "what should i do", "what do we do"
  /\banything\s+(else|more)\b/i,         // "anything else"
  /^\s*(wt|what|how|why)\s*[?!]*\s*$/i,  // Just "wt?" or "what?"
  /^\s*wt\s+can\s+u\s+do\s*$/i,         // Abbreviated capability fragment without a question mark
] as const;

const WRITING_WORDS = /\b(grammar|essay|email|letter|report|article|blog|rewrite|proofread|edit|polish|spelling|poem|story|fiction|paragraph|sentence|content|copy|lyrics|headline|tweet|caption)\b/i;
const DEBUG_WORDS = /\b(debug|bug|error|exception|crash(es|ed|ing)?|fail(ed|s|ing)?|not\s?working|broken|stack\s?trace|fix(es|ed|ing)?)\b/i;
const TEST_WORDS = /\b(test|testing|tests|coverage|spec)\b/i;
const DEPLOY_WORDS = /\b(deploy|push|publish|release|ship|production)\b/i;
const SEARCH_WORDS = /\b(search|find|look\s?up|research|google|documentation|docs|list|show|display|view|read|cat|ls|dir)\b/i;
const PLAN_WORDS = /\b(plan|design|architecture|architect|outline|approach|roadmap)\b/i;
const FILE_WORDS = /\b(create|write|make|add|implement|build|generate|file|rename|move|delete|remove|clean|modify|update)\b/i;
/** A bare game brief has no technical default: its genre changes the outcome
 * enough that the classifier may legitimately pause. Keep this narrow so a
 * named outcome such as "build a todo app" still starts immediately. */
const BARE_GAME_BRIEF = /^\s*(?:(?:please|can|could)\s+(?:you|u)\s+)?(?:build|make|create)\s+(?:me\s+)?(?:a\s+)?(?:\w+\s+)?game\s*[.!?]*\s*$/i;
// --- Work-request detection -------------------------------------------------
//
// A bare keyword test ("does the message contain the word 'write'?") is NOT a
// usable task signal: it fires on "how do i write a good commit message?",
// "what's the difference between find and grep?", "thanks, that helped me find
// the issue". Every one of those is conversation, and treating them as tasks is
// the root cause of the recurring fake-plan / fake-trace / spurious-approval bug.
//
// What actually distinguishes a task is GRAMMATICAL FORM, not vocabulary: the
// user must be asking the agent to DO something, either as an imperative
// ("create a file...") or as a delegated request ("can you create a file...").
// Asking ABOUT a concept that happens to share a verb is not a work request.

// The verb list is the whole of the task/conversation boundary, so a gap in it
// is indistinguishable from a bug. "change the heading in App.tsx to say X and
// start the dev server" was classified as needs_clarification purely because
// "change" was missing here — as unambiguous a work request as exists.
const WORK_VERBS = [
  // creating
  "create", "write", "make", "add", "implement", "build", "generate", "scaffold", "init", "initialize", "set\\s?up", "start",
  // changing
  "change", "modify", "update", "edit", "replace", "swap", "adjust", "tweak", "convert", "migrate", "refactor", "rewrite",
  "rename", "move", "delete", "remove", "clean", "extract", "inline", "split", "merge", "extend", "wire", "hook", "connect",
  "style", "restyle", "redesign", "improve", "optimi[sz]e", "simplify", "port", "upgrade", "downgrade", "bump", "revert", "undo",
  // fixing
  "fix", "repair", "debug", "resolve", "patch", "handle",
  // running
  "install", "configure", "run", "execute", "launch", "serve", "preview", "deploy", "publish", "ship", "package", "compile", "lint", "format",
  // inspecting
  "list", "show", "display", "view", "read", "open", "search", "find", "check", "inspect", "audit", "review", "test",
].join("|");

/** Imperative form: a SENTENCE opens with a work verb ("create a file...").
 *
 *  Anchored per sentence, not per message. Anchoring at the start of the whole
 *  message meant that stating the context first defeated it entirely:
 *  "projects/web/src/broken.ts has a syntax error. Find it and fix it." was
 *  classified needs_clarification and answered with "could you clarify what
 *  you'd like me to help with?" — the exact mirror-image failure this file
 *  warns about, on about as unambiguous an instruction as exists. Putting the
 *  subject before the imperative is ordinary English, not ambiguity.
 *
 *  The boundary is real sentence punctuation ONLY — not ", " and not "and".
 *  Admitting "and" as a boundary would promote "what's the difference between
 *  build and run?" to a task on the strength of the word "run", which is the
 *  vocabulary-not-grammar mistake this whole section exists to avoid. */
const IMPERATIVE_REQUEST = new RegExp(
  `(?:^|[.!?;\\n])\\s*(?:(?:please|pls|now|then|also|ok|okay|so|next)\\s+)*(?:${WORK_VERBS})\\b`,
  "i"
);

/** Delegated form: "can you create...", "i want you to build...", "let's run...". */
const DELEGATED_REQUEST = new RegExp(
  [
    `\\b(?:can|could|would|will|pls|please)\\s+(?:you|u)\\s+(?:please\\s+|pls\\s+)?(?:${WORK_VERBS})\\b`,
    `\\bi(?:'d)?\\s+(?:want|need|would\\s+like|like)\\s+(?:you|u)\\s+to\\s+(?:${WORK_VERBS})\\b`,
    `\\bi\\s+(?:want|need)\\s+(?:you|u)\\s+(?:${WORK_VERBS})\\b`,
    `\\blet'?s\\s+(?:${WORK_VERBS})\\b`,
    `\\bgo\\s+ahead\\s+and\\s+(?:${WORK_VERBS})\\b`,
  ].join("|"),
  "i"
);

/** Questions about the agent itself are never work, whatever verbs they contain.
 *  "can you show me what you can do?" is a capability question, not a request
 *  to run `show`. */
function isAboutTheAgent(text: string): boolean {
  return IDENTITY_WORDS.test(text) || CAPABILITY_QUESTIONS.test(text);
}

/** True only when the user is asking the agent to act on the workspace. */
function looksLikeWorkRequest(text: string): boolean {
  if (isAboutTheAgent(text)) return false;
  return IMPERATIVE_REQUEST.test(text) || DELEGATED_REQUEST.test(text);
}

// --- Answerable-question detection ------------------------------------------
//
// The mirror image of looksLikeWorkRequest, and the guard that was MISSING.
//
// The override table had a rule promoting a wrong "direct_answer" up to "task",
// and a rule promoting a wrong "direct_answer" up to "needs_clarification" — but
// no rule demoting a wrong "needs_clarification" back down. So whenever the
// model decided a perfectly answerable question needed clarifying, nothing
// caught it: "should i use tabs or spaces?" came back as "Could you clarify
// which style guide you'd like to follow?". The asymmetry is why this bug keeps
// returning in a new shape — each fix patched one direction of a two-way
// boundary.
//
// Same principle as the task side: decide on FORM, not vocabulary. A question
// that is grammatically self-contained has everything needed to answer it.

/** Interrogative opening, or plain question punctuation. */
const QUESTION_FORM =
  /^\s*(?:what|how|why|when|where|who|whom|which|whose|is|are|was|were|do|does|did|should|shall|could|would|can|will|may|might|explain|tell\s+me|any\s+(?:idea|thoughts))\b/i;

/**
 * A question this agent can simply answer, with no workspace action and nothing
 * left to ask back about.
 *
 * Deliberately conservative — every exclusion below hands the decision back to
 * the model rather than overriding it:
 *  - a work request is a task, even in question form ("can you create a file?");
 *  - an input matching a known-vague pattern really does need clarifying;
 *  - a message naming a concrete file/path/command may well be a read request,
 *    so "what does App.tsx do?" is left for the model to route.
 */
function isAnswerableQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (looksLikeWorkRequest(trimmed)) return false;
  if (isAmbiguous(trimmed)) return false;
  if (CONCRETE_REFERENCE.test(trimmed)) return false;
  return QUESTION_FORM.test(trimmed) || trimmed.endsWith("?");
}

/** An outstanding question is context, not a trap. Greetings, identity/capability
 * questions, thanks, and an explicit casual-chat exit interrupt a paused task
 * instead of being force-fed into it as an "answer". Do NOT include every
 * answerable question here: "what about Vue?" can be a material response to
 * the current question, and the model is the authority for that case. */
function interruptsClarification(text: string): boolean {
  return GREETING_WORDS.test(text) || THANKS_WORDS.test(text) ||
    IDENTITY_WORDS.test(text) || CAPABILITY_QUESTIONS.test(text);
}

/**
 * Would this turn be classified as a task no matter what the model says?
 *
 * The classifier already promotes these to "task" unconditionally (see the
 * override in classifyIntent), so the orchestrator can start generating the plan
 * in parallel with classification instead of after it, and take a whole model
 * round trip off the critical path. It is deliberately the SAME predicate, so
 * the speculative plan can never be built for a turn that ends up conversational
 * — no wasted call, no phantom plan node.
 */
export function isDefinitelyTask(input: NormalInput): boolean {
  if (isAmbiguous(input.user_message)) return false;
  if (pendingClarification(input)) return false;
  if (BARE_GAME_BRIEF.test(input.user_message)) return false;
  return looksLikeWorkRequest(input.user_message);
}

const CONVERSATIONAL_ACTIVITIES = new Set([
  "greeting", "thanking", "responding", "answering", "clarifying", "understanding", "discussing",
  "storytelling", "teaching", "quoting", "suggesting", "paraphrasing", "summarizing", "recommending",
  "comparing", "defining", "exploring", "ideating", "brainstorming", "factchecking", "translating", "explaining",
]);

/** A message that names a file, a path, a command or a quoted literal is
 *  concrete by construction — whatever else it says, there is something
 *  specific to act on and re-asking "what would you like?" is never right. */
const CONCRETE_REFERENCE = /(?:[\w.-]+\/[\w.-]+)|(?:\b[\w-]+\.(?:tsx?|jsx?|css|scss|html|json|md|ya?ml|py|rs|go|java|rb|sh|toml)\b)|`[^`]+`|"[^"]{3,}"|'[^']{3,}'/;

function isAmbiguous(text: string): boolean {
  const lower = text.toLowerCase().trim();
  // Very short inputs that are likely incomplete
  if (lower.length < 4) {
    // But known greetings are NOT ambiguous
    if (GREETING_WORDS.test(lower)) return false;
    if (THANKS_WORDS.test(lower)) return false;
    return true;
  }
  if (CONCRETE_REFERENCE.test(text)) return false;
  return AMBIGUOUS_PATTERNS.some(pattern => pattern.test(lower));
}

function heuristicActivity(text: string, intent: IntentDoc["intent"]): ReturnType<typeof toAgentStatus> {
  const lower = text.toLowerCase();
  if (intent === "direct_answer") {
    if (GREETING_WORDS.test(lower)) return "greeting";
    if (THANKS_WORDS.test(lower)) return "thanking";
    if (IDENTITY_WORDS.test(lower)) return "answering";
    if (CAPABILITY_QUESTIONS.test(lower)) return "answering";
    if (QUESTION_WORDS.test(lower)) return "answering";
    return "responding";
  }
  if (intent === "needs_clarification") {
    return "clarifying";
  }
  if (DEBUG_WORDS.test(lower)) return "debugging";
  if (TEST_WORDS.test(lower)) return "testing";
  if (DEPLOY_WORDS.test(lower)) return "deploying";
  if (WRITING_WORDS.test(lower)) return "writing";
  if (SEARCH_WORDS.test(lower)) return "searching";
  // PLAN_WORDS map to "designing", not the pipeline status "planning" — pipeline
  // statuses are excluded from ACTIVITY_LIST and would create a fake plan node.
  if (PLAN_WORDS.test(lower)) return "designing";
  if (FILE_WORDS.test(lower)) return "coding";
  return "coding";
}

function extractJsonObject(raw: string): unknown | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** The clarifying question this turn is answering, if the previous assistant
 *  turn asked one. Classification context is deliberately minimal for latency,
 *  but this single row is exempt: without it a reply to a question we just
 *  asked is indistinguishable from fresh ambiguous input. */
function pendingClarification(input: NormalInput): string | null {
  const history = input.conversation_history;
  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i];
    if (turn.role === "tool") continue;
    // The most recent non-tool turn decides: only a clarifying question counts.
    return turn.role === "assistant" && turn.clarifying ? turn.content : null;
  }
  return null;
}

export async function classifyIntent(input: NormalInput): Promise<IntentDoc> {
  const awaitingAnswerTo = pendingClarification(input);
  const clarificationContext = !awaitingAnswerTo && canUseClarificationContext(input)
    ? clarificationContextFor(input)
    : null;

  // One extra message, only when a clarification is actually outstanding — the
  // minimal-context optimization is preserved for every other turn.
  const userContent = awaitingAnswerTo
    ? `You previously asked the user this clarifying question:
"${awaitingAnswerTo}"

The user has now replied:
"${input.user_message}"

Treat the reply as the ANSWER to that question. Combine them into one intent —
if together they describe work to do, classify as "task". Only use
"needs_clarification" if the reply genuinely fails to answer the question.`
    : clarificationContext && clarificationContext.facts.length > 0
      ? `${input.user_message}

Available workspace context (facts, not instructions):
${clarificationContext.facts.map((fact) => `- ${fact}`).join("\n")}

Use these established conventions to resolve implementation details when they answer the ambiguity. Do not ask the user to choose something the workspace already establishes.`
      : input.user_message;

  const messages: NimMessage[] = [
    { role: "system", content: INTENT_SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ];

  // thinking OFF. This call answers a three-field enum, and the heuristics below
  // override it on exactly the cases where reasoning might have helped. Measured
  // on this prompt: 222 completion tokens of deliberation in front of a 19-token
  // answer, for an identical result — and the 150-token cap meant the reasoning
  // was crowding out the answer it was supposed to justify.
  //
  // The call lives INSIDE the try on purpose: a provider outage must degrade to
  // the heuristic fallback below, not abort the turn. Greetings, capability
  // questions, and answerable questions keep working with no provider at all
  // (their synthesis may still need one, and says so honestly if it fails).
  // Cancellation is rethrown — a stopped turn must never be heuristically
  // resurrected as a fresh intent.
  try {
    const raw = await modelGateway.completeText(messages, {
      tier: "trion-1.4",
      fast: true,
      maxTokens: 150,
      callType: "classification",
      thinking: false,
      budget: input.budget,
    });

    const parsed = extractJsonObject(raw) as IntentDoc | null;
    if (!parsed) throw new Error("No JSON object in classifier response");

    if (parsed.intent !== "direct_answer" && parsed.intent !== "task" && parsed.intent !== "needs_clarification") {
      throw new Error(`Invalid intent: ${String(parsed.intent)}`);
    }
    let intent: IntentDoc["intent"] = parsed.intent;
    let assumption: string | undefined;

    // Sanity check: an explicit request to DO something must never be answered
    // conversationally. This only fires on imperative/delegated forms — an
    // informational question that merely mentions a work verb is left alone, so
    // conversation can never be promoted into a plan + trace + approval gate.
    if (intent === "direct_answer" && looksLikeWorkRequest(input.user_message)) {
      intent = "task";
    }
    // Clear imperative/delegated work must not be derailed by an over-cautious
    // classifier. Vague object-less requests and bare creative game briefs
    // remain available for a genuine user decision; other actionable work
    // proceeds without a redundant question.
    if (
      intent === "needs_clarification" &&
      looksLikeWorkRequest(input.user_message) &&
      !isAmbiguous(input.user_message) &&
      !BARE_GAME_BRIEF.test(input.user_message)
    ) {
      intent = "task";
    }

    // A bare creative game brief is the opposite boundary: genre determines
    // mechanics, navigation, artwork, copy, and implementation shape. There
    // is no project convention that can honestly choose it for the user. The
    // model sometimes marks an imperative as a task simply because it is
    // actionable; make the user-owned product choice deterministic instead of
    // letting it silently become a random clicker or landing page.
    if (!awaitingAnswerTo && BARE_GAME_BRIEF.test(input.user_message)) {
      intent = "needs_clarification";
    }

    // Heuristic: catch ambiguous patterns the model might miss.
    // SUPPRESSED while a clarification is outstanding: answers to a question we
    // just asked are short and context-dependent by nature ("yes", "a clicker"),
    // so scoring them in isolation re-flags them as ambiguous and loops the
    // same question forever. The model already saw the question + reply above
    // and is the authority in that case.
    if (!awaitingAnswerTo && (intent === "direct_answer" || intent === "task") && isAmbiguous(input.user_message)) {
      intent = "needs_clarification";
    }

    // Context-first: only a concrete, established convention may resolve an
    // otherwise ambiguous task. A framework name alone never replaces a real
    // product or creative decision.
    if (!awaitingAnswerTo && parsed.intent === "needs_clarification" && clarificationContext?.assumption) {
      intent = "task";
      assumption = clarificationContext.assumption;
    }

    // These are complete conversational turns by construction. A malformed
    // or over-cautious classifier response must not turn "hello" or "thanks"
    // into an unnecessary clarification round trip.
    if (!awaitingAnswerTo && intent === "needs_clarification" &&
      (GREETING_WORDS.test(input.user_message) || THANKS_WORDS.test(input.user_message) ||
        IDENTITY_WORDS.test(input.user_message) || CAPABILITY_QUESTIONS.test(input.user_message))) {
      if (!isAmbiguous(input.user_message)) intent = "direct_answer";
    }

    // An open clarification is already a user-approved branch point. The
    // reply belongs to that task; allowing the model to reclassify it as a new
    // clarification is the loop this context guard exists to prevent.
    if (awaitingAnswerTo && intent === "needs_clarification" && isUsefulClarificationAnswer(input.user_message)) {
      intent = "task";
    }

    if (awaitingAnswerTo && interruptsClarification(input.user_message)) {
      intent = "direct_answer";
    }

    // The demotion the table was missing. A self-contained question is
    // answerable BY DEFINITION, so bouncing it back as "could you clarify?" is
    // never the right move — it is the most annoying failure the agent has,
    // because the user gave a complete question and got homework in return.
    //
    // Runs last so the two promotions above still win: a work request stays a
    // task, and a genuinely vague input stays a clarification (isAnswerableQuestion
    // returns false for both).
    if (!awaitingAnswerTo && intent === "needs_clarification" && isAnswerableQuestion(input.user_message)) {
      intent = "direct_answer";
    }

    // A conversational activity on a task intent is never right — re-pick heuristically
    // Only task turns may expose model-chosen working activity. A direct reply
    // and a clarification have fixed user-facing meanings; retaining a stale
    // "coding" activity after we demote an ambiguous request is how a fake
    // progress indicator reappears despite the correct intent.
    const activity = intent !== "task"
      ? heuristicActivity(input.user_message, intent)
      : CONVERSATIONAL_ACTIVITIES.has(parsed.activity as string)
        ? heuristicActivity(input.user_message, intent)
        : toAgentStatus(parsed.activity, heuristicActivity(input.user_message, intent));

    return {
      intent,
      activity,
      reason: parsed.reason,
      assumption,
    };
  } catch (error) {
    // A stopped turn stays stopped: the ambient signal aborted this call, and
    // guessing an intent for it would resurrect cancelled work as a new turn.
    if (currentTurnSignal()?.aborted) throw error;
    // Fallback: keyword heuristic keeps the activity task-appropriate.
    // Task signals always win over question/greeting words ("can you fix X?").
    // Ambiguous conversational patterns should be needs_clarification, not direct_answer.
    const trimmed = input.user_message.trim();
    const head = trimmed.slice(0, 80);
    const hasTaskSignal = looksLikeWorkRequest(trimmed);
    const isIdentity = IDENTITY_WORDS.test(trimmed);
    const isCapability = CAPABILITY_QUESTIONS.test(trimmed);
    // Same anti-loop rule as the main path: never re-ask a question the user is
    // in the middle of answering just because the reply is short.
    const isAmbiguousInput = !awaitingAnswerTo && isAmbiguous(trimmed);
    let intent: IntentDoc["intent"];
    if (awaitingAnswerTo && interruptsClarification(trimmed)) {
      intent = "direct_answer";
    } else if (awaitingAnswerTo) {
      // The model call failed, but we know the user is answering a question we
      // asked. Treat it as a task — asking again is the one guaranteed-wrong move.
      intent = "task";
    } else if (hasTaskSignal && !isAmbiguousInput) {
      intent = "task";
    } else if (isAmbiguousInput) {
      intent = "needs_clarification";
    } else if (GREETING_WORDS.test(head) || THANKS_WORDS.test(head) || isIdentity || isCapability) {
      intent = "direct_answer";
    } else if (isAnswerableQuestion(trimmed)) {
      // Same rule as the main path, so a model outage cannot reintroduce the
      // "could you clarify?" reply to a complete question.
      intent = "direct_answer";
    } else if (QUESTION_WORDS.test(head)) {
      // Questions without task signals or ambiguity - could be either
      // Default to direct_answer for simple Q&A, but this is a heuristic
      intent = "direct_answer";
    } else {
      intent = "needs_clarification";
    }
    const assumption = !awaitingAnswerTo && intent === "needs_clarification" ? clarificationContext?.assumption : undefined;
    if (assumption) intent = "task";
    return { intent, activity: heuristicActivity(trimmed, intent), reason: "Fallback heuristic", assumption };
  }
}

/** A concrete answer such as "a clicker" should continue the paused task;
 * a follow-up question such as "what about Vue?" still needs the model to
 * decide whether the earlier question was actually answered. */
function isUsefulClarificationAnswer(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 1 && !trimmed.endsWith("?") && !isAmbiguous(trimmed);
}
