"use client";

// ---------------------------------------------------------------------------
// TraceTree — the live task tree for a turn.
//
// Shape borrowed from the agent CLIs people already know: a checklist of steps
// that fills in as the work happens, each step expandable to the tool calls it
// actually made. Two rules make it readable rather than a wall of log:
//
//   1. AUTO-FOCUS — the step currently running is the only one expanded. When it
//      finishes it collapses on its own and the next one opens. You watch one
//      thing at a time instead of an ever-growing tree.
//   2. USER OVERRIDE WINS — opening or closing a step by hand pins it, and the
//      auto-focus never fights that choice again for the rest of the turn.
//
// Nodes are built ONLY from real streamed events (status / plan / plan_update /
// tool_call / tool_result / result). Nothing here is cosmetic: a row exists
// because something actually ran.
// ---------------------------------------------------------------------------

import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  CircleDashed,
  FileCode2,
  FileSearch,
  Hammer,
  Globe2,
  ListTree,
  MinusCircle,
  Play,
  ShieldCheck,
  Sparkles,
  Terminal,
} from "lucide-react";

export type TraceNodeKind = "intent" | "plan" | "step" | "tool" | "retry" | "synthesis";

export type TraceNodeStatus = "pending" | "running" | "done" | "error" | "cancelled";

export type TraceNode = {
  id: string;
  kind: TraceNodeKind;
  label: string;
  status: TraceNodeStatus;
  parentId: string | null;
  detail?: string;
  result?: string;
  attempt?: number;
  stepId?: number;
  toolName?: string;
};

const TOOL_ICON: Record<string, typeof FileCode2> = {
  read_file: FileSearch,
  search_codebase: FileSearch,
  write_file: FileCode2,
  run_command: Terminal,
  web_fetch: Globe2,
  finish: Check,
};

const TOOL_VERB: Record<string, string> = {
  read_file: "Read",
  search_codebase: "Searched",
  write_file: "Updated",
  run_command: "Checked",
  web_fetch: "Read page",
  finish: "Completed",
};

/** Human label for a tool call row: the tool plus the thing it acted on. */
function toolSubject(node: TraceNode): string | null {
  if (!node.detail) return null;
  try {
    const input = JSON.parse(node.detail) as Record<string, unknown>;
    if (typeof input.path === "string") return input.path;
    if (typeof input.command === "string") return input.command;
    if (typeof input.query === "string") return `"${input.query}"`;
    if (typeof input.url === "string") return input.url;
  } catch {
    // detail is not JSON — fall through
  }
  return null;
}

type FlowStage = {
  label: string;
  status: TraceNodeStatus;
  Icon: typeof ListTree;
};

/**
 * The default surface is intentionally a small, user-facing delivery flow.
 * The raw trace remains available below it, but is not the thing users need
 * to parse while they wait for a result.
 */
function buildFlowStages(nodes: TraceNode[], steps: TraceNode[]): FlowStage[] {
  const plan = nodes.find((node) => node.kind === "plan");
  const synthesis = nodes.find((node) => node.kind === "synthesis");
  const hasVerification = nodes.some(
    (node) => node.kind === "tool" && node.toolName === "run_command",
  );
  const buildFailed = steps.some((step) => step.status === "error");
  const buildStopped = steps.some((step) => step.status === "cancelled") && !steps.some((step) => step.status === "running");
  const allStepsDone = steps.length > 0 && steps.every((step) => step.status === "done");
  const building = steps.some((step) => step.status === "running");

  const verificationStatus: TraceNodeStatus = buildFailed
    ? "pending"
    : synthesis?.status === "done"
      ? hasVerification ? "done" : "pending"
      : allStepsDone && hasVerification
        ? "running"
        : "pending";

  return [
    { label: "Plan", status: plan?.status ?? "pending", Icon: ListTree },
    {
      label: "Build",
      status: buildFailed ? "error" : buildStopped ? "cancelled" : allStepsDone ? "done" : building ? "running" : "pending",
      Icon: Hammer,
    },
    { label: "Verify", status: verificationStatus, Icon: ShieldCheck },
    { label: "Deliver", status: synthesis?.status ?? "pending", Icon: Sparkles },
  ];
}

