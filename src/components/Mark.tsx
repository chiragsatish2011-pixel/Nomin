/**
 * The Nomin mark — the official logo file, and nothing around it.
 *
 * `public/logo-mark.png` is the supplied artwork with its transparent padding
 * trimmed and re-centred: every pixel of the glyph is the original file's.
 * There is no tile, plate or placeholder behind it.
 *
 * The supplied glyph is white, which is what dark mode shows. Light mode is
 * served the same file in black. The alpha channel — and therefore the shape —
 * is byte-identical between the two; only the ink differs, so the mark reads on
 * either background without anything being drawn around it or redrawn.
 */
export function Mark({
  size = 28,
  busy = false,
  className = "",
}: {
  size?: number;
  busy?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`mark${busy ? " busy" : ""}${className ? ` ${className}` : ""}`}
      style={{ width: size, height: size }}
      aria-label="Nomin"
      role="img"
    >
      <img className="mark-img" src="/logo-mark.png" alt="" aria-hidden="true" draggable={false} />
    </span>
  );
}

/**
 * The mark as a watermark: very large, very faint, sitting behind the page's
 * own content rather than beside it. Same file, same shape — only the scale
 * and the opacity change, and it is masked out towards the bottom so it fades
 * into the page instead of ending on a hard edge.
 */
export function MarkWatermark({ size = 380 }: { size?: number }) {
  return (
    <div className="mark-watermark" style={{ width: size, height: size }} aria-hidden="true">
      <img className="mark-img" src="/logo-mark.png" alt="" draggable={false} />
    </div>
  );
}
