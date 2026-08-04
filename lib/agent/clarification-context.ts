// Clarification context is deliberately deterministic and local: it looks at
// facts the turn already has (workspace snapshot, attachments, retained
// decisions). It never performs a second model request or a hidden tool call.
// That lets Step 1 avoid asking questions the workspace can already answer.

import type { NormalInput } from "./types";

export type ClarificationContext = {
  facts: string[];
  /** A decision that is safe to infer from an established workspace pattern. */
  assumption?: string;
};

const MAX_FACTS = 3;

export function clarificationContextFor(input: NormalInput): ClarificationContext {
  const files = input.workspace_snapshot.file_tree.map((path) => path.replace(/\\/g, "/"));
  const lowerFiles = files.map((path) => path.toLowerCase());
  const facts: string[] = [];
  const message = input.user_message.toLowerCase();

  const nextEntry = files.find((path) => /^app\/(?:page|layout)\.(?:tsx?|jsx?)$/i.test(path));
  const viteEntry = files.find((path) => /(?:^|\/)src\/(?:main|app)\.(?:tsx?|jsx?)$/i.test(path));
  const hasNext = lowerFiles.some((path) => path === "next.config.js" || path === "next.config.mjs" || path.startsWith("app/"));
  const hasVite = lowerFiles.some((path) => /(?:^|\/)vite\.config\./.test(path)) || Boolean(viteEntry);
  const authFiles = files.filter((path) => /(?:^|\/)(?:auth|authentication|session|middleware)(?:[./_-]|$)/i.test(path));
  const styleFile = files.find((path) => /(?:globals|styles|app)\.(?:css|scss|sass)$/i.test(path));

  if (hasNext) facts.push(`The workspace uses a Next.js-style app structure${nextEntry ? ` with ${nextEntry}` : ""}.`);
  else if (hasVite) facts.push(`The workspace uses a Vite/React-style app structure${viteEntry ? ` with ${viteEntry}` : ""}.`);
  if (styleFile) facts.push(`Shared styling is already present in ${styleFile}.`);
  if (authFiles.length > 0) facts.push(`Authentication-related files already exist (${authFiles.slice(0, 2).join(", ")}).`);

  const priorAssumption = [...input.conversation_history]
    .reverse()
    .find((turn) => turn.role === "assistant" && /^assumption:\s+/i.test(turn.content))
    ?.content.replace(/^assumption:\s*/i, "").trim();
  if (priorAssumption) facts.push(`A prior decision is recorded: ${priorAssumption}`);

  // Authentication is a meaningful product decision in a blank project, but
  // not when the current workspace already establishes an auth convention.
  // This is intentionally narrow: a framework alone must not override a real
  // creative/product choice such as what kind of game to build.
  let assumption: string | undefined;
  if (/\b(auth(?:entication)?|sign[ -]?in|log[ -]?in|session)\b/i.test(message) && authFiles.length > 0) {
    assumption = `I’ll extend the authentication pattern already used in ${authFiles[0]}.`;
  } else if (priorAssumption && /\b(?:continue|apply|use|implement|add|update|change)\b/i.test(message)) {
    assumption = priorAssumption;
  }

  return { facts: facts.slice(0, MAX_FACTS), assumption };
}

/** Keep the classifier’s hot-path prompt small; workspace facts only belong on
 * turns that could otherwise be paused for a missing implementation decision. */
export function canUseClarificationContext(input: NormalInput): boolean {
  const text = input.user_message.trim();
  return text.length > 0 && /\b(?:add|build|change|configure|create|fix|implement|improve|make|modify|redesign|update)\b/i.test(text);
}
