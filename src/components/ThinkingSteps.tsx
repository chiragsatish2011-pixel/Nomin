import { useState } from "react";
import type { AgentEvent } from "@nomin/work-tree";

/**
 * The turn, written out as steps.
 *
 * The work tree draws the *shape* of a turn, which is the right picture for
 * watching it run. It is not, however, something you can read back afterwards:
 * a finished build leaves a diagram whose labels are already gone past. This
 * is the same record as prose — each thing the agent did, in order, with what
 * it thought and what it produced tucked behind the step it belongs to.
 *
 * Nothing here is invented. Every row is an event the agent actually emitted,
 * and a step only offers to open when there is real evidence underneath it.
 */

/** A `*.started` / `*.completed` pair folded into one readable row. */
interface Step {
  key: string;
  kind: string;
  label: string;
  detail?: string;
  state: "running" | "done" | "failed";
  /** What it thought, wrote or printed. Shown only when opened. */
  body?: string;
  bodyKind?: "thinking" | "code" | "output" | "text";
  bodyTitle?: string;
  at?: number;
  endedAt?: number;
}

const OPENS = /\.(started)$/;
const CLOSES = /\.(completed|passed|created|modified|resumed)$/;
const FAILS = /\.(failed)$/;

/** Rows that are pure scaffolding — the turn's own start and finish. */
const SKIP = new Set(["task.started", "task.completed"]);

/** A readable name for an event that never carried a label of its own. */
const FALLBACK: Record<string, string> = {
  "thinking.started": "Thinking",
  "thinking.completed": "Thought it through",
  "step.started": "Working",
  "step.completed": "Finished the step",
  "tool.started": "Running a tool",
  "tool.completed": "Tool finished",
  "file.created": "Wrote a file",
  "file.modified": "Edited a file",
  "command.started": "Ran a command",
  "command.completed": "Command finished",
  "build.started": "Building",
  "build.completed": "Build finished",
  "test.started": "Testing",
  "test.passed": "Tests passed",
  "test.failed": "Tests failed",
  "rate_limit.detected": "Rate limited",
  "cooldown.started": "Waiting for cooldown",
  "cooldown.completed": "Cooldown finished",
  "agent.resumed": "Resumed",
  "verification.started": "Checking the record",
  "verification.passed": "Record checks out",
  "verification.failed": "Record does not check out",
  "plan.created": "Proposed a plan",
  "plan.approved": "Plan approved",
  "question.created": "Asked for requirements",
};

/**
 * Fold the event log into steps. A `*.started` opens a row and the matching
 * end event settles it; anything that arrives without a partner stands on its
 * own, because an event with no pair is still something that happened.
 */
export function toSteps(events: AgentEvent[]): Step[] {
  const steps: Step[] = [];
  const open = new Map<string, Step>();

  events.forEach((event, index) => {
    if (SKIP.has(event.type)) return;
    const kind = event.type.split(".")[0] ?? event.type;
    const key = event.id ?? `${event.type}-${index}`;

    if (OPENS.test(event.type)) {
      const step: Step = {
        key,
        kind,
        label: event.label ?? FALLBACK[event.type] ?? kind,
        detail: event.detail,
        state: "running",
        at: event.at,
      };
      steps.push(step);
      open.set(key, step);
      return;
    }

    const partner = event.id ? open.get(event.id) : undefined;
    if (partner) {
      partner.state = FAILS.test(event.type) ? "failed" : "done";
      if (event.label) partner.label = event.label;
      if (event.detail !== undefined) partner.detail = event.detail;
      if (event.body) {
        partner.body = event.body;
        partner.bodyKind = event.bodyKind ?? partner.bodyKind;
        partner.bodyTitle = event.bodyTitle ?? partner.bodyTitle;
      }
      partner.endedAt = event.at;
      open.delete(event.id!);
      return;
    }

    // No partner: a standalone fact — a file written, a limit hit, a test run.
    steps.push({
      key,
      kind,
      label: event.label ?? FALLBACK[event.type] ?? event.type,
      detail: event.detail,
      state: FAILS.test(event.type) ? "failed" : CLOSES.test(event.type) ? "done" : "running",
      body: event.body,
      bodyKind: event.bodyKind,
      bodyTitle: event.bodyTitle,
      at: event.at,
    });
  });

  return steps;
}

export function ThinkingSteps({ events }: { events: AgentEvent[] }) {
  const steps = toSteps(events);
  if (!steps.length) return null;
  return (
    <ol className="steps">
      {steps.map((step) => (
        <StepRow key={step.key} step={step} />
      ))}
    </ol>
  );
}

function StepRow({ step }: { step: Step }) {
  const [open, setOpen] = useState(false);
  const body = step.body?.trim();
  const took =
    step.at && step.endedAt && step.endedAt - step.at > 900
      ? `${Math.round((step.endedAt - step.at) / 100) / 10}s`
      : null;

  return (
    <li className={`step ${step.state} kind-${step.kind}`}>
      <span className="step-pip" aria-hidden="true" />
      <div className="step-body">
        <div className="step-line">
          {body ? (
            <button
              type="button"
              className="step-label opens"
              onClick={() => setOpen(!open)}
              aria-expanded={open}
            >
              {step.label}
              <span className={`caret-icon${open ? " up" : ""}`}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </span>
            </button>
          ) : (
            <span className="step-label">{step.label}</span>
          )}
          {step.detail && <span className="step-detail">{step.detail}</span>}
          {took && <span className="step-took">{took}</span>}
        </div>

        {open && body && (
          <div className={`step-evidence ${step.bodyKind ?? "text"}`}>
            {step.bodyTitle && <p className="step-evidence-title">{step.bodyTitle}</p>}
            <pre>{body}</pre>
          </div>
        )}
      </div>
    </li>
  );
}
