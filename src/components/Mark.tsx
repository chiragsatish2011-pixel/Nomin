/**
 * The Nomin mark.
 *
 * A single glyph built from the work tree itself: a head node with two
 * branches descending from it. It is the product's own diagram at 24px — quiet
 * at rest, and the branches light with the aurora while the agent is working.
 */
export function Mark({ size = 28, busy = false }: { size?: number; busy?: boolean }) {
  const id = `mark-${size}${busy ? "-busy" : ""}`;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-a`} x1="4" y1="4" x2="28" y2="28" gradientUnits="userSpaceOnUse">
          <stop stopColor="#855bfb" />
          <stop offset="0.6" stopColor="#7132f5" />
          <stop offset="1" stopColor="#2ed3c6" />
        </linearGradient>
      </defs>

      <rect x="0.5" y="0.5" width="31" height="31" rx="9" fill="var(--purple-subtle)" />

      {/* spine */}
      <path
        d="M11 9v11a2 2 0 0 0 2 2h2"
        stroke={`url(#${id}-a)`}
        strokeWidth="1.6"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M11 14h3"
        stroke="var(--muted-soft)"
        strokeWidth="1.6"
        strokeLinecap="round"
        fill="none"
      />

      {/* head and branch nodes */}
      <circle cx="11" cy="8" r="3" fill={`url(#${id}-a)`}>
        {busy && (
          <animate attributeName="r" values="3;3.6;3" dur="1.8s" repeatCount="indefinite" />
        )}
      </circle>
      <circle cx="16" cy="14" r="2" fill="var(--muted-soft)" />
      <circle cx="17" cy="22" r="2" fill={`url(#${id}-a)`}>
        {busy && (
          <animate attributeName="opacity" values="1;0.35;1" dur="1.8s" repeatCount="indefinite" />
        )}
      </circle>
    </svg>
  );
}
