"use client";

import { useId } from "react";

type ThinkingMarkProps = {
  size?: number;
  className?: string;
  /** Rendered as the accessible name when this is the only "it's working" cue. */
  label?: string;
};

/**
 * The working indicator.
 *
 * Motion in this interface means exactly one thing — the agent is doing
 * something right now — so there is exactly one animated mark, and it is this.
 * Two arcs sweeping at different rates around a breathing core: legible at
 * 14px next to a line of status text, and not a spinner, because a spinner says
 * "waiting for a server" while this says "a model is working on it".
 *
 * The animation lives in CSS (see .nmThinkMark in chat.css) rather than in SMIL
 * so `prefers-reduced-motion` can stop it, which SMIL cannot honour.
 */
export function ThinkingMark({ size = 16, className, label }: ThinkingMarkProps) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");

  return (
    <svg
      className={["nmThinkMark", className].filter(Boolean).join(" ")}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role={label ? "img" : undefined}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      focusable="false"
    >
      {label ? <title>{label}</title> : null}
      <defs>
        <linearGradient id={`thinkArc${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.15" />
          <stop offset="55%" stopColor="currentColor" stopOpacity="1" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0.15" />
        </linearGradient>
      </defs>
      {/* Outer sweep, clockwise. */}
      <circle
        className="nmThinkArcOuter"
        cx="12"
        cy="12"
        r="9.2"
        fill="none"
        stroke={`url(#thinkArc${id})`}
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeDasharray="30 28"
      />
      {/* Inner sweep, counter-clockwise and slower, so the two never lock into
          one rigid rotation. */}
      <circle
        className="nmThinkArcInner"
        cx="12"
        cy="12"
        r="5.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeDasharray="10 24"
        opacity="0.55"
      />
      <circle className="nmThinkCore" cx="12" cy="12" r="2.1" fill="currentColor" />
    </svg>
  );
}
