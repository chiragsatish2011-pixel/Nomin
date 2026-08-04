"use client";

import { LandingJellyfish } from "./LandingJellyfish";

type JellyfishMarkProps = {
  size?: number;
  className?: string;
  title?: string;
  motion?: "full" | "minimal";
};

/** One mark everywhere: landing, boot, sidebar, thinker and browser icon all
 * derive from the same outlined Nomin jellyfish language. */
export function JellyfishMark({ size = 40, className, title, motion = "minimal" }: JellyfishMarkProps) {
  return <LandingJellyfish size={size} className={className} title={title} motion={motion} />;
}
