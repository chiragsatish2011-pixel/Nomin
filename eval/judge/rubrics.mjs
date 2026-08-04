// LLM-as-Judge Rubrics — structured, explicit criteria as data
// Each rubric is a TypeScript object with explicit scoring criteria.
// Calibration harness validates judge against known-answer cases before grading.

export const CODING_RUBRIC = {
  name: "coding_task",
  version: "1.0",
  description: "Grades coding task outputs: correctness, root-cause accuracy, multi-file completeness, verification honesty",
  maxScore: 100,
  criteria: [
    {
      id: "correctness",
      name: "Correctness (Does it work when run?)",
      weight: 35,
      levels: [
        { score: 100, label: "Fully correct", description: "All verifications pass; code runs without errors; produces expected output" },
        { score: 75, label: "Minor issues", description: "Core functionality works; minor bugs or edge cases not handled" },
        { score: 50, label: "Partial", description: "Major functionality missing or broken; significant errors" },
        { score: 25, label: "Mostly broken", description: "Code has syntax errors, missing imports, or fundamental logic flaws" },
        { score: 0, label: "Non-functional", description: "Code does not run or produces completely wrong output" },
      ],
    },
    {
      id: "root_cause_accuracy",
      name: "Root-Cause Accuracy (Real fix vs. surface patch)",
      weight: 25,
      levels: [
        { score: 100, label: "Precise root cause", description: "Identifies and fixes the actual underlying defect, not symptoms" },
        { score: 75, label: "Correct fix, verbose", description: "Fixes the root cause but includes unnecessary changes" },
        { score: 50, label: "Surface patch", description: "Fixes visible symptom without addressing root cause" },
        { score: 25, label: "Wrong direction", description: "Changes unrelated code; doesn't address the actual problem" },
        { score: 0, label: "No fix attempted", description: "No meaningful change made to address the issue" },
      ],
    },
    {
      id: "multi_file_completeness",
      name: "Multi-File Completeness",
      weight: 20,
      levels: [
        { score: 100, label: "All required files", description: "Every file mentioned in the task is created/updated correctly" },
        { score: 75, label: "Missing 1 file", description: "One required file missing or incomplete" },
        { score: 50, label: "Missing multiple", description: "Several required files missing or incomplete" },
        { score: 25, label: "Only partial", description: "Only a fraction of required files touched" },
        { score: 0, label: "No files changed", description: "No workspace modifications made" },
      ],
    },
    {
      id: "verification_honesty",
      name: "Verification Honesty (Claimed success backed by evidence)",
      weight: 20,
      levels: [
        { score: 100, label: "Fully honest", description: "Claims match trace exactly; failed steps acknowledged; no invented files" },
        { score: 75, label: "Minor overclaim", description: "One minor claim not fully backed by trace" },
        { score: 50, label: "Significant overclaim", description: "Claims files created that don't exist in trace; hides failures" },
        { score: 25, label: "Major fabrication", description: "Describes work that never happened; fake success narrative" },
        { score: 0, label: "Complete fiction", description: "Summary bears no relation to actual trace" },
      ],
    },
  ],
};

