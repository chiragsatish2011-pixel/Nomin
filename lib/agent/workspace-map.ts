/**
 * A compact, deterministic repository map for planning.
 *
 * The browser supplies a file tree but the old planner received only its
 * count. That forced an avoidable model/tool round trip just to discover
 * `src/App.tsx` or `package.json`. This map is deliberately path-only: it
 * contains no source text, secrets, embeddings, or extra model request.
 */

const MAX_ENTRIES = 48;
const MAX_CHARS = 3_600;

const WEIGHTS: Array<[RegExp, number]> = [
  [/(?:^|\/)(?:package\.json|pnpm-lock\.yaml|yarn\.lock|vite\.config\.|next\.config\.|tsconfig\.json)$/i, 0],
  [/(?:^|\/)(?:src\/)?(?:App|main|index|page|layout)\.[cm]?[jt]sx?$/i, 1],
  [/(?:^|\/)(?:app|pages|src|components|routes)\//i, 2],
  [/\.(?:css|scss|sass|less)$/i, 3],
  [/(?:test|spec)\.[cm]?[jt]sx?$/i, 4],
  [/README|AGENTS\.md|CONTRIBUTING/i, 5],
];

function weight(path: string): number {
  return WEIGHTS.find(([pattern]) => pattern.test(path))?.[1] ?? 6;
}

/** Render the most useful paths first, with a strict cap for prompt budget. */
export function buildWorkspaceMap(paths: readonly string[]): string {
  const clean = [...new Set(paths.map((path) => path.replace(/\\/g, "/").replace(/^\.\//, "").trim()).filter(Boolean))]
    .sort((left, right) => weight(left) - weight(right) || left.localeCompare(right))
    .slice(0, MAX_ENTRIES);

  if (!clean.length) return "- Empty workspace (create the required project files explicitly).";

  const lines: string[] = [];
  let used = 0;
  for (const path of clean) {
    const line = `- ${path}`;
    if (used + line.length + 1 > MAX_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }
  const omitted = paths.length - clean.length;
  if (omitted > 0 && used + 30 <= MAX_CHARS) lines.push(`- … ${omitted} additional paths`);
  return lines.join("\n");
}

