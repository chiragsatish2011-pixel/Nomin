// Perf instrumentation for the agentic loop.
// Logs per-stage wall-clock times and per-model-call input sizes.
// Active only when TRION_PERF=1 so production stays clean.

const ENABLED = process.env.TRION_PERF === "1";

export function perf(stage: string, ms: number, meta?: Record<string, unknown>) {
  if (!ENABLED) return;
  const line = `[perf] ${stage} ${ms.toFixed(0)}ms${meta ? ` ${JSON.stringify(meta)}` : ""}`;
  console.log(line);
}

/** Estimate of tokens from characters (~4 chars/token). */
export function estTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estTokensOf(parts: Array<{ role: string; content: string }>): number {
  let total = 0;
  for (const part of parts) total += estTokens(part.content);
  return total;
}