export const DESIGN_RUBRIC = {
  name: "design_ui_task",
  version: "1.0",
  description: "Grades UI/design outputs: unmistakably Nomin, follows distinctive-design directive, no banned patterns",
  maxScore: 100,
  criteria: [
    {
      id: "nomin_identity",
      name: "Unmistakably Nomin (Not Generic)",
      weight: 30,
      levels: [
        { score: 100, label: "Strong identity", description: "Distinctive visual language; no template feel; subject-specific copy" },
        { score: 75, label: "Mostly distinctive", description: "Good identity with 1-2 generic elements" },
        { score: 50, label: "Mixed", description: "Some distinctive choices but falls back to generic patterns" },
        { score: 25, label: "Mostly generic", description: "Generic AI-SaaS look; could be any template" },
        { score: 0, label: "Pure template", description: "Default component library look; purple gradient; 3-card grid; lorem ipsum" },
      ],
    },
    {
      id: "design_constraints",
      name: "Follows Distinctive-Design Directive",
      weight: 30,
      levels: [
        { score: 100, label: "All constraints met", description: "1 accent, 4 type sizes, 8px spacing scale, real contrast, 65ch line width, focus states, 360px+ responsive" },
        { score: 75, label: "Minor deviation", description: "1-2 constraints slightly off (e.g., 5 type sizes instead of 4)" },
        { score: 50, label: "Several deviations", description: "Multiple constraints violated; arbitrary spacing/colors" },
        { score: 25, label: "Few constraints met", description: "Only 1-2 design constraints followed" },
        { score: 0, label: "No constraints", description: "Ignores all design directives" },
      ],
    },
    {
      id: "banned_patterns",
      name: "No Banned Generic Patterns",
      weight: 25,
      levels: [
        { score: 100, label: "Zero banned patterns", description: "No purple/blue gradient, no 3-card grid, no generic copy, no decorative emoji, no lorem ipsum" },
        { score: 75, label: "1 minor pattern", description: "One banned pattern present but minor (e.g., one emoji as icon)" },
        { score: 50, label: "Multiple patterns", description: "2-3 banned patterns present" },
        { score: 25, label: "Many patterns", description: "Several banned patterns; clearly template-derived" },
        { score: 0, label: "All patterns", description: "Exhibits all banned patterns" },
      ],
    },
    {
      id: "real_content",
      name: "Real Subject-Specific Content",
      weight: 15,
      levels: [
        { score: 100, label: "Fully real", description: "All copy specific to the task; no placeholder text" },
        { score: 75, label: "Mostly real", description: "1-2 placeholder phrases remain" },
        { score: 50, label: "Mixed", description: "Significant placeholder content" },
        { score: 25, label: "Mostly placeholder", description: "Generic 'Feature One/Two', 'Your text here' dominant" },
        { score: 0, label: "All placeholder", description: "Entirely lorem ipsum or template copy" },
      ],
    },
  ],
};

export const CLASSIFICATION_RUBRIC = {
  name: "conversational_classification",
  version: "1.0",
  description: "Grades intent classification: correct routing, no self-narration, no fake trace/plan for non-task turns",
  maxScore: 100,
  criteria: [
    {
      id: "intent_accuracy",
      name: "Intent Classification Accuracy",
      weight: 40,
      levels: [
        { score: 100, label: "Perfect", description: "Every test case classified correctly (direct_answer/task/needs_clarification)" },
        { score: 80, label: "1 error", description: "One misclassification in calibration set" },
        { score: 60, label: "2 errors", description: "Two misclassifications" },
        { score: 40, label: "3 errors", description: "Three misclassifications" },
        { score: 0, label: "4+ errors", description: "Four or more misclassifications" },
      ],
    },
    {
      id: "no_self_narration",
      name: "No Self-Narration",
      weight: 30,
      levels: [
        { score: 100, label: "None", description: "Zero instances of 'I answered...', 'I explained...', 'Here is what I did...'" },
        { score: 75, label: "1 instance", description: "One self-narration phrase detected" },
        { score: 50, label: "2-3 instances", description: "Multiple self-narration phrases" },
        { score: 25, label: "Frequent", description: "Self-narration in majority of responses" },
        { score: 0, label: "Always", description: "Every response self-narrates" },
      ],
    },
    {
      id: "no_fake_trace",
      name: "No Fake Trace/Plan for Conversational Turns",
      weight: 30,
      levels: [
        { score: 100, label: "Clean", description: "No plan, no tool trace, no approval gate for direct_answer/needs_clarification" },
        { score: 75, label: "Plan only", description: "Plan generated but no execution" },
        { score: 50, label: "Trace only", description: "Tool trace emitted without plan" },
        { score: 25, label: "Full fake", description: "Plan + trace + approval gate for conversational input" },
        { score: 0, label: "Systematic", description: "Every conversational turn gets fake plan/trace" },
      ],
    },
  ],
};

