import { useEffect, useState } from "react";
import type { MonitorState, ReviewStep } from "../lib/useMonitor.js";
import { Markdown } from "./Markdown.js";

/**
 * The brief handed back to the agent.
 *
 * It carries the exact text the page threw and the manager's own findings,
 * because "it is broken" is not something a model can act on, and a stack
 * message is.
 */
function fixBrief(monitor: MonitorState): string {
  const parts: string[] = [];
  if (monitor.reviewed) parts.push(`Fix ${monitor.reviewed}. Do not start over — edit the file that exists.`);
  if (monitor.runtimeErrors?.length) {
    parts.push(`It throws when the page loads:\n${monitor.runtimeErrors.map((error) => `- ${error}`).join("\n")}`);
  }
  const issues = monitor.verdict?.issues ?? [];
  if (issues.length) parts.push(`The review also found:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
  parts.push("Read the file first, make the smallest change that fixes it, then say what you changed.");
  return parts.join("\n\n");
}

const LABEL: Record<string, string> = {
  verified: "Approved",
  unverified: "Not approved yet",
  concerns: "Sent back",
  failed: "Rejected",
};

/**
 * The manager, speaking in the thread.
 *
 * While it is working it shows the stages it is actually going through — read
 * the files, render the result, run it, judge it — each one appearing as it
 * starts and settling with what it found. The old card showed a single frozen
 * line for the whole pass, which looked like a decoration rather than a
 * review, and gave no sign whether anything was really happening.
 *
 * It only ever states what was actually checked. "Not approved yet" is a real
 * outcome here, not a softer way of saying fine.
 */
export function ReportCard({
  monitor,
  onFix,
  fixing,
}: {
  monitor: MonitorState;
  /** Hand the exact failure back to the agent. */
  onFix?: (brief: string) => void;
  fixing?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const working = monitor.status === "capturing" || monitor.status === "reviewing";

  if (working) {
    return <LiveReview monitor={monitor} />;
  }

  const verdict = monitor.verdict;
  if (monitor.status === "failed") {
    return (
      <aside className="report-card unverified">
        <header className="report-card-head">
          <span className="report-who">Manager</span>
          <span className="verdict unverified">Could not review</span>
        </header>
        <p className="report-card-summary">
          {monitor.error ?? "The review did not complete, so this work is unapproved."}
        </p>
      </aside>
    );
  }
  if (!verdict || monitor.status === "idle") return null;

  const hasDetail =
    Boolean(verdict.report) ||
    verdict.issues.length > 0 ||
    verdict.evidence.length > 0 ||
    monitor.steps.length > 0;

  return (
    <aside className={`report-card ${verdict.status}`}>
      <header className="report-card-head">
        <span className="report-who">Manager</span>
        <span className={`verdict ${verdict.status}`}>{LABEL[verdict.status] ?? verdict.status}</span>
        <span className="report-source">
          {verdict.usedModel
            ? verdict.sawRendering
              ? "reviewed the rendering"
              : "reviewed the record"
            : "evidence only"}
        </span>
      </header>

      <p className="report-card-summary">{verdict.summary}</p>

      {/* Why the manager did not get to weigh in. Without this, a deployment
          whose manager silently never runs looks exactly like one whose
          manager ran and had no objection. */}
      {!verdict.usedModel && verdict.note && <p className="report-note">{verdict.note}</p>}

      {onFix && (monitor.runtimeErrors?.length || verdict.status === "concerns" || verdict.status === "failed") ? (
        <div className="report-actions">
          <button
            className="fix-btn"
            disabled={fixing}
            onClick={() => onFix(fixBrief(monitor))}
          >
            {fixing ? "Fixing…" : monitor.runtimeErrors?.length ? "Fix these errors" : "Address these findings"}
          </button>
          {monitor.runtimeErrors?.length ? (
            <span className="report-errors">
              {monitor.runtimeErrors.length} runtime error
              {monitor.runtimeErrors.length === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>
      ) : null}

      {hasDetail && (
        <button className="report-toggle" onClick={() => setOpen(!open)}>
          {open ? "Hide what was checked" : "Show what was checked"}
        </button>
      )}

      {open && (
        <div className="report-card-detail">
          {monitor.steps.length > 0 && <StepList steps={monitor.steps} />}
          {verdict.issues.length > 0 && (
            <ul className="report-issues">
              {verdict.issues.map((issue, i) => (
                <li key={i}>{issue}</li>
              ))}
            </ul>
          )}
          {verdict.report && <Markdown text={verdict.report} plain />}
          {verdict.evidence.length > 0 && (
            <p className="report-evidence">Checked: {verdict.evidence.join(" · ")}</p>
          )}
        </div>
      )}
    </aside>
  );
}

/** The review while it is running: the stages, as they happen. */
function LiveReview({ monitor }: { monitor: MonitorState }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);

  const seconds = monitor.startedAt ? Math.max(0, Math.round((now - monitor.startedAt) / 1000)) : 0;

  return (
    <aside className="report-card reviewing">
      <header className="report-card-head">
        <span className="report-spark" />
        <span className="report-who">Manager</span>
        <span className="report-live">reviewing the work</span>
        <span className="report-source">{seconds}s</span>
      </header>
      <StepList steps={monitor.steps} />
      <p className="report-gate">Nomin will not call this done until the manager approves it.</p>
    </aside>
  );
}

function StepList({ steps }: { steps: ReviewStep[] }) {
  if (!steps.length) return null;
  return (
    <ol className="review-steps">
      {steps.map((step) => (
        <li key={step.id} className={`review-step ${step.state}`}>
          <span className="review-pip" />
          <span className="review-label">{step.label}</span>
          {step.detail && <span className="review-detail">{step.detail}</span>}
          {step.endedAt && step.endedAt - step.startedAt > 900 && (
            <span className="review-took">{Math.round((step.endedAt - step.startedAt) / 100) / 10}s</span>
          )}
        </li>
      ))}
    </ol>
  );
}
