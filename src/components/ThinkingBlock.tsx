import { useEffect, useRef, useState } from "react";
import { WorkTreeView } from "@nomin/work-tree/react";
import { krakenAurora, krakenDark, type AgentEvent } from "@nomin/work-tree";
import { ParticleOrb } from "./ParticleOrb.js";
import { currentPhase } from "./Pipeline.js";
import { ThinkingSteps } from "./ThinkingSteps.js";

/**
 * The thinking block: the orb, the status line, and — once opened — the whole
 * record of the turn.
 *
 * It collapses to a single line and expands to two readable views of the same
 * events: **Steps**, which is the turn written out in order with what the
 * agent thought and produced behind each row, and **Tree**, the live diagram
 * growing out of the orb.
 *
 * Steps is the default because it is the one you can read back afterwards. The
 * reasoning is never streamed into the transcript — it sits inside the step it
 * belongs to, and only appears when you ask for it.
 */
export function ThinkingBlock({
  events,
  running,
  theme,
  status,
}: {
  events: AgentEvent[];
  running: boolean;
  theme: "light" | "dark";
  status: string;
}) {
  const [open, setOpen] = useState(true);
  const [view, setView] = useState<"steps" | "tree">("steps");
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
        <ParticleOrb size={running ? 56 : 44} count={running ? 520 : 300} active={running} />
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
          <div className="thinking-views">
            <button
              type="button"
              className={view === "steps" ? "on" : ""}
              onClick={() => setView("steps")}
            >
              Steps
            </button>
            <button
              type="button"
              className={view === "tree" ? "on" : ""}
              onClick={() => setView("tree")}
            >
              Tree
            </button>
          </div>

          {view === "steps" ? (
            <div className="thinking-steps">
              <ThinkingSteps events={events} />
            </div>
          ) : (
            <div className="thinking-tree">
              <WorkTreeView
                events={events}
                rootless
                theme={theme === "dark" ? krakenDark : krakenAurora}
              />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
