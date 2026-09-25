import { useEffect, useRef } from "react";

/**
 * The thinking orb — a sphere of particles that breathes, turns and ripples
 * while Trion is working, and settles into a slow drift when it is not.
 *
 * It is drawn as real SVG circles (not canvas) so it stays crisp at any size
 * and inherits the page's colour tokens. Points are placed on a Fibonacci
 * sphere, displaced by layered sine waves, then projected — the same idea as
 * a vertex shader, done cheaply enough for a UI element.
 */
export function ParticleOrb({
  size = 72,
  active = true,
  count = 420,
}: {
  size?: number;
  active?: boolean;
  count?: number;
}) {
  const groupRef = useRef<SVGGElement>(null);
  const dotsRef = useRef<SVGCircleElement[]>([]);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const dots = dotsRef.current;
    if (!dots.length) return;

    const reduced =
      typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Fibonacci sphere: evenly spread points, no clustering at the poles.
    const golden = Math.PI * (3 - Math.sqrt(5));
    const base = Array.from({ length: dots.length }, (_, i) => {
      const y = 1 - (i / (dots.length - 1)) * 2;
      const ring = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = golden * i;
      return { x: Math.cos(theta) * ring, y, z: Math.sin(theta) * ring };
    });

    let frame = 0;
    let spin = 0;
    let last = performance.now();

    const render = (now: number) => {
      frame = requestAnimationFrame(render);
      const dt = Math.min(now - last, 50);
      last = now;

      const live = activeRef.current;
      const t = now / 1000;
      spin += (dt / 1000) * (live ? 0.55 : 0.16);
      const cos = Math.cos(spin);
      const sin = Math.sin(spin);
      const tilt = Math.sin(t * 0.25) * 0.28;
      const amp = live ? 0.16 : 0.06;

      for (let i = 0; i < base.length; i++) {
        const point = base[i]!;
        const dot = dots[i]!;

        // Layered ripples — the surface never repeats exactly.
        const wobble =
          1 +
          amp * Math.sin(point.y * 4.2 + t * 1.6) +
          amp * 0.7 * Math.sin(point.x * 3.6 - t * 1.1) +
          amp * 0.5 * Math.sin(point.z * 5.1 + t * 0.8);

        const x = point.x * wobble;
        const y = point.y * wobble;
        const z = point.z * wobble;

        // Rotate about Y, then tip slightly about X.
        const rx = x * cos - z * sin;
        const rz = x * sin + z * cos;
        const ry = y * Math.cos(tilt) - rz * Math.sin(tilt);
        const depth = y * Math.sin(tilt) + rz * Math.cos(tilt);

        // Weak perspective: near particles sit larger and brighter.
        const scale = 1 / (1.9 - depth * 0.55);
        dot.setAttribute("cx", (rx * 46 * scale).toFixed(2));
        dot.setAttribute("cy", (ry * 46 * scale).toFixed(2));
        dot.setAttribute("r", (0.62 + (depth + 1) * 0.55).toFixed(2));
        dot.setAttribute("opacity", (0.16 + (depth + 1) * 0.36).toFixed(3));
      }

      if (reduced) cancelAnimationFrame(frame);
    };

    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, []);

  const uid = `orb-${size}`;
  return (
    <svg
      className={`orb${active ? " live" : ""}`}
      width={size}
      height={size}
      viewBox="-60 -60 120 120"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={`${uid}-grad`} x1="-50" y1="-50" x2="50" y2="50" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#2ed3c6" />
          <stop offset="45%" stopColor="#7132f5" />
          <stop offset="100%" stopColor="#a07dff" />
        </linearGradient>
        <radialGradient id={`${uid}-halo`}>
          <stop offset="40%" stopColor="rgba(113,50,245,0.28)" />
          <stop offset="100%" stopColor="rgba(113,50,245,0)" />
        </radialGradient>
      </defs>

      <circle r="54" fill={`url(#${uid}-halo)`} className="orb-halo" />
      <g ref={groupRef} fill={`url(#${uid}-grad)`}>
        {Array.from({ length: count }, (_, i) => (
          <circle
            key={i}
            r="1"
            ref={(node) => {
              if (node) dotsRef.current[i] = node;
            }}
          />
        ))}
      </g>
    </svg>
  );
}
