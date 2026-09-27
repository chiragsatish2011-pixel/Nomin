/**
 * The Nomin mark — the official logo file, and nothing around it.
 *
 * `public/logo-mark.png` is the supplied artwork with its transparent padding
 * trimmed and re-centred: every pixel of the glyph is the original file's.
 * There is no tile, plate or placeholder behind it — the mark stands on the
 * page on its own.
 *
 * The supplied glyph is white, which disappears on a light background, so the
 * light theme is served the same file with its ink set to the brand purple.
 * The alpha channel — and therefore the shape — is byte-identical between the
 * two; only the colour of the ink differs. Nothing is redrawn.
 */
export function Mark({ size = 28, busy = false }: { size?: number; busy?: boolean }) {
  return (
    <span
      className={`mark${busy ? " busy" : ""}`}
      style={{ width: size, height: size }}
      aria-label="Nomin"
      role="img"
    >
      <img className="mark-light" src="/logo-mark-purple.png" alt="" aria-hidden="true" draggable={false} />
      <img className="mark-dark" src="/logo-mark.png" alt="" aria-hidden="true" draggable={false} />
    </span>
  );
}
