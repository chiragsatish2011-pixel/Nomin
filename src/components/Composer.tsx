import { useEffect, useRef, useState } from "react";

export type Mode = "quick" | "balanced" | "deep";

export const MODES: Record<Mode, { label: string; hint: string; icon: string }> = {
  quick: { label: "Quick", hint: "Short answers, least latency", icon: "⚡" },
  balanced: { label: "Balanced", hint: "The default working mode", icon: "◑" },
  deep: { label: "DeepThink", hint: "Longer reasoning budget for hard work", icon: "✳" },
};

/**
 * The composer. The aurora halo is not decoration: it is dim at rest, lifts on
 * focus, and runs while the agent is working, so the box itself reports state.
 */
export function Composer({
  draft,
  setDraft,
  submit,
  stop,
  running,
  status,
  mode,
  setMode,
  placeholder,
}: {
  draft: string;
  setDraft: (value: string) => void;
  submit: () => void;
  stop: () => void;
  running: boolean;
  status: string;
  mode: Mode;
  setMode: (mode: Mode) => void;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  // Grow with the draft, up to a limit, then scroll.
  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    area.style.height = "auto";
    area.style.height = `${Math.min(area.scrollHeight, 220)}px`;
  }, [draft]);

  return (
    <div className={`composer-shell${running ? " running" : ""}`}>
      <span className="composer-halo" aria-hidden="true" />
      <div className="composer">
        <textarea
          ref={areaRef}
          value={draft}
          placeholder={placeholder}
          rows={1}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />

        <div className="composer-bar">
          <button className="round-btn" title="Attach context" type="button">
            +
          </button>

          <div className="mode-picker" ref={menuRef}>
            <button className="mode-btn" onClick={() => setOpen(!open)} type="button">
              <span className="mode-icon">{MODES[mode].icon}</span>
              {MODES[mode].label}
              <span className={`caret-icon${open ? " up" : ""}`}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </span>
            </button>

            {open && (
              <div className="mode-menu" role="menu">
                {(Object.keys(MODES) as Mode[]).map((key) => (
                  <button
                    key={key}
                    className={key === mode ? "on" : ""}
                    onClick={() => {
                      setMode(key);
                      setOpen(false);
                    }}
                    type="button"
                  >
                    <span className="mode-icon">{MODES[key].icon}</span>
                    <span className="mode-text">
                      {MODES[key].label}
                      <em>{MODES[key].hint}</em>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <span className="composer-status">{running ? status : ""}</span>

          {running ? (
            <button className="stop-btn" onClick={stop} title="Stop" type="button">
              <span className="stop-square" />
            </button>
          ) : (
            <button
              className="send-btn"
              onClick={submit}
              disabled={!draft.trim()}
              title="Send"
              type="button"
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 19V5M6 11l6-6 6 6" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
