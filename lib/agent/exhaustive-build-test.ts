import type { NormalInput, PlanDoc } from "./types";

/**
 * Deliberately opt-in. This is a diagnostic quality mode for judging whether
 * a slower, stage-by-stage design workflow materially improves output. It is
 * never silently enabled for normal users or production traffic.
 */
export function exhaustiveBuildTestEnabled(): boolean {
  // This is a diagnostic, not normal product behaviour. Auto-enabling it in
  // development silently expanded user plans (including requests that said
  // “exactly two files”) and spent extra authoring calls. It must be requested
  // explicitly in every environment.
  return process.env.TRION_EXHAUSTIVE_BUILD_TEST === "1";
}

export function isInterfaceBuildRequest(message: string): boolean {
  return /\b(?:website|web\s*page|landing\s*page|dashboard|ui|interface|frontend|front-end|react\s*(?:app|page|site)|portfolio|marketing\s*site|design\s+(?:a|the|me))\b/i.test(message);
}

const INSPECTION = /\b(?:read|inspect|check|search)\b/i;
const AUTHORING = /\b(?:create|build|implement|write|update|add|compose|wire)\b/i;
const POLISH = /\b(?:polish|refine|responsive|accessib|interaction\s+state|visual\s+hierarchy)\b/i;
const VERIFICATION = /\b(?:build|test|lint|typecheck|type-check|check|validate|start|dev(?:elopment)?\s+server)\b/i;

/**
 * Make the test mode observable and repeatable. It is not another model call:
 * it turns an otherwise vague "make it nice" quality pass into explicit,
 * independently-traced work. The cap protects the plan contract.
 */
export function stageExhaustiveInterfacePlan(plan: PlanDoc, input: NormalInput): PlanDoc {
  if (!isInterfaceBuildRequest(input.user_message)) return plan;

  // Preserve installation and setup commands in their original position. Only
  // a genuine verification/server command belongs at the end of the staged
  // workflow; moving `npm install` after a write that imports the package would
  // create the very failure this mode is meant to reveal.
  const existingCommand = [...plan.steps]
    .reverse()
    .find((step) => step.tool === "run_command" && VERIFICATION.test(step.description));
  const steps = plan.steps.filter((step) => step !== existingCommand);
  const additions: PlanDoc["steps"] = [];
  const needsInspection = input.workspace_snapshot.file_tree.length > 0 && !steps.some((step) => INSPECTION.test(step.description));
  const needsAuthoring = !steps.some((step) => step.tool === "write_file" || AUTHORING.test(step.description));
  const needsPolish = !steps.some((step) => step.tool === "write_file" && POLISH.test(step.description));

  if (needsInspection) additions.push({ step_id: 0, tool: "read_file", description: "Inspect the page entry point before changing the interface" });
  if (needsAuthoring) additions.push({ step_id: 0, tool: "write_file", description: "Implement the requested interface in the appropriate project source file" });
  if (needsPolish) additions.push({ step_id: 0, tool: "write_file", description: "Polish the finished interface for hierarchy, responsive layout, and clear interaction states" });

  const staged = [...additions.slice(0, needsInspection ? 1 : 0), ...steps, ...additions.slice(needsInspection ? 1 : 0)];
  const finalSteps = [...staged, existingCommand ?? {
    step_id: 0,
    tool: "run_command",
    description: "Run the relevant build or development server to verify the finished interface",
  }];

  if (finalSteps.length > 10) {
    throw new Error("The exhaustive interface test needs more than 10 steps. Simplify the requested scope so it can be built, polished, and verified in one traceable run.");
  }

  return {
    plan_summary: plan.plan_summary,
    steps: finalSteps.map((step, index) => ({ ...step, step_id: index + 1 })),
  };
}

/** Fixed user-message suffix for each step. Keeping it small is important: this
 * mode costs no additional requests, only a small test-only per-step context. */
export const EXHAUSTIVE_STEP_DISCIPLINE = `EXHAUSTIVE BUILD TEST: complete only this traced step using the actual workspace result. Do not skip ahead, combine the later polish/check into this step, or finish before every stage has evidence.`;
