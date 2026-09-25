/**
 * The hand-drawn "ball of thought" at the head of the tree — the scribbled
 * blob from the original sketch, redrawn as a deterministic SVG path so it can
 * be animated (drawn on, rotated, pulsed) instead of sitting there as a static
 * lump.
 */

/** Deterministic PRNG so the blob is identical on every render. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 10000) / 10000;
  };
}

/**
 * A continuous scribble: overlapping wobbly loops around the origin, drawn in
 * one stroke so `stroke-dasharray` can draw it like a pen.
 */
export function scribblePath(radius: number, loops = 11, seed = 7): string {
  const rand = rng(seed);
  const segments = 9;
  let d = "";
  for (let loop = 0; loop < loops; loop++) {
    const tilt = (loop / loops) * Math.PI * 2;
    const rx = radius * (0.55 + 0.45 * rand());
    const ry = radius * (0.55 + 0.45 * rand());
    const pts: Array<[number, number]> = [];
    for (let i = 0; i <= segments; i++) {
      const a = tilt + (i / segments) * Math.PI * 2;
      const wobble = 0.9 + rand() * 0.2;
      pts.push([Math.cos(a) * rx * wobble, Math.sin(a) * ry * wobble]);
    }
    d += (loop === 0 ? "M" : "L") + fmt(pts[0]!);
    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i - 1]!;
      const cur = pts[i]!;
      const cx = (prev[0] + cur[0]) / 2 - (cur[1] - prev[1]) * 0.28;
      const cy = (prev[1] + cur[1]) / 2 + (cur[0] - prev[0]) * 0.28;
      d += `Q${cx.toFixed(1)},${cy.toFixed(1)} ${fmt(cur)}`;
    }
  }
  return d;
}

const fmt = (p: [number, number]) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;