export function TraceTree({ nodes }: { nodes: TraceNode[] }) {
  // stepId -> explicitly set by the user. Absent means "follow the run".
  const [pinned, setPinned] = useState<Record<string, boolean>>({});
  const [detailsOpen, setDetailsOpen] = useState(false);
  const lastRunningRef = useRef<string | null>(null);

  const steps = nodes.filter((node) => node.kind === "step");
  const runningStep = steps.find((step) => step.status === "running") ?? null;

  useEffect(() => {
    lastRunningRef.current = runningStep?.id ?? lastRunningRef.current;
  }, [runningStep?.id]);

  if (nodes.length === 0) return null;

  const childrenOf = (stepId: string) => nodes.filter((node) => node.parentId === stepId);

  const isOpen = (step: TraceNode) => {
    if (step.id in pinned) return pinned[step.id];
    // Follow the run: the active step is open, and a failed step stays open
    // because its output is the thing the user needs to read.
    return step.status === "running" || step.status === "error";
  };

  const done = steps.filter((s) => s.status === "done").length;
  const failed = steps.filter((s) => s.status === "error").length;
  const stopped = steps.some((step) => step.status === "cancelled") && !steps.some((step) => step.status === "running") && failed === 0;
  const toolCalls = nodes.filter((n) => n.kind === "tool" || n.kind === "retry").length;
  const flowStages = buildFlowStages(nodes, steps);
  const activeStep = runningStep ?? [...steps].reverse().find((step) => step.status === "done") ?? steps[0] ?? null;
  const activeStepIndex = activeStep ? steps.findIndex((step) => step.id === activeStep.id) : -1;
  const completedPercent = steps.length ? Math.round((done / steps.length) * 100) : 0;
  const upcoming = steps.filter((step) => step.status === "pending").slice(0, 2);
  const progressText =
    failed > 0
      ? "A step needs attention"
      : stopped
        ? "Stopped by you"
      : done === steps.length && steps.length > 0
        ? "Work completed"
        : activeStep
          ? activeStep.label.replace(/^Step \d+:\s*/, "")
          : "Preparing the work";
  // Technical detail is opt-in. A failed task already gets a plain-language
  // status in the conversation; exposing paths and tool payloads by default
  // turns a product status surface into a debug log.
  const showDetails = detailsOpen;

  const progressStyle = { "--task-progress": `${completedPercent}%` } as CSSProperties;

  return (
    <div className="taskTree" aria-label="Agent execution">
      <div className="taskTreeHead">
        <span className="taskTreeTitle">
          <span className={`taskLiveDot ${failed > 0 ? "error" : stopped || (done === steps.length && steps.length > 0) ? "done" : ""}`} aria-hidden="true" />
          <span className="nominWordmark">Nomin</span> at work
        </span>
        <span className="taskTreeCount">
          {failed > 0 ? "Needs attention" : stopped ? "Stopped" : steps.length > 0 ? `${done} of ${steps.length}` : "Preparing"}
        </span>
      </div>

      <div className={`taskProgress ${failed > 0 ? "error" : ""} ${stopped || (done === steps.length && steps.length > 0) ? "complete" : ""}`}>
        <span className="taskProgressOrb" style={progressStyle} aria-hidden="true">
          <span className="taskProgressOrbInner">
            {failed > 0 ? <AlertTriangle size={15} /> : stopped || (done === steps.length && steps.length > 0) ? <Check size={16} /> : <span>{steps.length ? `${Math.max(done + (runningStep ? 1 : 0), 1)}` : "…"}</span>}
          </span>
        </span>
        <span className="taskProgressCopy">
          <small>{failed > 0 ? "The task paused" : stopped ? "Work stopped" : done === steps.length && steps.length > 0 ? "Ready to review" : "Working now"}</small>
          <strong>{progressText}</strong>
          {steps.length > 0 ? <em>{failed > 0 ? "Your completed work remains available to retry." : activeStepIndex >= 0 ? `Step ${activeStepIndex + 1} of ${steps.length}` : `${done} of ${steps.length} steps complete`}</em> : null}
        </span>
        {(steps.length > 0 || toolCalls > 0) ? (
          <button className="taskDetailsButton" type="button" onClick={() => setDetailsOpen((open) => !open)}>
            {showDetails ? "Hide details" : "Details"}
            <ChevronRight className={showDetails ? "open" : ""} size={14} />
          </button>
        ) : null}
      </div>

      <ol className="phaseRail" aria-label="Work phases">
          {flowStages.map((phase) => {
            const Icon = phase.Icon;
            return (
              <li className={`phaseRailItem ${phase.status}`} key={phase.label}>
                <span className="phaseRailDot" aria-hidden="true">
                  {phase.status === "done" ? <Check size={10} /> : <Icon size={10} />}
                </span>
                <span className="phaseRailCopy">
                  <span className="phaseRailLabel">{phase.label}</span>
                  <span className="phaseRailState">
                    {phase.status === "done" ? "Done" : phase.status === "running" ? "Active" : phase.status === "error" ? "Paused" : phase.status === "cancelled" ? "Stopped" : "Next"}
                  </span>
                </span>
              </li>
            );
          })}
      </ol>

      {!showDetails && upcoming.length > 0 ? (
        <div className="taskNext" aria-label="Upcoming work">
          <span>Up next</span>
          <div>
            {upcoming.map((step) => <span key={step.id}>{step.label.replace(/^Step \d+:\s*/, "")}</span>)}
          </div>
        </div>
      ) : null}

      {showDetails && steps.length > 0 ? (
        <ol className="taskList">
          {steps.map((step, index) => {
            const children = childrenOf(step.id);
            const open = isOpen(step);
            const expandable = children.length > 0;

            return (
              <li className={`taskItem ${step.status}`} key={step.id}>
                <div className="taskRow">
                  <StatusMark status={step.status} />
                  <button
                    className="taskLabel"
                    type="button"
                    aria-expanded={expandable ? open : undefined}
                    disabled={!expandable}
                    onClick={() => expandable && setPinned((current) => ({ ...current, [step.id]: !open }))}
                  >
                    <span className="taskIndex">{index + 1}</span>
                    <span className="taskText">{step.label.replace(/^Step \d+:\s*/, "")}</span>
                    {expandable ? (
                      <span className={`taskChevron${open ? " open" : ""}`} aria-hidden="true">
                        <ChevronRight size={13} />
                      </span>
                    ) : null}
                  </button>
                  {children.length > 0 ? <span className="taskCallCount">{children.length}</span> : null}
                </div>

                {expandable && open ? (
                  <ul className="toolList">
                    {children.map((call) => (
                      <ToolRow key={call.id} node={call} />
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}

function StatusMark({ status }: { status: TraceNodeStatus }) {
  return (
    <span className={`taskMark ${status}`} aria-hidden="true">
      {status === "done" ? (
        <Check size={12} />
      ) : status === "error" ? (
        <AlertTriangle size={12} />
      ) : status === "cancelled" ? (
        <MinusCircle size={12} />
      ) : status === "running" ? (
        <Play size={10} />
      ) : (
        <CircleDashed size={12} />
      )}
    </span>
  );
}

function ToolRow({ node }: { node: TraceNode }) {
  const [open, setOpen] = useState(false);
  const Icon = TOOL_ICON[node.toolName ?? ""] ?? FileCode2;
  const subject = toolSubject(node);
  const subjectName = subject?.split("/").filter(Boolean).at(-1) ?? subject;
  const hasBody = Boolean(node.detail || node.result);

  return (
    <li className={`toolItem ${node.status}`}>
      <div className="toolRow">
        <span className="toolIcon" aria-hidden="true">
          <Icon size={12} />
        </span>
        <button
          className="toolLabel"
          type="button"
          disabled={!hasBody}
          aria-expanded={hasBody ? open : undefined}
          onClick={() => hasBody && setOpen((value) => !value)}
        >
          <span className="toolName">{TOOL_VERB[node.toolName ?? ""] ?? node.label}</span>
          {subjectName ? <span className="toolSubject" title={subject ?? undefined}>{subjectName}</span> : null}
          {node.attempt !== undefined && node.attempt > 1 ? <span className="toolAttempt">retry {node.attempt}</span> : null}
          {hasBody ? (
            <span className={`taskChevron${open ? " open" : ""}`} aria-hidden="true">
              <ChevronRight size={12} />
            </span>
          ) : null}
        </button>
        <StatusMark status={node.status} />
      </div>

      {open && hasBody ? (
        <div className="toolBody">
          {node.detail ? (
            <>
              <span className="toolBodyLabel">input</span>
              <pre>
                <code>{node.detail}</code>
              </pre>
            </>
          ) : null}
          {node.result ? (
            <>
              <span className="toolBodyLabel">output</span>
              <pre>
                <code>{node.result}</code>
              </pre>
            </>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
