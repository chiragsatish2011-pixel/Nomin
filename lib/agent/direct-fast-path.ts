/**
 * Zero-provider replies for the handful of inputs that have a deterministic,
 * context-free answer. This is deliberately narrow: it is a latency/RPM
 * optimization for greetings, capability questions, elementary arithmetic,
 * and identity questions — not a replacement for intent classification or
 * open-ended conversation. Every pattern here must match the WHOLE message:
 * "what can you do with this file?" needs the workspace, but a bare
 * "wt can you do?" never does.
 */
const GREETING = /^(?:hi|gi|h[iy]+|hii+|hello+|helo|hey+|yo+|howdy|hola)[!,.\s]*$/i;
const CASUAL_CHAT = /^(?:nothing(?:\s*,?\s*just\s+(?:chat|talk))?|just\s+(?:chat|talk)|let'?s\s+(?:just\s+)?(?:chat|talk)|i\s+(?:just\s+)?(?:want|wanna)\s+(?:to\s+)?(?:chat|talk))[!,.\s]*$/i;
const ARITHMETIC = /^(?:what(?:'s| is)?\s+)?(-?(?:\d+(?:\.\d+)?|\.\d+))\s*([+\-*/])\s*(-?(?:\d+(?:\.\d+)?|\.\d+))\s*[?.!\s]*$/i;
const CREATOR_QUESTION = /\b(?:who\s+(?:made|created|built|developed)\s+(?:(?:you|u)|trion)|who(?:'s|\s+is)\s+(?:your|ur)\s+(?:creator|maker)|who\s+is\s+behind\s+(?:you|u|trion))\b/i;
const FALSE_CREATOR_ASSERTION = /(?:\b(?:you|u|trion)\s+(?:were?|was|are)\s+(?:made|created|built|developed)\s+(?:by\s+)?(?!nomin\b)[\w.-]+|\b(?!nomin\b)[\w.-]+\s+(?:made|created|built|developed)\s+(?:you|u|trion))/i;
/** A bare capability question ("wt can you do?"). Anchored: anything with a
 *  trailing object ("what can you build with React?") keeps the full pipeline. */
const CAPABILITY_QUESTION = /^(?:(?:wt|what|which)\s+(?:can|could)\s+(?:you|u)\s+(?:do|help(?:\s+with)?|make|build)(?:\s+for\s+me)?|(?:wt|what)\s+(?:you|u)\s+can\s+do|what\s+are\s+(?:your|ur)\s+capabilities|show\s+me\s+what\s+(?:you|u)\s+can\s+do)\s*[?!.\s]*$/i;
const OFFICIAL_IDENTITY = "I’m Trion, a coding agent created by Nomin.";
const CAPABILITY_REPLY =
  "I can plan and build software projects in a live in-browser workspace — describe what you want, and I’ll make a plan, write the code, run checks, and show you a preview. I can also answer questions directly when no building is needed.";

function cleanNumber(value: number): string {
  if (!Number.isFinite(value)) return "";
  // Avoid floating-point presentation noise while preserving ordinary decimals.
  return Number(value.toFixed(12)).toString();
}

export function directFastReply(message: string): string | null {
  const text = message.trim();
  if (GREETING.test(text)) return "Hello! 👋";
  if (CASUAL_CHAT.test(text)) return "Of course — what would you like to talk about?";
  if (CREATOR_QUESTION.test(text)) return OFFICIAL_IDENTITY;
  if (FALSE_CREATOR_ASSERTION.test(text)) return `That isn’t correct. ${OFFICIAL_IDENTITY}`;
  if (CAPABILITY_QUESTION.test(text)) return CAPABILITY_REPLY;

  const match = text.match(ARITHMETIC);
  if (!match) return null;
  const left = Number(match[1]);
  const right = Number(match[3]);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;

  let result: number;
  switch (match[2]) {
    case "+": result = left + right; break;
    case "-": result = left - right; break;
    case "*": result = left * right; break;
    case "/":
      if (right === 0) return "Division by zero is undefined.";
      result = left / right;
      break;
    default: return null;
  }
  return cleanNumber(result) || null;
}
