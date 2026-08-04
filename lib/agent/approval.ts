// When to stop and ask the human.
//
// WHY THIS REPLACED A TOOL LIST
//
// The rule used to be "any plan containing write_file or run_command needs
// approval". Since essentially every real task contains one of those, the gate
// fired on essentially every task — including "change the button colour to
// blue". A confirmation that appears every single time is not a safety
// mechanism; it is a keystroke, and users learn to hit Approve without reading.
// The one time it mattered, it had already been trained into muscle memory.
//
// So the question is not "does this touch the workspace" — everything does —
// but "could this do something the user would not want undone for them".
//
// Three facts about THIS environment shape the answer:
//   1. Execution happens in a WebContainer that is discarded on New thread. It
//      is not the user's machine and nothing here escapes it.
//   2. Writing a file is reversible, and the user now watches it happen live in
//      the work panel, so a surprising write is visible as it lands rather than
//      needing to be pre-authorised.
//   3. What is NOT cheaply reversible is destroying work, or reaching outside
//      the sandbox — publishing, deploying, pushing.
//
// Approval is therefore reserved for (3), plus changes large enough that the
// user would reasonably want to see the shape of them first.

import type { PlanDoc } from "./types";

/** Above this many file writes, a plan is a big enough change to preview. */
export const LARGE_CHANGE_WRITE_COUNT = 7;

/** Destroying existing work. The one class of sandbox action that a live view
 *  of the write does not make recoverable. */
const DESTRUCTIVE =
  /\b(?:delete|deletes|deleting|remove|removes|removing|rm\b|erase|wipe|purge|drop|destroy|truncate|clear\s+(?:out|all|the)|reset\s+(?:the\s+)?(?:project|workspace|repo)|uninstall)\b/i;

/** Leaving the sandbox: anything that publishes, transmits, or mutates a remote. */
const OUTBOUND =
  /\b(?:deploy|deploys|deploying|publish|publishes|publishing|release\s+to|push\s+to|git\s+push|upload|uploads|uploading|npm\s+publish|send\s+(?:an?\s+)?(?:email|request|webhook))\b/i;

/** Escaping the workspace on the host side. Should be impossible here, but a
 *  plan that proposes it is exactly the plan a human should see first. */
const PRIVILEGED = /\b(?:sudo|chmod|chown|install\s+(?:-g|--global)|npm\s+i\s+-g)\b/i;

export type ApprovalDecision = {
  required: boolean;
  /** Why, in the user's terms. Empty when no approval is needed. */
  reason: string;
};

/**
 * Consent is a product policy, not a model preference. Deployments can select
 * it with TRION_APPROVAL_PROFILE; callers may also pass it explicitly in tests
 * or future workspace settings. Unknown values deliberately fall back to the
 * balanced default rather than quietly making the agent less restrictive.
 */
export type ApprovalProfile = "permissive" | "balanced" | "strict";

export function approvalProfile(value = process.env.TRION_APPROVAL_PROFILE): ApprovalProfile {
  return value === "permissive" || value === "strict" ? value : "balanced";
}

/**
 * Decide whether this plan pauses for a human.
 *
 * Reads the step DESCRIPTIONS, because at approval time that is genuinely all
 * there is — a plan step carries no tool input (see "THE PLAN IS NOT THE CODE"
 * in the plan prompt), so the concrete command does not exist yet. Description
 * matching is therefore the best available signal, and it is deliberately
 * biased toward asking: a false positive costs one click, a false negative
 * deletes someone's work.
 */
export function planNeedsApproval(plan: PlanDoc | null, profile = approvalProfile()): ApprovalDecision {
  if (!plan || plan.steps.length === 0) return { required: false, reason: "" };

  for (const step of plan.steps) {
    const text = step.description ?? "";

    if (DESTRUCTIVE.test(text)) {
      return { required: true, reason: "This removes files or resets work that cannot be recovered afterwards." };
    }
    if (OUTBOUND.test(text)) {
      return { required: true, reason: "This sends something outside the sandbox, so it affects more than this workspace." };
    }
    if (PRIVILEGED.test(text)) {
      return { required: true, reason: "This asks for elevated or system-wide changes." };
    }
  }

  // Strict mode is for teams that want human consent before any state change.
  // Reads/searches are still safe to run autonomously; asking about those
  // would turn a review policy into an unusable prompt factory.
  if (profile === "strict" && plan.steps.some((step) => step.tool && step.tool !== "read_file" && step.tool !== "search_codebase" && step.tool !== "web_fetch")) {
    return {
      required: true,
      reason: "This plan changes the workspace or runs a command, so it is waiting for your review first.",
    };
  }

  // Permissive mode retains hard safety boundaries above, but does not pause
  // for contained, reversible work. It is suitable only for a disposable
  // sandbox where the user deliberately prefers flow over review.
  if (profile === "permissive") return { required: false, reason: "" };

  const writes = plan.steps.filter((step) => step.tool === "write_file").length;
  if (writes >= LARGE_CHANGE_WRITE_COUNT) {
    return {
      required: true,
      reason: `This writes ${writes} files, so it is worth a look before it runs.`,
    };
  }

  // Everything else — creating and editing files, installing a dependency,
  // running a build, starting the dev server — proceeds. It is reversible, it
  // is contained, and the user is watching it happen.
  return { required: false, reason: "" };
}
