import { useState } from "react";
import { CATEGORIES, templatesIn, type Template } from "../lib/templates.js";

/**
 * The template gallery on the welcome screen.
 *
 * Each card previews the look its brief asks for and, when clicked, puts that
 * brief in the message box. It never sends on its own: a template is a draft
 * the user can read and change before committing a build to it, which is the
 * difference between a starting point and a surprise.
 *
 * The previews are rendered from the same tokens the brief states — the
 * background, the ink, the accent, the display face. They are a real rendering
 * of the style being offered, not a screenshot of something else.
 */
export function Templates({ onPick }: { onPick: (prompt: string) => void }) {
  const [category, setCategory] = useState(CATEGORIES[0]!.id);
  const shown = templatesIn(category);

  return (
    <section className="templates">
      <nav className="template-tabs" aria-label="Template categories">
        {CATEGORIES.map((item) => (
          <button
            key={item.id}
            type="button"
            className={item.id === category ? "on" : ""}
            aria-pressed={item.id === category}
            onClick={() => setCategory(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <ul className="template-cards">
        {shown.map((template) => (
          <li key={template.id}>
            <button
              type="button"
              className="template-card"
              onClick={() => onPick(template.prompt)}
              title="Put this brief in the message box"
            >
              <Preview template={template} />
              <span className="template-meta">
                <span className="template-title">{template.title}</span>
                <span className="template-blurb">{template.blurb}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="template-note">
        Picking one writes its brief into the box. Read it, change anything, then send.
      </p>
    </section>
  );
}

/** A small rendering of the style the brief asks for. */
function Preview({ template }: { template: Template }) {
  const { look } = template;
  const style = {
    background: look.background,
    color: look.ink,
    fontFamily: look.display,
  } as const;

  return (
    <span className={`template-preview shape-${look.shape}`} style={style} aria-hidden="true">
      <span className="tp-bar" style={{ borderColor: fade(look.muted) }}>
        <i style={{ background: look.accent }} />
        <i style={{ background: fade(look.muted) }} />
        <i style={{ background: fade(look.muted) }} />
      </span>

      {look.shape === "board" ? (
        <BoardPreview template={template} />
      ) : look.shape === "play" ? (
        <PlayPreview template={template} />
      ) : look.shape === "grid" ? (
        <GridPreview template={template} />
      ) : (
        <span className="tp-body">
          <span className="tp-head">
            {look.headline.split("\n").map((line, i) => (
              <span key={i} className="tp-line">
                {accented(line, look.accent)}
              </span>
            ))}
          </span>
          <span className="tp-sub" style={{ color: look.muted }}>
            {look.sub}
          </span>
          {look.shape === "article" ? (
            <span className="tp-rules">
              {[92, 84, 88, 60].map((width, i) => (
                <i key={i} style={{ width: `${width}%`, background: fade(look.muted) }} />
              ))}
            </span>
          ) : (
            <span className="tp-cta" style={{ background: look.accent, color: look.background }}>
              Start
            </span>
          )}
        </span>
      )}
    </span>
  );
}

function BoardPreview({ template: { look } }: { template: Template }) {
  const bars = [62, 40, 78, 34, 55, 90, 48, 70];
  return (
    <span className="tp-body">
      <span className="tp-head tp-head-sm">{look.headline}</span>
      <span className="tp-sub" style={{ color: look.muted }}>
        {look.sub}
      </span>
      <span className="tp-chart">
        {bars.map((height, i) => (
          <i
            key={i}
            style={{
              height: `${height}%`,
              background: i === 5 ? look.accent : fade(look.muted, 0.5),
            }}
          />
        ))}
      </span>
    </span>
  );
}

function PlayPreview({ template: { look } }: { template: Template }) {
  return (
    <span className="tp-body tp-centre">
      <span className="tp-orbit" style={{ borderColor: fade(look.accent, 0.5) }}>
        <i style={{ background: look.accent }} />
      </span>
      <span className="tp-head tp-head-wide">{look.headline}</span>
      <span className="tp-sub" style={{ color: look.muted }}>
        {look.sub}
      </span>
    </span>
  );
}

function GridPreview({ template: { look } }: { template: Template }) {
  const rows: Array<[string, string]> = [
    ["Asha", "+₹1,240"],
    ["Ravi", "−₹420"],
    ["Meera", "−₹820"],
  ];
  return (
    <span className="tp-body">
      <span className="tp-head tp-head-sm">{look.headline}</span>
      <span className="tp-rows">
        {rows.map(([name, amount]) => (
          <span key={name} className="tp-row" style={{ borderColor: fade(look.muted) }}>
            <em>{name}</em>
            <b style={{ color: amount.startsWith("+") ? look.accent : look.ink }}>{amount}</b>
          </span>
        ))}
      </span>
    </span>
  );
}

/** The last word of a headline carries the accent, as the briefs ask. */
function accented(line: string, accent: string) {
  const words = line.trim().split(" ");
  if (words.length < 2) return <em style={{ color: accent }}>{line}</em>;
  const last = words.pop()!;
  return (
    <>
      {words.join(" ")} <em style={{ color: accent }}>{last}</em>
    </>
  );
}

/** A colour at low opacity, without needing to know its format. */
const fade = (color: string, alpha = 0.28) =>
  `color-mix(in oklab, ${color} ${Math.round(alpha * 100)}%, transparent)`;
