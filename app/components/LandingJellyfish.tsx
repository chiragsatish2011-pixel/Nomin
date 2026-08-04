"use client";

import { useId } from "react";

type LandingJellyfishProps = {
  size?: number;
  className?: string;
  title?: string;
  motion?: "full" | "minimal";
};

/** The Nomin cap mark. It is intentionally compact and uses the same geometry
 * for landing, boot, navigation, status, and the browser icon. */
export function LandingJellyfish({ size = 190, className, title, motion = "minimal" }: LandingJellyfishProps) {
  const rawId = useId().replace(/[^a-zA-Z0-9]/g, "");
  const bellId = `nominBell${rawId}`;

  return (
    <svg
      className={className}
      height={size}
      width={size}
      viewBox="0 0 40 44"
      role="img"
      aria-hidden={title ? undefined : true}
      aria-label={title}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      <defs>
        <linearGradient id={bellId} x1="8%" y1="82%" x2="91%" y2="8%">
          <stop offset="0%" stopColor="var(--jelly-violet)" />
          <stop offset="48%" stopColor="var(--jelly-shell)" />
          <stop offset="100%" stopColor="var(--jelly-aqua)" />
        </linearGradient>
      </defs>
      <g className={motion === "full" ? "nominSwim full" : "nominSwim minimal"} transform="translate(0 1)" fill="none" stroke="var(--jelly-outline)" strokeLinecap="round" strokeLinejoin="round">

        <path
          d="M 4.5 16.8 C 4.5 8.5 10.5 4.1 20 4.1 C 29.5 4.1 35.5 8.5 35.5 16.8 C 35.5 22.3 32.3 25.1 28.6 22.3 C 26.1 25.1 22.9 25.3 20 22.4 C 17.1 25.3 13.9 25.1 11.4 22.3 C 7.7 25.1 4.5 22.3 4.5 16.8 Z"
          fill={`url(#${bellId})`}
          strokeWidth="1.45"
        />
        <path d="M 7.4 13.3 C 9.6 8.4 15 6.6 20.4 6.8" opacity="0.28" stroke="var(--jelly-highlight)" strokeWidth="1.2" />

        <g transform="translate(14.2 15.2)">
          <g className="nominEye nominEyeLeft" fill="var(--jelly-eye)" stroke="none">
            <circle r="2.45" />
            <circle cx="-0.75" cy="-0.82" r="0.72" fill="var(--jelly-highlight)" />
          </g>
        </g>
        <g transform="translate(25.8 15.2)">
          <g className="nominEye nominEyeRight" fill="var(--jelly-eye)" stroke="none">
            <circle r="2.45" />
            <circle cx="-0.75" cy="-0.82" r="0.72" fill="var(--jelly-highlight)" />
          </g>
        </g>

        <g className="nominTentacles" fill="none" strokeWidth="1.15">
          <path className="nominTentacle t1" d="M 9.8 23 C 8.7 27.2 11.1 29.2 9.1 33.2 C 7.9 35.7 8.1 38.3 9.5 40.5" />
          <path className="nominTentacle t2" d="M 14.8 23.6 C 16.2 27.3 12.6 30.1 14.4 33.7 C 15.8 36.4 13.3 38.7 12.8 41.2" />
          <path className="nominTentacle t3" d="M 20 23.5 C 18.3 27.3 21.9 30.5 20 34.2 C 18.5 37 20.4 39.2 20 42" />
          <path className="nominTentacle t4" d="M 25.2 23.6 C 23.9 27.5 27.2 30 25.5 33.9 C 24.2 36.8 27 38.8 27.1 41.4" />
          <path className="nominTentacle t5" d="M 30.2 23 C 31.4 26.7 28.8 29.5 30.9 33.1 C 32.4 35.8 31.8 38.2 30.4 40.4" />
        </g>

      </g>
    </svg>
  );
}
