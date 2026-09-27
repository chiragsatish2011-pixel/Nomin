import type { NodeKind, NodeState } from "./events.js";

/**
 * Nomin Code runs on the Kraken design system: white surfaces, Kraken Purple
 * as the primary, 12px radii, Kraken-Brand / Kraken-Product type.
 *
 * `aurora` is the one addition — a moving purple gradient used for
 * anything that is *live* (the thinking head, an active branch). It is drawn
 * from the Kraken purple scale so it reads as brand energy, not decoration.
 */
export interface Theme {
  name: string;
  surface: string;
  surfaceSoft: string;
  hairline: string;
  ink: string;
  muted: string;
  mutedSoft: string;
  accent: string;
  /** Aurora gradient stops (`at` = 0..1 along one sweep), used for live work. */
  aurora: Array<{ at: number; color: string }>;
  /** Glow tint behind the thinking head. */
  glow: string;
  states: Record<NodeState, string>;
  fontDisplay: string;
  fontUi: string;
  fontMono: string;
}

export const krakenAurora: Theme = {
  name: "kraken-aurora",
  surface: "#ffffff",
  surfaceSoft: "#faf7ff",
  hairline: "#ddd6f0",
  ink: "#16102a",
  muted: "#4b4463",
  mutedSoft: "#8b83ad",
  accent: "#7132f5",
  aurora: [
    { at: 0, color: "#7132f5" },
    { at: 0.34, color: "#9a6dff" },
    { at: 0.58, color: "#4a14b5" },
    { at: 0.8, color: "#b79cff" },
    { at: 1, color: "#7132f5" },
  ],
  glow: "rgba(154,109,255,0.30)",
  states: {
    pending: "#8b83ad",
    active: "#7132f5",
    waiting: "#6b4ae0",
    done: "#5b28c9",
    failed: "#c93a3a",
  },
  fontDisplay: '"Kraken-Brand", "IBM Plex Sans", Helvetica, Arial, sans-serif',
  fontUi: '"Kraken-Product", "IBM Plex Sans", "Helvetica Neue", Helvetica, Arial, sans-serif',
  fontMono: '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
};

/** Dark variant of the same system — same purple, inverted surfaces. */
export const krakenDark: Theme = {
  ...krakenAurora,
  name: "kraken-aurora-dark",
  surface: "#191130",
  surfaceSoft: "#120c22",
  hairline: "#2c2247",
  ink: "#f4f1fc",
  muted: "#a49cc4",
  mutedSoft: "#766e96",
  aurora: [
    { at: 0, color: "#9a6dff" },
    { at: 0.34, color: "#c0a6ff" },
    { at: 0.58, color: "#7132f5" },
    { at: 0.82, color: "#b79cff" },
    { at: 1, color: "#9a6dff" },
  ],
  glow: "rgba(154,109,255,0.42)",
  states: {
    pending: "#766e96",
    active: "#9a6dff",
    waiting: "#8464ef",
    done: "#b79cff",
    failed: "#e05a5a",
  },
};

/** Geometry — built on the Kraken spacing scale. */
export const metrics = {
  padTop: 28,
  padLeft: 40,
  rowHeight: 34,
  indent: 34,
  /** Horizontal run from the spine to the node dot. */
  stub: 26,
  dotRadius: 4.5,
  rootRadius: 24,
  labelGap: 15,
  minWidth: 420,
};

/** Motion timings, in ms. Slow enough to read, quick enough to feel live. */
export const motion = {
  rowSettle: 420,
  draw: 460,
  fade: 320,
  pulse: 1900,
  stagger: 70,
  /** Seconds for one full sweep of the aurora gradient. */
  auroraSweep: 7,
};

const GLYPH: Record<NodeKind, string> = {
  task: "◆",
  question: "?",
  plan: "▣",
  thinking: "✳",
  step: "•",
  tool: "▸",
  file: "▤",
  command: "$",
  build: "⬡",
  test: "◇",
  cooldown: "⏳",
  verify: "✓",
  artifact: "◈",
  doctor: "✚",
};

export const glyphFor = (kind: NodeKind) => GLYPH[kind] ?? "•";
