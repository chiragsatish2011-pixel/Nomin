import { useEffect, useRef, useState } from "react";
import { WorkTreeView } from "@nomin/work-tree/react";
import { krakenAurora, krakenDark, type AgentEvent } from "@nomin/work-tree";
import { ParticleOrb } from "./ParticleOrb.js";
import { currentPhase } from "./Pipeline.js";
import { ThinkingSteps } from "./ThinkingSteps.js";

/**
 * The thinking tag.
 *
 * One line when closed, the whole record of the turn when open: what it
 * thought, what it ran, the files it wrote and what it wrote in them, nested
 * the way the work nested. There is deliberately only one view — it was two
 * for a while, a step list and a diagram of the same events, and having to
 * pick between them meant neither was the place you looked.
 *
 * The private reasoning is never streamed into the transcript. It sits inside
 * the step it belongs to and appears when that step is opened.
 */
export function ThinkingBlock({
  events,
  running,
  theme = "dark",
  status,
}: {
  events: AgentEvent[];
  running: boolean;
  theme?: "light" | "dark";
  status: string;
}) {
  const [open, setOpen] = useState(true);
  const startedAt = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0);
  const settled = useRef<number | null>(null);

  useEffect(() => {
    if (!running) {
      settled.current ??= Math.max(1, Math.round((Date.now() - startedAt.current) / 1000));
      return;
    }
    settled.current = null;
    const timer = window.setInterval(
      () => setElapsed(Math.round((Date.now() - startedAt.current) / 1000)),
      500,
    );
    return () => window.clearInterval(timer);
  }, [running]);

  useEffect(() => {
    if (!running) setOpen(false);
  }, [running]);

  if (!events.length) return null;

  const seconds = running ? elapsed : (settled.current ?? elapsed);
  const steps = events.filter((event) => event.type.endsWith(".started")).length;
  const phase = currentPhase(events);

  return (
    <section className={`thinking${open ? " open" : ""}${running ? " live" : ""}`}>
      <button
        className="thinking-head"
        onClick={() => setOpen(!open)}
        type="button"
        aria-expanded={open}
      >
        <ParticleOrb size={running ? 44 : 34} count={running ? 520 : 300} active={running} />
        <span className="thinking-copy">
          <span className="thinking-label">{running ? status : `Thought for ${seconds}s`}</span>
          <span className="thinking-meta">
            {phase ? `${phase.toLowerCase()} · ` : ""}
            {steps} step{steps === 1 ? "" : "s"} · {seconds}s
          </span>
        </span>
        <span className={`caret-icon${open ? " up" : ""}`}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
      </button>

      {open && (
        <div className="thinking-body">
          {/* While the turn is live the tree is the right picture: it grows as
              the work does, and watching it grow is how you know something is
              happening. Once the turn is over a diagram is the wrong shape for
              reading back what was done, so the same events become the step
              list — with the thinking and the file it wrote behind each row.
              One tag, two states of the same record. */}
          <ThinkingSteps events={events} />
        </div>
      )}
    </section>
  );
}
