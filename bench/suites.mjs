// The two benchmark suites.
//
// SPEED (13 cases) is the existing eval-test.mjs set: does the loop route a
// message to the right branch, fast, without manufacturing a plan for a
// greeting. Plan mode, no workspace.
//
// CODING (11 cases) is new. Every case is an execute-mode task with a
// machine-checkable outcome — `verify` reads the workspace afterwards and
// decides whether the task was actually COMPLETED, which is what makes
// "tokens per completed task" a real denominator rather than "tokens per turn
// that did not crash".

import fs from "node:fs/promises";
import path from "node:path";

async function read(root, rel) {
  return fs.readFile(path.join(root, rel), "utf-8").catch(() => null);
}

async function exists(root, rel) {
  return fs
    .access(path.join(root, rel))
    .then(() => true)
    .catch(() => false);
}

// ---------------------------------------------------------------------------
// Suite 1 — speed / professionalism (13 cases, plan mode)
// ---------------------------------------------------------------------------

export const SPEED_SUITE = [
  { id: "A1", category: "trivial", input: "hi", expect: "direct_answer" },
  { id: "A2", category: "trivial", input: "thanks", expect: "direct_answer" },
  { id: "A3", category: "trivial", input: "wt are u?", expect: "direct_answer" },
  { id: "A4", category: "trivial", input: "wt can u do?", expect: "direct_answer" },

  { id: "B5", category: "ambiguous", input: "wt canwe together do?", expect: "needs_clarification" },
  { id: "B6", category: "ambiguous", input: "help", expect: "needs_clarification" },
  { id: "B7", category: "ambiguous", input: "can u build something", expect: "needs_clarification" },

  { id: "C8", category: "simple_task", input: "list all files in workspace root", expect: "task" },
  { id: "C9", category: "simple_task", input: "show me the contents of package.json", expect: "task" },

  { id: "D10", category: "multi_step", input: "create a minimal Vite React landing page and start the dev server", expect: "task" },
  { id: "D11", category: "multi_step", input: "add a new utility function to format dates and use it in the App component", expect: "task" },

  { id: "E12", category: "edge", input: "edit the file nonexistent.txt and add hello world", expect: "task" },
  { id: "E13", category: "edge", input: "add a button", expect: "task" },
];

/** A speed case is "completed" when the turn resolved on the branch it should
 *  have, and did not manufacture a plan for a conversational message. */
export function scoreSpeedCase(testCase, run) {
  if (!run.ok || !run.result) return { completed: false, why: run.error || "no result event" };

  const status = run.result.status;
  const hasPlan = Boolean(run.result.plan && run.result.plan.steps.length);

  if (testCase.expect === "direct_answer") {
    if (status === "needs_clarification") return { completed: false, why: "asked for clarification on a conversational message" };
    if (hasPlan) return { completed: false, why: "emitted a plan for a conversational message" };
    if (run.result.tool_trace.length) return { completed: false, why: "produced a tool trace for a conversational message" };
    return { completed: true };
  }

  if (testCase.expect === "needs_clarification") {
    if (status !== "needs_clarification") return { completed: false, why: `expected a clarifying question, got ${status}` };
    return { completed: true };
  }

  // expect: task
  if (status === "needs_clarification") return { completed: false, why: "asked for clarification on an actionable request" };
  if (!hasPlan) return { completed: false, why: "no plan produced for an actionable request" };
  return { completed: true };
}

// ---------------------------------------------------------------------------
// Suite 2 — real coding tasks (11 cases, execute mode, verified outcomes)
// ---------------------------------------------------------------------------

