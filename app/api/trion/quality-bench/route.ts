// Local-only real-provider measurement for the selective review chains.
//
// This route is intentionally absent unless TRION_BENCH=1. It supplies a
// bounded synthetic trace, does not contact the browser bridge, and never
// exposes keys. The normal /api/trion/chat route is the product path.

import { NextResponse } from "next/server";
import { reviewCodingCompletion, runDesignCritic, proposeDesignRevision } from "@/lib/agent/quality-chain";
import { withLedgerSession, totalsFor } from "@/lib/agent/token-ledger";

export const runtime = "nodejs";

type BenchSnapshot = { sessionId: string; result: Record<string, unknown>; totals: ReturnType<typeof totalsFor> };
const benchStore = globalThis as typeof globalThis & { __trionLastQualityBench?: BenchSnapshot };

function enabled() {
  return process.env.TRION_BENCH === "1";
}

const input = {
  session_id: "quality-bench",
  workspace_path: "workspace",
  mode: "execute" as const,
  model: "trion-1.4" as const,
  user_message: "Build a distinctive responsive marketing website for a design studio",
  conversation_history: [],
  attached_context: [],
  workspace_snapshot: { file_tree: ["projects/web/index.html", "projects/web/src/styles.css"], open_files: [] },
};

const plan = {
  plan_summary: "Build and verify the website",
  steps: [
    { step_id: 1, description: "Write projects/web/index.html", tool: "write_file" },
    { step_id: 2, description: "Write projects/web/src/styles.css", tool: "write_file" },
    { step_id: 3, description: "Run npm run build", tool: "run_command" },
  ],
};

const appSource = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Next-generation AI</title><style>.purple-gradient{min-height:100vh;background:linear-gradient(135deg,#6d28d9,#2563eb);color:#fff}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:24px}</style></head>
<body><main class="purple-gradient"><section><h1>Next-generation AI</h1><p>Build faster with our platform.</p></section><section class="cards"><article>Fast</article><article>Smart</article><article>Simple</article></section></main></body></html>`;
const cssSource = `.purple-gradient { min-height: 100vh; background: linear-gradient(135deg, #6d28d9, #2563eb); color: white; } .cards { display:grid; grid-template-columns:repeat(3,1fr); gap:24px; }`;
const trace = [
  { step_id: 1, tool_name: "write_file", input: { path: "projects/web/index.html", content: appSource }, output: "written", status: "success" as const, attempt: 1 },
  { step_id: 2, tool_name: "write_file", input: { path: "projects/web/src/styles.css", content: cssSource }, output: "written", status: "success" as const, attempt: 1 },
  { step_id: 3, tool_name: "run_command", input: { command: "npm run build" }, output: "build completed", status: "success" as const, attempt: 1 },
];
const verification = { required: true, status: "passed" as const, command: "npm run build", message: "Verified by running `npm run build`." };

export async function POST() {
  if (!enabled()) return new NextResponse("Not found", { status: 404 });
  const sessionId = `quality-bench-${Date.now()}`;
  const result = await withLedgerSession(sessionId, async () => {
    const coding = await reviewCodingCompletion({ input: { ...input, session_id: sessionId }, plan, trace, verification, proposed: { message: "The website is complete and working." } });
    const initialDesign = await runDesignCritic({ input: { ...input, session_id: sessionId }, plan, trace, sourcePath: "projects/web/index.html", source: appSource });
    let revisionMade = false;
    let recheckVerdict: string | null = null;
    let recheckViolations: string[] = [];
    let revisionExcerpt = "";
    if (initialDesign.verdict === "revise" && initialDesign.violations.length) {
      const revision = await proposeDesignRevision({ input: { ...input, session_id: sessionId }, sourcePath: "projects/web/index.html", source: appSource, review: initialDesign });
      const content = revision?.action === "write_file" && revision.action_input.path === "projects/web/index.html" && typeof revision.action_input.content === "string"
        ? revision.action_input.content
        : null;
      if (content) {
        revisionMade = true;
        revisionExcerpt = content.slice(0, 1200);
        const recheck = await runDesignCritic({
          input: { ...input, session_id: sessionId }, plan, trace,
          sourcePath: "projects/web/index.html", source: content,
          previousViolations: initialDesign.violations, recheck: true,
        });
        recheckVerdict = recheck.verdict;
        recheckViolations = recheck.violations;
      }
    }
    return {
      codingVerdict: coding.critic.verdict,
      codingFindings: coding.critic.findings.length,
      designVerdict: initialDesign.verdict,
      designViolations: initialDesign.violations.length,
      designViolationDetails: initialDesign.violations,
      revisionMade,
      revisionExcerpt,
      recheckVerdict,
      recheckViolations,
    };
  });
  const totals = totalsFor(sessionId);
  benchStore.__trionLastQualityBench = { sessionId, result, totals };
  return NextResponse.json({ sessionId, result, totals });
}

export async function GET() {
  if (!enabled()) return new NextResponse("Not found", { status: 404 });
  return benchStore.__trionLastQualityBench
    ? NextResponse.json(benchStore.__trionLastQualityBench)
    : NextResponse.json({ error: "No quality benchmark has run in this process." }, { status: 404 });
}
