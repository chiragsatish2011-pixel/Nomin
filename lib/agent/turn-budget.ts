// Per-turn model-call budget — the hard ceiling above all per-step retries.
//
// A healthy website turn needs 8–11 gateway calls; a normal turn with retries
// needs up to ~15; the full legitimate stack (coding-review chain + plan
// repair + synthesis fallbacks) tops out around 17–18. Failure cascades were
// observed at 20+ with no upper bound, burning most of the shared 40-RPM
// minute inside a single turn. The ceiling sits at 20: ~2x the healthy
// average, strictly above every legitimate pattern, cutting only the tail.

/** Total model-gateway calls allowed in one user turn. */
export const TURN_CALL_LIMIT = 20;

export type TurnBudget = {
  readonly limit: number;
  used: number;
  byCallType: Record<string, number>;
};

export function createTurnBudget(limit: number = TURN_CALL_LIMIT): TurnBudget {
  return { limit, used: 0, byCallType: {} };
}

export class TurnBudgetExceeded extends Error {
  readonly total: number;
  readonly byCallType: Record<string, number>;
  constructor(budget: TurnBudget) {
    const parts = Object.entries(budget.byCallType)
      .map(([callType, count]) => `${callType}×${count}`)
      .join(", ");
    super(`Turn call budget exceeded (${budget.used}/${budget.limit}): ${parts}`);
    this.name = "TurnBudgetExceeded";
    this.total = budget.used;
    this.byCallType = { ...budget.byCallType };
  }
}

/** Single choke point. Every modelGateway.complete/completeText entry passes
 *  here BEFORE anything is enqueued, so a refused call spends zero RPM.
 *  Transport-level retries inside one gateway call stay under that call's own
 *  maxAttempts budget; this counter bounds logical calls per turn. */
export function takeBudgetSlot(budget: TurnBudget | undefined, callType: string): void {
  if (!budget) return;
  if (budget.used >= budget.limit) throw new TurnBudgetExceeded(budget);
  budget.used += 1;
  budget.byCallType[callType] = (budget.byCallType[callType] ?? 0) + 1;
}