// Calibration cases — known answers with expected scores
export const CALIBRATION_CASES = [
  {
    id: "cal-1",
    taskType: "coding",
    input: 'create a file hello.txt at the workspace root containing the text "Hello World"',
    agentOutput: {
      message: "Created `hello.txt` with content: Hello World",
      tool_trace: [{ step_id: 1, tool_name: "write_file", input: { path: "hello.txt", content: "Hello World" }, status: "success", attempt: 1 }],
      status: "done",
    },
    expectedScores: { correctness: 100, root_cause_accuracy: 100, multi_file_completeness: 100, verification_honesty: 100 },
    expectedTotal: 100,
  },
  {
    id: "cal-2",
    taskType: "coding",
    input: "projects/web/src/broken.ts has a syntax error. Find it and fix it.",
    agentOutput: {
      message: "Fixed syntax error in `projects/web/src/broken.ts` — missing closing brace on for-loop. Verified: braces now balance and function returns sum.",
      tool_trace: [
        { step_id: 1, tool_name: "read_file", input: { path: "projects/web/src/broken.ts" }, status: "success", attempt: 1 },
        { step_id: 2, tool_name: "write_file", input: { path: "projects/web/src/broken.ts", content: "export function total(values: number[]) {\n  let sum = 0;\n  for (const value of values) {\n    sum += value;\n  }\n  return sum;\n}" }, status: "success", attempt: 1 },
      ],
      status: "done",
    },
    expectedScores: { correctness: 100, root_cause_accuracy: 100, multi_file_completeness: 100, verification_honesty: 100 },
    expectedTotal: 100,
  },
  {
    id: "cal-3",
    taskType: "design",
    input: "create a landing page with a hero, features section, and footer",
    agentOutput: {
      message: "Created landing page at `projects/web/src/Landing.tsx` with hero (Nomin-branded headline), 3-column features (real copy), footer. Uses 1 accent (sea-green), 4 type sizes, 8px spacing scale, visible focus states. Responsive from 360px. No gradients, no emoji, no lorem ipsum.",
      tool_trace: [{ step_id: 1, tool_name: "write_file", input: { path: "projects/web/src/Landing.tsx", content: "..." }, status: "success", attempt: 1 }],
      status: "done",
    },
    expectedScores: { nomin_identity: 100, design_constraints: 100, banned_patterns: 100, real_content: 100 },
    expectedTotal: 100,
  },
  {
    id: "cal-4",
    taskType: "classification",
    input: "hi there",
    agentOutput: {
      message: "Hello! 👋",
      status: "done",
      tool_trace: [],
      plan: null,
    },
    expectedScores: { intent_accuracy: 100, no_self_narration: 100, no_fake_trace: 100 },
    expectedTotal: 100,
  },
  {
    id: "cal-5",
    taskType: "classification",
    input: "can you create a file called notes.md?",
    agentOutput: {
      message: "Created `notes.md`",
      tool_trace: [{ step_id: 1, tool_name: "write_file", input: { path: "notes.md", content: "# Notes\n\n" }, status: "success", attempt: 1 }],
      status: "done",
    },
    expectedScores: { intent_accuracy: 100, no_self_narration: 100, no_fake_trace: 100 },
    expectedTotal: 100,
  },
];

export function getRubric(taskType) {
  switch (taskType) {
    case "coding": return CODING_RUBRIC;
    case "design": return DESIGN_RUBRIC;
    case "classification": return CLASSIFICATION_RUBRIC;
    default: throw new Error(`Unknown task type: ${taskType}`);
  }
}

export function scoreWithRubric(rubric, actualScores) {
  let total = 0;
  for (const criterion of rubric.criteria) {
    const score = actualScores[criterion.id] ?? 0;
    total += (score / 100) * criterion.weight;
  }
  return Math.round(total);
}