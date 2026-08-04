import { buildFinalOutput } from "./output/builder";
import type { AgentOutput } from "./types";
import type { ClarificationContext } from "./clarification-context";

/**
 * Intent classification may explain its decision in `reason`; that field is
 * not inherently user-facing. Only a concise question may cross the boundary
 * into the chat transcript. This prevents internal narration such as "I need
 * to clarify…" from being shown as if it were an answer.
 */
const META_REASONING = /\b(?:the user|user wants|i need|intent|classif(?:y|ication)|ambig(?:uous|uity)|missing details?|no details?|insufficient (?:context|details?))\b/i;
const QUESTION_START = /^(?:\d+\.\s*)?(?:what|which|where|when|how|could you|can you|would you|please (?:describe|tell|share))\b/i;
const GENERIC_QUESTION = /^(?:could you clarify|what would you like to build|what do you want|please provide more details)/i;

export function toClarificationQuestion(
  reason: string | null | undefined,
  userMessage = "",
  context?: ClarificationContext,
): string {
  const question = reason?.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim() ?? "";
  const firstLine = question.split("\n", 1)[0] ?? "";
  const isQuestion = firstLine.endsWith("?") || QUESTION_START.test(firstLine);
  // Framework, styling, and implementation-library choices are not open
  // product questions when the project already established them.  Prefer a
  // project-relevant question over faithfully repeating an irrelevant model
  // question such as “Which framework should I use?” in a Next.js workspace.
  const asksForKnownConvention = /\b(?:framework|tech(?:nology)? stack|library|tailwind|css approach|typescript|router|auth(?:entication)? library)\b/i.test(question);

  if (question.length >= 12 && question.length <= 340 && isQuestion && !META_REASONING.test(question) && !GENERIC_QUESTION.test(question) && !(asksForKnownConvention && context?.facts.length)) {
    return isQuestion ? question : `${question}?`;
  }

  return questionFor(userMessage, context);
}

/** A deterministic fallback keeps a malformed classifier response from turning
 * into vague UX. The numbered options share one decision axis; they are not a
 * hidden plan or a list of unrelated questions. */
function questionFor(userMessage: string, context?: ClarificationContext): string {
  const text = userMessage.toLowerCase();
  const projectLead = projectLeadFor(context);
  if (/\bduck\b.*\bgame\b|\bgame\b.*\bduck\b/.test(text)) {
    return `${projectLead}Which kind of duck game should I build?\n1. Clicker\n2. Hunting\n3. Simulation\n4. Platformer`;
  }
  if (/\bgame\b/.test(text)) {
    return `${projectLead}Which kind of game should I build?\n1. Clicker\n2. Simulation\n3. Platformer`;
  }
  if (/\bdashboard\b/.test(text)) {
    return `${projectLead}What should this dashboard help you monitor or manage?`;
  }
  if (/\b(?:website|site|landing page)\b/.test(text)) {
    return `${projectLead}What should the site help visitors understand or do?`;
  }
  if (/\b(?:improve|redesign|polish)\b/.test(text)) {
    return `${projectLead}What should improve most: visual design, usability, performance, or a specific broken flow?`;
  }
  return `${projectLead}What outcome should I help you create?\n1. A website or app\n2. A dashboard\n3. An API or automation`;
}

/** A short project acknowledgement is useful only when it prevents an
 * irrelevant implementation question. It is intentionally one sentence and
 * never exposes file paths or turns the clarification into a trace. */
function projectLeadFor(context?: ClarificationContext): string {
  const framework = context?.facts.find((fact) => /\b(?:Next\.js|Vite\/React)\b/i.test(fact));
  if (!framework) return "";
  const name = /Next\.js/i.test(framework) ? "Next.js" : "the existing Vite/React setup";
  return `I’ll keep the project’s ${name} setup. `;
}

/** The entire clarification contract: plain text only. Keeping it in one
 * helper makes it structurally impossible for the Step 1 path to accidentally
 * attach a plan, trace row, or artifact. */
export function buildClarificationOutput(question: string): AgentOutput {
  return buildFinalOutput(
    {
      message: question,
      next_action_hint: "Reply with the detail above and I’ll continue from there.",
    },
    null,
    [],
    [],
    "needs_clarification",
  );
}
