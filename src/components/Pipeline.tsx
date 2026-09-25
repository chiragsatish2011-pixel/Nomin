import type { AgentEvent } from "@nomin/work-tree";

/**
 * The task pipeline: THINK → PLAN → BUILD → TEST → VERIFY.
 *
 * It is not decoration — each segment's state is derived from the agent's real
 * event log, so a phase only lights up once the agent actually entered it.
 */
export type PhaseState = "idle" | "active" | "done" | "failed" | "waiting";

const PHASES = ["Think", "Plan", "Build", "Test", "Verify"] as const;
export type Phase = (typeof PHASES)[number];

const ENTER: Record<string, Phase> = {
  "thinking.started": "Think",
  "question.created": "Plan",
  "plan.created": "Plan",
  "plan.approved": "Plan",
  "step.started": "Build",
  "tool.started": "Build",
  "command.started": "Build",
  "file.created": "Build",
  "file.modified": "Build",
  "build.started": "Build",
  "test.started": "Test",
  "verification.started": "Verify",
};

const SETTLE: Record<string, { phase: Phase; state: PhaseState }> = {
  "thinking.completed": { phase: "Think", state: "done" },
  "plan.approved": { phase: "Plan", state: "done" },
  "build.completed": { phase: "Build", state: "done" },
  "build.failed": { phase: "Build", state: "failed" },
  "step.completed": { phase: "Build", state: "done" },
  "step.failed": { phase: "Build", state: "failed" },
  "test.passed": { phase: "Test", state: "done" },
  "test.failed": { phase: "Test", state: "failed" },
  "verification.passed": { phase: "Verify", state: "done" },
  "verification.failed": { phase: "Verify", state: "failed" },
};

export function derivePhases(events: AgentEvent[]): Record<Phase, PhaseState> {
  const phases: Record<Phase, PhaseState> = {
    Think: "idle",
    Plan: "idle",
    Build: "idle",
    Test: "idle",
    Verify: "idle",
  };
  let waiting = false;

  for (const event of events) {
    if (event.type === "cooldown.started") waiting = true;
    if (event.type === "agent.resumed" || event.type === "cooldown.completed") waiting = false;

    const entered = ENTER[event.type];
    if (entered && phases[entered] !== "active" && phases[entered] !== "waiting") phases[entered] = "active";

    const settled = SETTLE[event.type];
    if (settled) phases[settled.phase] = settled.state;
  }

  if (waiting) {
    for (const phase of PHASES) {
      if (phases[phase] === "active") phases[phase] = "waiting";
    }
  }
  return phases;
}

/** The phase the agent is in right now, for the collapsed thinking line. */
export function currentPhase(events: AgentEvent[]): Phase | null {
  const phases = derivePhases(events);
  const live = PHASES.find((phase) => phases[phase] === "active" || phases[phase] === "waiting");
  if (live) return live;
  const done = [...PHASES].reverse().find((phase) => phases[phase] === "done");
  return done ?? null;
}

/**
 * The phases as tags inside the thinking indicator — only the phases the agent
 * actually reached, so an ordinary answer shows one tag, not five empty ones.
 */
export function PhaseTags({ events }: { events: AgentEvent[] }) {
  const phases = derivePhases(events);
  const reached = PHASES.filter((phase) => phases[phase] !== "idle");
  if (!reached.length) return null;
  return (
    <div className="phase-tags">
      {reached.map((phase) => (
        <span key={phase} className={`phase-tag ${phases[phase]}`}>
          <i />
          {phase}
        </span>
      ))}
    </div>
  );
}

export function Pipeline({ events }: { events: AgentEvent[] }) {
  const phases = derivePhases(events);
  return (
    <ol className="pipeline">
      {PHASES.map((phase, i) => (
        <li key={phase} className={`phase ${phases[phase]}`}>
          {i > 0 && <span className="phase-link" aria-hidden="true" />}
          <span className="phase-dot" />
          <span className="phase-name">{phase}</span>
        </li>
      ))}
    </ol>
  );
}
