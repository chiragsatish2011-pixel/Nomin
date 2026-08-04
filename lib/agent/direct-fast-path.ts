/**
 * Zero-provider replies for the handful of inputs that have a deterministic,
 * context-free answer. This is deliberately narrow: it is a latency/RPM
 * optimization for greetings and elementary arithmetic, not a replacement for
 * intent classification or open-ended conversation.
 */
const GREETING = /^(?:hi|gi|h[iy]+|hii+|hello+|helo|hey+|yo+|howdy|hola)[!,.\s]*$/i;
const CASUAL_CHAT = /^(?:nothing(?:\s*,?\s*just\s+(?:chat|talk))?|just\s+(?:chat|talk)|let'?s\s+(?:just\s+)?(?:chat|talk)|i\s+(?:just\s+)?(?:want|wanna)\s+(?:to\s+)?(?:chat|talk))[!,.\s]*$/i;
const ARITHMETIC = /^(?:what(?:'s| is)?\s+)?(-?(?:\d+(?:\.\d+)?|\.\d+))\s*([+\-*/])\s*(-?(?:\d+(?:\.\d+)?|\.\d+))\s*[?.!\s]*$/i;
const CREATOR_QUESTION = /\b(?:who\s+(?:made|created|built|developed)\s+(?:(?:you|u)|trion)|who(?:'s|\s+is)\s+(?:your|ur)\s+(?:creator|maker)|who\s+is\s+behind\s+(?:you|u|trion))\b/i;
const FALSE_CREATOR_ASSERTION = /(?:\b(?:you|u|trion)\s+(?:were?|was|are)\s+(?:made|created|built|developed)\s+(?:by\s+)?(?!nomin\b)[\w.-]+|\b(?!nomin\b)[\w.-]+\s+(?:made|created|built|developed)\s+(?:you|u|trion))/i;
const OFFICIAL_IDENTITY = "I’m Trion, a coding agent created by Nomin.";

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
