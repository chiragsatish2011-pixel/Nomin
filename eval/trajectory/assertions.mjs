// Trajectory-Level Test Scaffolding — tool_trace/decision path assertions
// Captures and asserts against the actual plan, reasoning steps, tool calls, retries, decision points.

import { runTurn, resetUsage } from "../../bench/driver.mjs";

const SOURCE_PATH = /(?:[\w.-]+\/)+[\w.-]+\.(?:[cm]?[jt]sx?|css|html?|json|md|py|go|rs)/g;

function traceFor(run) {
  return run.result?.tool_trace ?? [];
}

function allowedTool(planned, actual) {
  if (!planned || !actual || actual === "finish") return true;
  if (planned === actual) return true;
  const inspection = new Set(["read_file", "search_codebase"]);
  return inspection.has(planned) && inspection.has(actual);
}

// Trajectory assertions — each is a check on the execution path
export const TRAJECTORY_ASSERTIONS = [
  {
    id: "traj-1",
    name: "No Premature Finish",
    description: "Agent must not emit finish/done:true while approved plan steps have no trace entry",
    check: (run, plan) => {
      const trace = traceFor(run);
      const unfinished = plan?.steps?.filter((step) =>
        !trace.some((entry) => entry.step_id === step.step_id && entry.status === "success")
      ) ?? [];
      
      const reportedDone = run.result?.status === "done";
      const prematureFinishes = reportedDone && unfinished.length > 0 ? 1 : 0;
      
      return {
        passed: prematureFinishes === 0,
        details: {
          unfinishedSteps: unfinished.map((s) => s.step_id),
          prematureFinishes: prematureFinishes.length,
        },
      };
    },
  },
  {
    id: "traj-2",
    name: "First-Attempt Tool Accuracy",
    description: "Tool calls should succeed on first attempt; retries indicate decision errors",
    check: (run) => {
      const trace = traceFor(run);
      const byStep = new Map();
      for (const entry of trace) {
        const rows = byStep.get(entry.step_id) ?? [];
        rows.push(entry);
        byStep.set(entry.step_id, rows);
      }
      
      let steps = 0, firstAttemptOk = 0, malformed = 0, ranAndErrored = 0;
      for (const rows of byStep.values()) {
        steps += 1;
        const minAttempt = Math.min(...rows.map((r) => r.attempt));
        if (minAttempt > 1) { malformed += minAttempt - 1; continue; }
        const first = rows.find((r) => r.attempt === 1);
        if (first?.status === "success") firstAttemptOk += 1;
        else ranAndErrored += 1;
      }
      
      const rate = steps > 0 ? firstAttemptOk / steps : 1;
      return {
        passed: rate >= 0.7, // Threshold: 70% first-attempt success
        details: { steps, firstAttemptOk, malformed, ranAndErrored, rate: Math.round(rate * 100) },
      };
    },
  },
  {
    id: "traj-3",
    name: "Coherence — No Unsupported Completion",
    description: "A completed output must not leave an error or pending plan step behind",
    check: (run) => {
      const plan = run.result?.plan;
      const incomplete = (plan?.steps ?? []).filter((step) => step.state === "pending" || step.state === "running" || step.state === "error");
      const successClaim = run.result?.status === "done";
      
      return {
        passed: !successClaim || incomplete.length === 0,
        details: { successClaim, incompleteSteps: incomplete.map((step) => ({ id: step.step_id, state: step.state })) },
      };
    },
  },
  {
    id: "traj-4",
    name: "Coherence — Summary File Claims Have Evidence",
    description: "Any source path named in the final summary must appear in a successful read or write trace entry",
    check: (run) => {
      const trace = traceFor(run);
      const evidenced = new Set(trace.filter((entry) => entry.status === "success")
        .map((entry) => typeof entry.input?.path === "string" ? entry.input.path : "").filter(Boolean));
      const mentioned = [...String(run.result?.message ?? "").matchAll(SOURCE_PATH)].map((match) => match[0]);
      const violations = mentioned.filter((path) => !evidenced.has(path));
      
      return {
        passed: violations.length === 0,
        details: { mentioned, violations, evidenced: [...evidenced] },
      };
    },
  },
  {
    id: "traj-5",
    name: "Action Contract Adherence",
    description: "Model's chosen action must match the approved plan step's tool",
    check: (run, plan) => {
      const trace = traceFor(run);
      let violations = 0;
      
      for (const entry of trace) {
        if (entry.tool_name === "model_decision") continue;
        const stepId = entry.step_id;
        const planStep = plan?.steps?.find((s) => s.step_id === stepId);
        const plannedTool = planStep?.tool;
        const actualAction = entry.tool_name;
        
        if (!allowedTool(plannedTool, actualAction)) violations++;
      }
      
      return {
        passed: violations === 0,
        details: { violations },
      };
    },
  },
  {
    id: "traj-6",
    name: "Retry Pattern Analysis",
    description: "Retries should be for genuine tool failures, not decision loops",
    check: (run) => {
      const trace = traceFor(run);
      const retries = trace.filter((t) => t.attempt > 1);
      
      const retryReasons = retries.map((t) => {
        if (t.tool_name === "model_decision") return "decision_retry";
        if (t.status === "error") return "tool_error";
        return "unknown";
      });
      
      const decisionRetries = retryReasons.filter((r) => r === "decision_retry").length;
      const toolErrorRetries = retryReasons.filter((r) => r === "tool_error").length;
      
      return {
        // A retry must be preceded by a real error on that same step. This
        // catches pointless repeat calls without assuming successful model
        // decisions are emitted into the public trace.
        passed: retries.every((retry) => trace.some((prior) => prior.step_id === retry.step_id && prior.attempt < retry.attempt && prior.status === "error")),
        details: {
          totalRetries: retries.length,
          decisionRetries,
          toolErrorRetries,
          retryBreakdown: retryReasons.reduce((acc, r) => { acc[r] = (acc[r] || 0) + 1; return acc; }, {}),
        },
      };
    },
  },
  {
    id: "traj-7",
    name: "Plan Completeness",
    description: "All planned steps should either execute or be explicitly cancelled",
    check: (run, plan) => {
      const trace = traceFor(run);
      const planSteps = run.result?.plan?.steps ?? plan?.steps ?? [];
      const executedStepIds = new Set(trace.filter((entry) => entry.status === "success").map((t) => t.step_id));
      const unexecuted = planSteps.filter((s) => !executedStepIds.has(s.step_id));
      const explicitlyCancelled = unexecuted.filter((s) => s.state === "cancelled").length;
      const finishedEarly = explicitlyCancelled > 0;
      
      return {
        passed: unexecuted.length === 0 || (finishedEarly && explicitlyCancelled === unexecuted.length),
        details: {
          planned: planSteps.length,
          executed: executedStepIds.size,
          unexecuted: unexecuted.map((s) => s.step_id),
          finishedEarly,
          explicitlyCancelled,
        },
      };
    },
  },
  {
    id: "traj-8",
    name: "Verification Honesty in Trace",
    description: "Verification steps (build/test/lint) must actually run and their results must be reflected in final status",
    check: (run) => {
      const trace = traceFor(run);
      const verificationCommands = trace.filter((t) =>
        t.tool_name === "run_command" &&
        /\b(build|test|lint|typecheck|tsc)\b/i.test(String(t.input.command))
      );
      
      const hasVerification = verificationCommands.length > 0;
      const allVerificationsPassed = verificationCommands.every((v) => v.status === "success");
      const finalStatus = run.result?.status;
      
      // If verifications ran but failed, final status should not be "done"
      const honest = !hasVerification || allVerificationsPassed || finalStatus !== "done";
      
      return {
        passed: honest,
        details: {
          verificationCommands: verificationCommands.length,
          allPassed: allVerificationsPassed,
          finalStatus,
          commands: verificationCommands.map((v) => ({ command: v.input.command, status: v.status })),
        },
      };
    },
  },
];

