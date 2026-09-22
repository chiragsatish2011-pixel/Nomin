"use client";

// ---------------------------------------------------------------------------
// TraceTree — the live execution tree for a turn.
//
// A CONNECTED GRAPH, not a status card. What was here before was a product
// dashboard: a bordered panel with a progress orb, a percentage, and a fixed
// Plan/Build/Verify/Deliver rail that was inferred rather than observed. It
// answered "how far along is this?" and hid the only thing worth watching —
// what the agent is actually doing, in order, right now.
//
// This renders the real thing: one node per real event, on a vertical spine,
// children hanging off their step, the active node lit and the spine below it
// flowing downward while work is in flight. It reads top to bottom like the
// execution it describes, and it grows as the turn happens.
//
// Two rules keep it readable rather than a wall of log:
//
//   1. AUTO-FOCUS — the running step is the one expanded. When it finishes it
//      collapses and the next one opens, so you watch one thing at a time.
//   2. USER OVERRIDE WINS — opening or closing a step by hand pins it, and
//      auto-focus never fights that choice again for the rest of the turn.
//
// Nodes are built ONLY from real streamed events (status / plan / plan_update /
// tool_call / tool_result / result). Nothing here is cosmetic: a row exists
// because something actually ran.
// ---------------------------------------------------------------------------

import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  FileCode2,
  FileSearch,
  Globe2,
  ListTree,
  Minus,
  Sparkles,
  Terminal,
} from "lucide-react";
import { ThinkingMark } from "./ThinkingMark";

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
  write_file: "Wrote",
  run_command: "Ran",
  web_fetch: "Fetched",
  finish: "Finished",
};

/** The thing a tool call acted on: a path, a command, a query, a URL. */
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

function kindIcon(node: TraceNode) {
  if (node.kind === "plan") return ListTree;
  if (node.kind === "synthesis") return Sparkles;
  if (node.toolName && TOOL_ICON[node.toolName]) return TOOL_ICON[node.toolName];
  return ListTree;
}

/** The dot on the spine. It carries the status on its own, so a row is
 *  readable with the label clipped or the colour stripped. */
function Bead({ status }: { status: TraceNodeStatus }) {
  if (status === "running") {
    return (
      <span className="nmBead running" aria-hidden="true">
        <ThinkingMark size={16} />
      </span>
    );
  }
  return (
    <span className={`nmBead ${status}`} aria-hidden="true">
      {status === "done" ? <Check size={11} strokeWidth={3} />
        : status === "error" ? <AlertTriangle size={11} strokeWidth={2.6} />
        : status === "cancelled" ? <Minus size={11} strokeWidth={3} />
        : null}
    </span>
  );
}

function statusWord(status: TraceNodeStatus): string {
  return status === "running" ? "running"
    : status === "done" ? "done"
    : status === "error" ? "failed"
    : status === "cancelled" ? "stopped"
    : "pending";
}

/** One line of tool output, trimmed to something that belongs in a thread. */
function resultPreview(result: string): string {
  const text = result.trim();
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}

export function TraceTree({ nodes }: { nodes: TraceNode[] }) {
  // stepId -> explicitly set by the user. Absent means "follow the run".
  const [pinned, setPinned] = useState<Record<string, boolean>>({});
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

  const plan = nodes.find((node) => node.kind === "plan");
  const synthesis = nodes.find((node) => node.kind === "synthesis");
  const done = steps.filter((step) => step.status === "done").length;
  const failed = steps.filter((step) => step.status === "error").length;

  /** A spine segment flows while the work below it has not happened yet. */
  const flowing = (status: TraceNodeStatus) => (status === "running" ? " flowing" : "");

  return (
    <div className="nmTree" aria-label="Execution">
      {plan ? (
        <div className={`nmNode ${plan.status}`}>
          <span className={`nmSpine${flowing(plan.status)}`} aria-hidden="true" />
          <Bead status={plan.status} />
          <div className="nmNodeBody">
            <p className="nmNodeLabel">
              {plan.label}
              {steps.length > 0 ? <span className="nmNodeMeta">{done} of {steps.length}</span> : null}
            </p>
            {plan.detail ? <p className="nmNodeDetail">{plan.detail}</p> : null}
          </div>
        </div>
      ) : null}

      {steps.map((step, index) => {
        const children = childrenOf(step.id);
        const open = isOpen(step);
        const last = index === steps.length - 1 && !synthesis;
        return (
          <div className={`nmNode ${step.status}${last && children.length === 0 ? " last" : ""}`} key={step.id}>
            <span className={`nmSpine${flowing(step.status)}`} aria-hidden="true" />
            <Bead status={step.status} />
            <div className="nmNodeBody">
              <button
                className="nmNodeLabel button"
                type="button"
                aria-expanded={open}
                onClick={() => setPinned((current) => ({ ...current, [step.id]: !open }))}
              >
                <span className="nmNodeText">{step.label.replace(/^Step \d+:\s*/, "")}</span>
                <span className="nmNodeStatus">{statusWord(step.status)}</span>
                {children.length > 0 ? (
                  <ChevronRight className={open ? "nmNodeChevron open" : "nmNodeChevron"} size={14} />
                ) : null}
              </button>

              {open && children.length > 0 ? (
                <div className="nmBranch">
                  {children.map((child, childIndex) => {
                    const Icon = kindIcon(child);
                    const subject = toolSubject(child);
                    return (
                      <div
                        className={`nmLeaf ${child.status}${childIndex === children.length - 1 ? " last" : ""}`}
                        key={child.id}
                      >
                        <span className="nmLeafElbow" aria-hidden="true" />
                        <span className={`nmLeafDot ${child.status}`} aria-hidden="true" />
                        <div className="nmLeafBody">
                          <p className="nmLeafLabel">
                            <Icon size={13} />
                            <span>{child.toolName ? TOOL_VERB[child.toolName] ?? child.toolName : child.label}</span>
                            {subject ? <code>{subject}</code> : null}
                            {child.attempt && child.attempt > 1 ? <em>attempt {child.attempt}</em> : null}
                          </p>
                          {child.result ? (
                            <pre className="nmLeafResult">{resultPreview(child.result)}</pre>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </div>
        );
      })}

      {synthesis ? (
        <div className={`nmNode ${synthesis.status} last`}>
          <span className="nmSpine" aria-hidden="true" />
          <Bead status={synthesis.status} />
          <div className="nmNodeBody">
            <p className="nmNodeLabel">
              {failed > 0 ? "Stopped — a step needs attention" : synthesis.label}
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