export const CODING_SUITE = [
  {
    id: "T1",
    label: "single file write",
    input: 'create a file hello.txt at the workspace root containing the text "Hello World"',
    async verify(root) {
      const body = await read(root, "hello.txt");
      return body !== null && /hello world/i.test(body);
    },
  },
  {
    id: "T2",
    label: "read and report",
    input: "read projects/web/src/App.tsx and tell me what it renders",
    async verify(root, run) {
      const readIt = run.toolCalls.some((c) => c.tool === "read_file" && String(c.input.path).includes("App.tsx"));
      const mentions = /welcome/i.test(run.result?.message ?? "");
      return readIt && mentions;
    },
  },
  {
    id: "T3",
    label: "edit existing file",
    input: 'change the heading in projects/web/src/App.tsx to say "Nomin Studio"',
    async verify(root) {
      const body = await read(root, "projects/web/src/App.tsx");
      return Boolean(body && /<h1>\s*Nomin Studio\s*<\/h1>/i.test(body));
    },
  },
  {
    id: "T4",
    label: "new util + wire into existing file",
    input:
      "add a utility at projects/web/src/lib/format-date.ts that formats a Date as YYYY-MM-DD, and use it in projects/web/src/App.tsx",
    async verify(root) {
      const util = await read(root, "projects/web/src/lib/format-date.ts");
      const app = await read(root, "projects/web/src/App.tsx");
      return Boolean(util && /export/.test(util) && app && /format-date|formatDate/i.test(app));
    },
  },
  {
    id: "T5",
    label: "search and report",
    input: 'search the workspace for "vite" and list which files mention it',
    async verify(root, run) {
      const searched = run.toolCalls.some((c) => c.tool === "search_codebase");
      const message = run.result?.message ?? "";
      return searched && /package\.json/.test(message);
    },
  },
  {
    id: "T6",
    label: "new component + render it",
    input:
      "create a Counter component at projects/web/src/Counter.tsx with a button that increments a number, and render it inside projects/web/src/App.tsx",
    async verify(root) {
      const counter = await read(root, "projects/web/src/Counter.tsx");
      const app = await read(root, "projects/web/src/App.tsx");
      return Boolean(counter && /useState/.test(counter) && app && /<Counter\s*\/?>/.test(app));
    },
  },
  {
    id: "T7",
    label: "snapshot-aware documentation",
    input: "add a README.md at the workspace root describing the project structure",
    async verify(root) {
      const body = await read(root, "README.md");
      return Boolean(body && /projects\/web/.test(body));
    },
  },
  {
    id: "T8",
    label: "coordinated rename across two files",
    input: 'rename the CSS class "app" to "studio" in projects/web/src/styles.css and update projects/web/src/App.tsx to match',
    async verify(root) {
      const css = await read(root, "projects/web/src/styles.css");
      const app = await read(root, "projects/web/src/App.tsx");
      return Boolean(css && /\.studio\b/.test(css) && !/\.app\b/.test(css) && app && /className="studio"/.test(app));
    },
  },
  {
    id: "T9",
    label: "install a package then use it",
    input: "install the nanoid package into projects/web and use it to generate an id in projects/web/src/App.tsx",
    async verify(root, run) {
      const installed = run.toolCalls.some((c) => c.tool === "run_command" && /nanoid/.test(String(c.input.command)));
      const app = await read(root, "projects/web/src/App.tsx");
      return installed && Boolean(app && /nanoid/.test(app));
    },
  },
  {
    id: "T10",
    label: "diagnose and fix a broken file",
    input: "projects/web/src/broken.ts has a syntax error. Find it and fix it.",
    seed: {
      "projects/web/src/broken.ts": `export function total(values: number[]) {
  let sum = 0;
  for (const value of values) {
    sum += value;
  return sum;
}
`,
    },
    async verify(root) {
      const body = await read(root, "projects/web/src/broken.ts");
      if (!body) return false;
      // The missing closing brace on the for-loop is the defect. Braces balance
      // once it is fixed, and the function must still return the sum.
      const opens = (body.match(/\{/g) || []).length;
      const closes = (body.match(/\}/g) || []).length;
      return opens === closes && /return sum/.test(body);
    },
  },
  {
    id: "T11",
    label: "scaffold a new app and start its dev server",
    input: "create a minimal Vite React landing page at projects/landing and start its dev server",
    async verify(root, run) {
      const hasEntry = (await exists(root, "projects/landing/src/main.tsx")) || (await exists(root, "projects/landing/src/main.jsx"));
      const hasApp = (await exists(root, "projects/landing/src/App.tsx")) || (await exists(root, "projects/landing/src/App.jsx"));
      const started = run.toolCalls.some((c) => c.tool === "run_command" && /\bdev\b|\bstart\b|vite/.test(String(c.input.command)));
      return hasEntry && hasApp && started;
    },
  },
];
