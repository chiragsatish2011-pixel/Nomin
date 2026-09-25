import { useState } from "react";
import type { MonitorState } from "../lib/useMonitor.js";
import { Markdown } from "./Markdown.js";

const LABEL: Record<string, string> = {
  verified: "Verified",
  unverified: "Unverified",
  concerns: "Concerns",
  failed: "Failed",
};

/**
 * The monitor's review, delivered in the conversation rather than filed away
 * in a panel — it is a second voice in the thread, so it reads as one: a
 * distinct speaker, clearly separated from Trion's own answer.
 *
 * It only ever states what was actually checked. "Unverified" is a real
 * outcome here, not a softer way of saying "fine".
 */
export function ReportCard({ monitor }: { monitor: MonitorState }) {
  const [open, setOpen] = useState(false);

  if (monitor.status === "capturing" || monitor.status === "reviewing") {
    return (
      <aside className="report-card pending">
        <span className="report-spark" />
        {monitor.status === "capturing" ? "Rendering the result to review" : "Manager reviewing the work"}…
      </aside>
    );
  }

  const verdict = monitor.verdict;
  if (!verdict || monitor.status === "idle") return null;

  const hasDetail = Boolean(verdict.report) || verdict.issues.length > 0 || verdict.evidence.length > 0;

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

      {hasDetail && (
        <button className="report-toggle" onClick={() => setOpen(!open)}>
          {open ? "Hide detail" : "Show detail"}
        </button>
      )}

      {open && (
        <div className="report-card-detail">
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
