// Online/Production-Condition Evaluation — concurrent load via key pool
// Simulates real usage: multiple concurrent sessions, session continuation, mixed workloads.

import { runTurn, resetUsage, readUsage } from "../../bench/driver.mjs";
import { SPEED_SUITE, CODING_SUITE } from "../../bench/suites.mjs";

// Concurrent test configuration
export const ONLINE_CONFIG = {
  concurrentSessions: 5,
  turnsPerSession: 3,
  thinkTimeMs: 500, // simulate user think time between turns
  mix: { speed: 0.4, coding: 0.6 }, // 40% conversational, 60% coding
};

export async function runOnlineEvaluation(tag, config = ONLINE_CONFIG) {
  console.log("\n═══════════════════════════════════════");
  console.log("  ONLINE / PRODUCTION-CONDITION EVALUATION");
  console.log("═══════════════════════════════════════");
  console.log(`  Concurrent sessions: ${config.concurrentSessions}`);
  console.log(`  Turns per session: ${config.turnsPerSession}`);
  console.log(`  Mix: ${Math.round(config.mix.speed*100)}% speed / ${Math.round(config.mix.coding*100)}% coding\n`);
  
  const allResults = [];
  const sessionErrors = [];
  
  // Run sessions concurrently
  const sessionPromises = [];
  
  for (let s = 0; s < config.concurrentSessions; s++) {
    const sessionId = `eval-online-${tag}-session-${s}-${Date.now()}`;
    
    sessionPromises.push((async () => {
      const sessionResults = [];
      
      for (let t = 0; t < config.turnsPerSession; t++) {
        // Pick test case based on mix
        const useSpeed = Math.random() < config.mix.speed;
        const suite = useSpeed ? SPEED_SUITE : CODING_SUITE;
        const testCase = suite[Math.floor(Math.random() * suite.length)];
        const mode = useSpeed ? "plan" : "execute";
        
        await resetUsage(sessionId);
        
        let root;
        if (!useSpeed) {
          const os = await import("node:os");
          const path = await import("node:path");
          const { seedWorkspace } = await import("../../bench/workspace.mjs");
          root = path.join(os.tmpdir(), "trion-online", `${sessionId}-turn-${t}`);
          await seedWorkspace(root, testCase.seed ?? {});
        }
        
        const startTime = Date.now();
        const run = await runTurn({ sessionId, userText: testCase.input, mode, root });
        const latency = Date.now() - startTime;
        const usage = await readUsage(sessionId);
        
        let completed = false;
        if (!useSpeed) {
          try { completed = await testCase.verify(root, run); } catch { completed = false; }
        } else {
          const score = (await import("../../bench/suites.mjs")).scoreSpeedCase(testCase, run);
          completed = score.completed;
        }
        
        sessionResults.push({
          turn: t,
          testCase: testCase.id,
          category: testCase.category,
          mode,
          input: testCase.input,
          completed,
          status: run.result?.status,
          latency,
          modelCalls: usage.totals.calls,
          totalTokens: usage.totals.totalTokens,
          costUsd: usage.costUsd,
          error: run.error,
        });
        
        // Think time between turns
        if (t < config.turnsPerSession - 1) {
          await new Promise((r) => setTimeout(r, config.thinkTimeMs));
        }
      }
      
      return { sessionId, results: sessionResults };
    })());
  }
  
  // Wait for all sessions with concurrency limit
  const batchSize = config.concurrentSessions;
  for (let i = 0; i < sessionPromises.length; i += batchSize) {
    const batch = sessionPromises.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(batch);
    
    for (const result of batchResults) {
      if (result.status === "fulfilled") {
        allResults.push(result.value);
      } else {
        sessionErrors.push(result.reason?.message ?? "unknown");
      }
    }
  }
  
  return { allResults, sessionErrors };
}

export function analyzeOnlineResults({ allResults, sessionErrors }) {
  const allTurns = allResults.flatMap((s) => s.results);
  const completedTurns = allTurns.filter((t) => t.completed);
  const speedTurns = allTurns.filter((t) => t.mode === "plan");
  const codingTurns = allTurns.filter((t) => t.mode === "execute");
  
  const sum = (arr, key) => arr.reduce((n, t) => n + (t[key] ?? 0), 0);
  
  return {
    totalSessions: allResults.length,
    totalTurns: allTurns.length,
    completedTurns: completedTurns.length,
    overallSuccessRate: allTurns.length ? completedTurns.length / allTurns.length : 0,
    sessionErrors: sessionErrors.length,
    byMode: {
      speed: {
        turns: speedTurns.length,
        completed: speedTurns.filter((t) => t.completed).length,
        successRate: speedTurns.length ? speedTurns.filter((t) => t.completed).length / speedTurns.length : 0,
        avgLatency: speedTurns.length ? sum(speedTurns, "latency") / speedTurns.length : 0,
        avgTokens: speedTurns.length ? sum(speedTurns, "totalTokens") / speedTurns.length : 0,
      },
      coding: {
        turns: codingTurns.length,
        completed: codingTurns.filter((t) => t.completed).length,
        successRate: codingTurns.length ? codingTurns.filter((t) => t.completed).length / codingTurns.length : 0,
        avgLatency: codingTurns.length ? sum(codingTurns, "latency") / codingTurns.length : 0,
        avgTokens: codingTurns.length ? sum(codingTurns, "totalTokens") / codingTurns.length : 0,
      },
    },
    totals: {
      modelCalls: sum(allTurns, "modelCalls"),
      totalTokens: sum(allTurns, "totalTokens"),
      totalCostUsd: sum(allTurns, "costUsd"),
    },
    // Key pool health: no session should have excessive wait times
    keyPoolHealth: allResults.map((s) => ({
      sessionId: s.sessionId,
      maxLatency: Math.max(...s.results.map((r) => r.latency)),
      totalTokens: sum(s.results, "totalTokens"),
    })),
  };
}