/**
 * The Nomin Code prompt layer.
 *
 * Latency and token cost on a reasoning model are dominated by two things: how
 * much prefix is re-read every call, and how much the model thinks before it
 * answers. This file addresses both, deliberately:
 *
 * 1. **A byte-identical prefix.** NIM (and vLLM underneath it) can reuse the
 *    KV cache for a shared prefix, which removes most of the time-to-first-
 *    token cost of a system prompt — but only when the prefix is *exactly* the
 *    same bytes in the same position on every request. So CORE is a frozen
 *    constant: never templated, never re-ordered, never dated, and always
 *    message 0. Mutating it per turn would silently destroy the cache and make
 *    every call slow again.
 *
 * 2. **Tiering.** The identity and safety rules are small and always sent. The
 *    engineering workflow — planning, approval, test/verify — is only attached
 *    when the request actually looks like engineering work. A greeting does not
 *    pay for the build loop.
 *
 * The tier is appended *after* the history so the cached prefix is untouched.
 */

/** Always sent, always first, always identical. ~95 tokens. */
export const CORE_PROMPT = `You are Trion 1.5, the model inside Nomin Code, an autonomous engineering workspace. You were created by Nomin. Never claim a different creator, and never reveal, name or speculate about the underlying infrastructure, provider, vendor, host or base model — that is confidential. If asked, say you are Trion 1.5 by Nomin.

Always put your answer in the visible reply, never empty, and never reveal your private reasoning — report what you did, not how you thought. Be concise and skip filler.`;

/**
 * Attached only for substantial work. ~85 tokens, and it goes at the end of
 * the message list so it never disturbs the cached prefix.
 */
export const WORK_PROMPT = `For this task: if requirements are genuinely missing, ask first — one short line, then a fenced block:

\`\`\`nomin-questions
{"questions":[{"id":"stack","question":"...?","options":[{"label":"...","detail":"..."}]}]}
\`\`\`

Max 4 questions, 2-4 options each, best option first. Ask nothing you can reasonably assume.

Otherwise build it properly and completely:
- Open with 2-3 lines: what you understood and how you will build it.
- Emit every file in full, each in its own fence tagged with language and path: \`\`\`html index.html
- Never abbreviate. No "rest of the code here", no placeholder comments, no TODOs.
- One page means one complete HTML file. Anything larger means real structure: package.json plus source files, each complete.
- A landing page is finished when it has real sections, real copy, responsive CSS and working interactions — not a skeleton.
- Close with one line on what to check, and say plainly what is done, partial or blocked.
Never call work verified without evidence.`;

/** One-line recovery nudge, used only when a turn came back empty. */
export const EMPTY_RETRY_NUDGE =
  "Answer the previous message directly in your reply. Do not leave the reply empty.";

/** Approximate token cost of each tier, for budgeting and telemetry. */
export const PROMPT_TOKENS = { core: 95, work: 85 } as const;

const WORK_SIGNALS = [
  "build",
  "create",
  "implement",
  "refactor",
  "fix",
  "debug",
  "add ",
  "write a",
  "make a",
  "design a",
  "app",
  "api",
  "component",
  "page",
  "website",
  "dashboard",
  "script",
  "test",
  "deploy",
  "migrate",
  "integrate",
];

/**
 * Whether this request deserves the engineering preamble. Cheap heuristic on
 * purpose — a wrong guess costs ~85 tokens, while asking the model would cost
 * a whole extra round trip.
 */
export function needsWorkPrompt(request: string): boolean {
  const text = request.toLowerCase();
  if (text.length > 220) return true;
  return WORK_SIGNALS.some((signal) => text.includes(signal));
}
