import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ completeText: vi.fn(), complete: vi.fn() }));
vi.mock("../model-gateway", () => ({ modelGateway: { completeText: mocks.completeText, complete: mocks.complete } }));

import {
  ROLE_TOOL_ACCESS,
  reviewCodingCompletion,
  runCodingCritic,
  runDesignCritic,
  proposeDesignRevision,
  shouldRunCodingReview,
  shouldRunDesignReview,
} from "../quality-chain";
import { CODING_CRITIC_SYSTEM_PROMPT, DESIGN_CRITIC_SYSTEM_PROMPT } from "../static-prompts";

const input = {
  session_id: "quality-test", workspace_path: "workspace", mode: "execute" as const, model: "trion-1.4" as const,
  user_message: "Build a distinctive marketing website", conversation_history: [], attached_context: [],
  workspace_snapshot: { file_tree: [], open_files: [] },
};
const plan = {
  plan_summary: "Build the site",
  steps: [
    { step_id: 1, description: "Write src/Hero.tsx", tool: "write_file" },
    { step_id: 2, description: "Write src/App.tsx", tool: "write_file" },
    { step_id: 3, description: "Run npm run build", tool: "run_command" },
  ],
};
const trace = [
  { step_id: 1, tool_name: "write_file", input: { path: "src/Hero.tsx", content: "export const Hero = () => <h1>Hi</h1>" }, output: "ok", status: "success" as const, attempt: 1 },
  { step_id: 2, tool_name: "write_file", input: { path: "src/App.tsx", content: "export default function App(){ return <main /> }" }, output: "ok", status: "success" as const, attempt: 1 },
  { step_id: 3, tool_name: "run_command", input: { command: "npm run build" }, output: "built", status: "success" as const, attempt: 1 },
];
const verified = { required: true, status: "passed" as const, command: "npm run build", message: "Verified by running `npm run build`." };

describe("three-role quality chain", () => {
  it("structurally gives the critic no mutating capability", () => {
    expect(ROLE_TOOL_ACCESS.critic).not.toContain("write_file");
    expect(ROLE_TOOL_ACCESS.critic).not.toContain("run_command");
    expect(CODING_CRITIC_SYSTEM_PROMPT).not.toContain('"action"');
    expect(DESIGN_CRITIC_SYSTEM_PROMPT).not.toContain('"action"');
  });

  it("never activates for chat, one-file edits, or unchecked runs", () => {
    expect(shouldRunCodingReview(input, plan, trace, verified)).toBe(true);
    expect(shouldRunCodingReview({ ...input, mode: "plan" }, plan, trace, verified)).toBe(false);
    expect(shouldRunCodingReview(input, { ...plan, steps: plan.steps.slice(0, 1) }, trace.slice(0, 1), verified)).toBe(false);
    expect(shouldRunCodingReview(input, plan, trace, { ...verified, status: "not_run" })).toBe(false);
  });

  it("catches a real unverified success claim from trace evidence", async () => {
    mocks.completeText.mockRejectedValueOnce(new Error("review service unavailable"));
    const critic = await runCodingCritic({
      input,
      plan,
      trace: trace.slice(0, 2),
      verification: { required: true, status: "not_run", message: "No post-change build ran." },
      proposed: { message: "The website is complete and works." },
    });
    expect(critic.verdict).toBe("qualify");
    expect(critic.findings.join(" ")).toMatch(/without successful post-change verification/i);
  });

  it("runs proposer → critic → synthesizer sequentially for a verified coding completion", async () => {
    mocks.completeText.mockReset();
    mocks.completeText
      .mockResolvedValueOnce('{"verdict":"pass","findings":[],"corrected_claim":"Evidence supports the completion."}')
      .mockResolvedValueOnce('{"message":"The verified site is ready.","next_action_hint":null}');
    const result = await reviewCodingCompletion({ input, plan, trace, verification: verified, proposed: { message: "The site is ready." } });
    expect(result.result.message).toBe("The verified site is ready.");
    expect(mocks.completeText).toHaveBeenCalledTimes(2);
    expect(mocks.completeText.mock.calls[0][1].callType).toBe("coding_critic");
    expect(mocks.completeText.mock.calls[1][1].callType).toBe("coding_synthesizer");
  });

  it("flags a generic UI pattern and confirms the targeted re-check after revision", async () => {
    const previous = process.env.TRION_DESIGN_REVIEW;
    process.env.TRION_DESIGN_REVIEW = "1";
    mocks.completeText.mockReset();
    mocks.completeText
      .mockResolvedValueOnce('{"verdict":"revise","violations":["The main visual idea is a generic purple gradient."],"revision_brief":"Replace the gradient with the product palette and intentional layout."}')
      .mockResolvedValueOnce('{"verdict":"pass","violations":[],"revision_brief":""}');
    expect(shouldRunDesignReview(input, plan, trace)).toBe(true);
    const first = await runDesignCritic({ input, plan, trace, sourcePath: "src/App.tsx", source: "<main className=\"purple-gradient\">AI SaaS</main>" });
    const second = await runDesignCritic({ input, plan, trace, sourcePath: "src/App.tsx", source: "<main className=\"nomin-layout\">A field guide</main>", previousViolations: first.violations, recheck: true });
    expect(first).toMatchObject({ verdict: "revise", violations: [expect.stringMatching(/purple gradient/i)] });
    expect(second).toMatchObject({ verdict: "pass", violations: [] });
    expect(mocks.completeText.mock.calls[0][1].callType).toBe("design_critic");
    expect(mocks.completeText.mock.calls[1][1].callType).toBe("design_recheck");
    if (previous === undefined) delete process.env.TRION_DESIGN_REVIEW;
    else process.env.TRION_DESIGN_REVIEW = previous;
  });

  it("never converts a failed UI re-check into a false pass", async () => {
    mocks.completeText.mockReset();
    mocks.completeText.mockRejectedValueOnce(new Error("temporary reviewer failure"));
    const result = await runDesignCritic({
      input, plan, trace, sourcePath: "src/App.tsx", source: "<main />",
      previousViolations: ["Generic purple gradient."], recheck: true,
    });
    expect(result).toMatchObject({ verdict: "revise", violations: [expect.stringMatching(/could not be re-checked/i)] });
  });

  it("rejects a design revision that changes a React source file into standalone HTML", async () => {
    mocks.complete.mockResolvedValueOnce({
      thought: "Rewrite the page.", action: "write_file", done: false,
      action_input: { path: "src/App.tsx", content: "<!doctype html><html><body>Wrong format</body></html>" },
    });
    const revision = await proposeDesignRevision({
      input, sourcePath: "src/App.tsx", source: "export default function App(){ return <main /> }",
      review: { verdict: "revise", violations: ["Generic gradient."], revision_brief: "Use a specific layout." },
    });
    expect(revision).toBeNull();
  });
});