export async function runTrajectoryAnalysis(tag, cases = ["T1", "T2", "T3", "T4", "T5", "T6"]) {
  const { CODING_SUITE } = await import("../../bench/suites.mjs");
  const filteredSuite = CODING_SUITE.filter((c) => cases.includes(c.id));
  const results = [];
  
  for (const testCase of filteredSuite) {
    const sessionId = `eval-traj-${testCase.id}-${Date.now()}`;
    await resetUsage(sessionId);
    
    const os = await import("node:os");
    const path = await import("node:path");
    const { seedWorkspace } = await import("../../bench/workspace.mjs");
    const root = path.join(os.tmpdir(), "trion-traj", `${tag}-${testCase.id}`);
    await seedWorkspace(root, testCase.seed ?? {});
    
    const run = await runTurn({ sessionId, userText: testCase.input, mode: "execute", root });
    
    const assertionResults = [];
    for (const assertion of TRAJECTORY_ASSERTIONS) {
      const result = assertion.check(run, run.plan);
      assertionResults.push({
        assertionId: assertion.id,
        name: assertion.name,
        passed: result.passed,
        details: result.details,
      });
    }
    
    const passed = assertionResults.filter((r) => r.passed).length;
    const total = assertionResults.length;
    
    results.push({
      caseId: testCase.id,
      label: testCase.label,
      assertions: assertionResults,
      passed,
      total,
      passRate: Math.round((passed / total) * 100),
      traceLength: run.result?.tool_trace?.length ?? 0,
      planSteps: run.plan?.steps.length ?? 0,
    });
    
    console.log(`  ${testCase.id}: ${passed}/${total} (${Math.round((passed/total)*100)}%)`);
    for (const a of assertionResults) {
      if (!a.passed) console.log(`    ✗ ${a.name}:`, JSON.stringify(a.details).slice(0, 200));
    }
  }
  
  return results;
}
