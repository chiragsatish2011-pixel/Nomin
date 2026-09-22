"use client";

import { useId } from "react";

type NominMarkProps = {
  size?: number;
  className?: string;
  title?: string;
};

/**
 * The Nomin mark.
 *
 * A node graph, not a mascot: a decision point with three connected outcomes,
 * which is what this product actually is. The previous mark was an illustrated
 * jellyfish — charming at 112px on a landing screen, unreadable at the 20px the
 * interface mostly renders a mark at, and reading as a character rather than as
 * a tool sitting beside a code panel.
 *
 * Built to survive the small sizes: one enclosing shape, four nodes, three
 * strokes, no gradients below the container, and stroke widths that stay above
 * a device pixel down to 16px.
 */
export function NominMark({ size = 28, className, title }: NominMarkProps) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-hidden={title ? undefined : true}
      aria-label={title}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      <defs>
        <linearGradient id={`nominFill${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--mark-from, #855bfb)" />
          <stop offset="100%" stopColor="var(--mark-to, #5b1ecf)" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="32" height="32" rx="9" fill={`url(#nominFill${id})`} />
      {/* The three connections, drawn under the nodes so the joins stay clean. */}
      <g stroke="#fff" strokeWidth="1.7" strokeLinecap="round" opacity="0.9">
        <path d="M16 11.5 L9.5 20.5" />
        <path d="M16 11.5 L22.5 20.5" />
        <path d="M16 11.5 L16 20.5" />
      </g>
      <g fill="#fff">
        <circle cx="16" cy="10" r="3.1" />
        <circle cx="9.5" cy="21.5" r="2.3" />
        <circle cx="16" cy="21.5" r="2.3" />
        <circle cx="22.5" cy="21.5" r="2.3" />
      </g>
    </svg>
  );
}
