// The plan's step descriptions are user-facing product copy. They must never
// describe the sandbox as something that already existed before the request —
// that tells the user they are looking at a pre-built scaffold rather than at
// their own project being built.
//
// The plan prompt forbids this, and the model mostly complies. "Mostly" is the
// problem: the exact banned sentence came back on a later run of the same
// request the prompt had already fixed once. These tests cover the
// deterministic pass that runs over every description regardless.

import { describe, it, expect } from "vitest";
import { deScaffold, explicitFileConstraint, parsePlanDoc } from "../planner/generator";

describe("scaffold language is stripped from plan descriptions", () => {
  it("rewrites the exact phrasing observed in production", () => {
    const out = deScaffold("Read the existing web app structure to understand the project layout");
    expect(out.toLowerCase()).not.toContain("existing");
    expect(out.toLowerCase()).not.toContain("to understand");
    expect(out.length).toBeGreaterThan(7);
  });

  const LEAKS = [
    "Read the existing web app structure to understand the project layout",
    "Inspect the current project structure",
    "Review the boilerplate before making changes",
    "Examine the scaffold to get a sense of the codebase",
    "Read the existing application files to familiarize myself with the setup",
    "Survey the starter template",
    "Check the current codebase organization to determine where to add the component",
    "Read the project structure to identify the entry point",
  ];

  for (const leak of LEAKS) {
    it(`never leaks pre-existing-workspace language for: "${leak}"`, () => {
      const out = deScaffold(leak).toLowerCase();
      for (const banned of [
        "existing",
        "boilerplate",
        "scaffold",
        "starter",
        "pre-configured",
        "familiarize",
        "familiarise",
        "to understand",
        "get a sense",
      ]) {
        expect(out).not.toContain(banned);
      }
      // Never degrades into a stub.
      expect(out.trim().length).toBeGreaterThan(7);
    });
  }
});

describe("explicit file scope", () => {
  it("makes one React component plus one CSS file a strict two-write contract", () => {
    const constraint = explicitFileConstraint("Use exactly one React component file and one CSS file.");
    expect(constraint).toMatch(/exactly 2 files/i);
    expect(constraint).toMatch(/exactly 2 write_file steps/i);
    expect(constraint).toMatch(/must not add integration/i);
  });
});

describe("descriptions that never mentioned the scaffold are untouched", () => {
  const CLEAN = [
    "Create Hero component with headline and call to action",
    "Update App.tsx to compose the landing page sections",
    "Start the dev server to preview the landing page",
    "Add global styles for the landing page design",
    "Create Pricing component with subscription tiers",
    "Install the date-fns package",
    // "current" in front of a non-workspace noun must survive — the adjective
    // is only stripped when it is describing the workspace itself.
    "Display the current value of the counter",
    // VERB senses of the scaffold vocabulary. "scaffold the app" is an
    // instruction to build one, not a reference to a pre-built one; an earlier
    // version of this guard rewrote it to "the page the app".
    "scaffold the app",
    "Scaffold a new Vite project under projects/api",
    "Add a template literal for the greeting",
  ];

  for (const text of CLEAN) {
    it(`passes through byte-identical: "${text}"`, () => {
      expect(deScaffold(text)).toBe(text);
    });
  }
});

describe("the guard runs inside plan parsing, not just as a helper", () => {
  it("cleans descriptions coming out of parsePlanDoc", () => {
    const raw = JSON.stringify({
      plan_summary: "Build a landing page",
      steps: [
        { step_id: 1, description: "Read the existing web app structure to understand the project layout", tool: "read_file" },
        { step_id: 2, description: "Create Hero component in projects/web/src/Hero.tsx", tool: "write_file" },
      ],
    });

    const plan = parsePlanDoc(raw);
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0].description.toLowerCase()).not.toContain("existing");
    expect(plan.steps[0].description.toLowerCase()).not.toContain("to understand");
    // The clean step is unaffected.
    expect(plan.steps[1].description).toBe("Create Hero component in projects/web/src/Hero.tsx");
  });

  it("also cleans a summary that fell back to the first step", () => {
    const raw = JSON.stringify({
      steps: [{ step_id: 1, description: "Inspect the current project scaffold", tool: "read_file" }],
    });
    const plan = parsePlanDoc(raw);
    expect(plan.plan_summary.toLowerCase()).not.toContain("scaffold");
  });
});
