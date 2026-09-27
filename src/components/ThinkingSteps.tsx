import { useState } from "react";
import type { AgentEvent } from "@nomin/work-tree";

/**
 * The turn, written out.
 *
 * One list, nested the way the work actually nested: the build owns the tools
 * it ran, each tool owns what it wrote or printed. A row with evidence behind
 * it opens in place — the thinking, the file it wrote, the output a command
 * gave back — so the whole record of a turn is readable from the one tag
 * rather than split across two views of the same events.
 *
 * Nothing here is invented. Every row is an event the agent emitted, and a row
 * only offers to open when there is something real underneath it.
 */

interface Step {
  key: string;
  kind: string;
  label: string;
  detail?: string;
  state: "running" | "done" | "failed";
  body?: string;
  bodyKind?: "thinking" | "code" | "output" | "text";
  bodyTitle?: string;
  at?: number;
  endedAt?: number;
  children: Step[];
  /** How many identical rows this one stands for. */
  repeats?: number;
}

const OPENS = /\.started$/;
const CLOSES = /\.(completed|passed|created|modified|resumed)$/;
const FAILS = /\.failed$/;

/** The turn's own start and finish are scaffolding, not steps. */
const SKIP = new Set(["task.started", "task.completed"]);

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
 * Fold the event log into a tree of steps.
 *
 * Events carry a `parent`, so nesting is read from the log rather than
 * guessed: the tool calls of a build sit under that build. An event whose
 * parent has not been seen is promoted to the top rather than dropped, because
 * a step with a missing parent still happened.
 */
export function toSteps(events: AgentEvent[]): Step[] {
  const roots: Step[] = [];
  const byId = new Map<string, Step>();
  const open = new Map<string, Step>();

  const place = (step: Step, parent?: string) => {
    const host = parent ? byId.get(parent) : undefined;
    if (host) host.children.push(step);
    else roots.push(step);
  };

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
        children: [],
      };
      place(step, event.parent === "task" ? undefined : event.parent);
      if (event.id) byId.set(event.id, step);
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

    // A standalone fact: a file written, a limit hit, a test run.
    const step: Step = {
      key,
      kind,
      label: event.label ?? FALLBACK[event.type] ?? event.type,
      detail: event.detail,
      state: FAILS.test(event.type) ? "failed" : CLOSES.test(event.type) ? "done" : "running",
      body: event.body,
      bodyKind: event.bodyKind,
      bodyTitle: event.bodyTitle,
      at: event.at,
      children: [],
    };
    place(step, event.parent === "task" ? undefined : event.parent);
    if (event.id) byId.set(event.id, step);
  });

  return collapse(roots);
}

/**
 * Fold consecutive identical rows into one.
 *
 * Every pass at the model opens and closes a thinking row, so a build that
 * took five rounds left five "Thought through it" lines in a column — which
 * reads as a stutter rather than as work. They become one row that says how
 * many, keeping the evidence of each behind it.
 */
function collapse(steps: Step[]): Step[] {
  const out: Step[] = [];
  for (const step of steps) {
    const previous = out[out.length - 1];
    const same =
      previous &&
      previous.kind === step.kind &&
      previous.label === step.label &&
      !previous.children.length &&
      !step.children.length;

    if (same) {
      previous.repeats = (previous.repeats ?? 1) + 1;
      // Keep the first piece of evidence; the rest are the same shape.
      if (!previous.body && step.body) {
        previous.body = step.body;
        previous.bodyKind = step.bodyKind;
        previous.bodyTitle = step.bodyTitle;
      }
      previous.endedAt = step.endedAt ?? previous.endedAt;
      if (step.state === "failed") previous.state = "failed";
      continue;
    }

    out.push({ ...step, children: collapse(step.children) });
  }
  return out;
}

export function ThinkingSteps({ events }: { events: AgentEvent[] }) {
  const steps = toSteps(events);
  if (!steps.length) return null;
  return <StepList steps={steps} depth={0} />;
}

function StepList({ steps, depth }: { steps: Step[]; depth: number }) {
  return (
    <ol className="steps" data-depth={depth}>
      {steps.map((step) => (
        <StepRow key={step.key} step={step} depth={depth} />
      ))}
    </ol>
  );
}

function StepRow({ step, depth }: { step: Step; depth: number }) {
  const body = step.body?.trim();
  const hasChildren = step.children.length > 0;
  // Nested work opens by default — that is the part you wanted to see. The
  // evidence behind a single row stays folded until it is asked for.
  const [open, setOpen] = useState(hasChildren && depth < 1);
  const canOpen = Boolean(body) || hasChildren;
  const took =
    step.at && step.endedAt && step.endedAt - step.at > 900
      ? `${Math.round((step.endedAt - step.at) / 100) / 10}s`
      : null;

  return (
    <li className={`step ${step.state} kind-${step.kind}${open ? " open" : ""}`}>
      <span className="step-pip" aria-hidden="true" />
      <div className="step-body">
        <div className="step-line">
          {canOpen ? (
            <button
              type="button"
              className="step-label opens"
              onClick={() => setOpen(!open)}
              aria-expanded={open}
            >
              <span className={`caret-icon${open ? " up" : ""}`}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </span>
              {step.label}
            </button>
          ) : (
            <span className="step-label">{step.label}</span>
          )}
          {step.repeats && step.repeats > 1 ? (
            <span className="step-count">×{step.repeats}</span>
          ) : null}
          {step.detail && <span className="step-detail">{step.detail}</span>}
          {took && <span className="step-took">{took}</span>}
          {hasChildren && !open && (
            <span className="step-count">
              {step.children.length} step{step.children.length === 1 ? "" : "s"}
            </span>
          )}
        </div>

        {open && body && (
          <div className={`step-evidence ${step.bodyKind ?? "text"}`}>
            {step.bodyTitle && <p className="step-evidence-title">{step.bodyTitle}</p>}
            <pre>{body}</pre>
          </div>
        )}

        {open && hasChildren && <StepList steps={step.children} depth={depth + 1} />}
      </div>
    </li>
  );
}
