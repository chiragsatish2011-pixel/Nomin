// Approval used to fire on every plan that contained write_file or run_command
// — which is every plan that does anything. A confirmation shown every time is
// not a safety mechanism, it is a keystroke, and it gets clicked unread.
//
// These tests pin the two halves of the new rule: ordinary building runs
// without interruption, and the genuinely unrecoverable still stops.

import { describe, it, expect } from "vitest";
import { approvalProfile, planNeedsApproval, LARGE_CHANGE_WRITE_COUNT } from "../approval";
import type { PlanDoc } from "../types";

function plan(...steps: Array<[string, PlanDoc["steps"][number]["tool"]]>): PlanDoc {
  return {
    plan_summary: "test plan",
    steps: steps.map(([description, tool], index) => ({ step_id: index + 1, description, tool })),
  };
}

describe("ordinary work runs without asking", () => {
  const ROUTINE: Array<[string, PlanDoc["steps"][number]["tool"]][]> = [
    [["Change the button colour to blue in projects/web/src/App.tsx", "write_file"]],
    [["Install the date-fns package", "run_command"]],
    [["Run the test suite", "run_command"]],
    [["Check the page layout", "read_file"]],
    [["Add a README with install steps", "write_file"]],
  ];

  for (const steps of ROUTINE) {
    it(`does not gate: "${steps[0][0]}"`, () => {
      expect(planNeedsApproval(plan(...steps)).required).toBe(false);
    });
  }

  it("executes a write followed by a contained command", () => {
    expect(planNeedsApproval(plan(
      ["Fix the failing assertion in utils.test.ts", "write_file"],
      ["Run the tests", "run_command"],
    )).required).toBe(false);
  });

  it("does not gate a plan with no steps at all", () => {
    expect(planNeedsApproval(null).required).toBe(false);
  });
});

describe("unrecoverable or outbound work still stops", () => {
  const GATED: Array<[string, [string, PlanDoc["steps"][number]["tool"]][]]> = [
    ["deleting files", [["Delete the unused components in projects/web/src", "run_command"]]],
    ["removing a directory", [["Remove the old build output directory", "run_command"]]],
    ["resetting the workspace", [["Reset the project to a clean state", "run_command"]]],
    ["deploying", [["Deploy the site to production", "run_command"]]],
    ["publishing", [["Publish the package to npm", "run_command"]]],
    ["pushing to a remote", [["Commit and git push to origin", "run_command"]]],
    ["elevated permissions", [["Install the CLI globally with npm i -g", "run_command"]]],
  ];

  for (const [label, steps] of GATED) {
    it(`gates ${label}`, () => {
      const decision = planNeedsApproval(plan(...steps));
      expect(decision.required).toBe(true);
      expect(decision.reason.length).toBeGreaterThan(10);
    });
  }

  it("gates a destructive step even when it is buried mid-plan", () => {
    const decision = planNeedsApproval(
      plan(
        ["Create a config file", "write_file"],
        ["Remove the legacy src directory", "run_command"],
        ["Start the dev server", "run_command"]
      )
    );
    expect(decision.required).toBe(true);
  });
});

describe("large changes are previewed", () => {
  it(`gates once a plan writes ${LARGE_CHANGE_WRITE_COUNT} files`, () => {
    const steps = Array.from(
      { length: LARGE_CHANGE_WRITE_COUNT },
      (_, i) => [`Create component ${i} in projects/web/src/C${i}.tsx`, "write_file"] as [string, PlanDoc["steps"][number]["tool"]]
    );
    const decision = planNeedsApproval(plan(...steps));
    expect(decision.required).toBe(true);
    expect(decision.reason).toContain(String(LARGE_CHANGE_WRITE_COUNT));
  });

  it(`does not gate one file below the threshold`, () => {
    const steps = Array.from(
      { length: LARGE_CHANGE_WRITE_COUNT - 1 },
      (_, i) => [`Create component ${i} in projects/web/src/C${i}.tsx`, "write_file"] as [string, PlanDoc["steps"][number]["tool"]]
    );
    expect(planNeedsApproval(plan(...steps)).required).toBe(false);
  });
});

describe("the reason is written for the user, not for us", () => {
  it("never names a tool", () => {
    const decision = planNeedsApproval(plan(["Delete the old assets folder", "run_command"]));
    expect(decision.reason).not.toContain("run_command");
    expect(decision.reason).not.toContain("write_file");
  });
});

describe("risk profiles", () => {
  const reversibleBuild = plan(
    ["Add a counter component", "write_file"],
    ["Run the test suite", "run_command"]
  );

  it("keeps balanced as the safe default without blocking contained builds", () => {
    expect(approvalProfile(undefined)).toBe("balanced");
    expect(planNeedsApproval(reversibleBuild, "balanced").required).toBe(false);
  });

  it("allows contained reversible work in permissive mode but never hard-risk work", () => {
    expect(planNeedsApproval(reversibleBuild, "permissive").required).toBe(false);
    expect(planNeedsApproval(plan(["Deploy the site", "run_command"]), "permissive").required).toBe(true);
  });

  it("requires review for writes and commands in strict mode, but not reads", () => {
    expect(planNeedsApproval(plan(["Read the app entry", "read_file"]), "strict").required).toBe(false);
    expect(planNeedsApproval(plan(["Update the app entry", "write_file"]), "strict").required).toBe(true);
    expect(planNeedsApproval(plan(["Run the test suite", "run_command"]), "strict").required).toBe(true);
  });
});
