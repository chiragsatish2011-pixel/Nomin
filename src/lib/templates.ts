/**
 * Templates: a starting brief, not a starting file.
 *
 * A template here is a *prompt* — the same kind of brief that gets a good
 * result out of the agent when a person writes one by hand, written once and
 * kept. Clicking a card puts that brief in the message box, where it can be
 * edited before it is sent: it is a draft the user owns, never something that
 * runs behind their back.
 *
 * Each brief is deliberately specific about the things a model gets wrong when
 * left to its own devices — real copy instead of lorem ipsum, a named type
 * scale, a stated palette, what must not appear, and how the result will be
 * checked. Vague briefs are what produce the grey skeleton with three
 * placeholder cards, and that is exactly what the manager sends back.
 */

export interface TemplateCategory {
  id: string;
  label: string;
}

export interface Template {
  id: string;
  category: string;
  title: string;
  /** One line under the title. */
  blurb: string;
  /** The brief that lands in the message box. */
  prompt: string;
  /** The look, as tokens. The card preview is rendered from these. */
  look: {
    background: string;
    ink: string;
    accent: string;
    muted: string;
    /** Display face for the preview's headline. */
    display: string;
    /** How the preview lays itself out. */
    shape: "hero" | "split" | "grid" | "article" | "board" | "play";
    headline: string;
    sub: string;
  };
}

export const CATEGORIES: TemplateCategory[] = [
  { id: "landing", label: "Landing page" },
  { id: "app", label: "Web app" },
  { id: "dashboard", label: "Dashboard" },
  { id: "game", label: "Mini game" },
  { id: "writing", label: "Personal site" },
];

/** The shared discipline every brief ends with. Written once, appended once. */
const CRAFT = `Build it as real files in the workspace, not as code pasted into the reply.

Hold this standard:
- Real copy everywhere. No lorem ipsum, no "Feature one / Feature two", no empty sections left as headings.
- One type scale and stick to it. One accent colour, used sparingly.
- Responsive from 360px up. Nothing overlapping, nothing clipped, no horizontal scroll.
- Accessible: real landmarks, alt text, visible focus rings, at least 4.5:1 on body text.
- Motion only where it explains something. No animation longer than 400ms.
- Every interactive control actually does something. A button that does nothing is a bug, not a placeholder.

When you are done, run it, look at what it renders, and fix anything that is a skeleton before you report.`;

export const TEMPLATES: Template[] = [
  {
    id: "forge",
    category: "landing",
    title: "Built by discipline",
    blurb: "A dark, typographic landing page for a strength gym",
    look: {
      background: "#141414",
      ink: "#f5f3ef",
      accent: "#ff5a1f",
      muted: "#8d8880",
      display: "'Arial Black', 'Helvetica Neue', sans-serif",
      shape: "hero",
      headline: "BUILT BY DISCIPLINE.\nFORGED IN IRON.",
      sub: "A private strength gym in Bengaluru for people who train seriously.",
    },
    prompt: `Build a single-page site for a private strength gym called Iron Standard, in Bengaluru.

Voice: blunt, confident, no hype. It is a serious gym for people who already train, not a chain selling memberships.

Look: near-black background (#141414), warm off-white text (#f5f3ef), one orange accent (#ff5a1f) used only on the word that matters in the headline, the primary button, and rules between sections. Heavy condensed sans for headlines set very large and tight (clamp from 2.6rem to 6rem, line-height 0.95, letter-spacing -0.02em); plain readable sans at 17px for body.

Sections, in this order:
1. Hero — headline "BUILT BY DISCIPLINE. FORGED IN IRON.", with only "IRON" in the accent. One line of sub-copy, one primary button "Book a trial session".
2. What this is — three short paragraphs, not cards: the equipment, the coaching, who it is not for.
3. Programmes — three real programmes with a name, who it suits, session length and price in rupees.
4. The coaches — two coaches with a name, a credential and one sentence each.
5. Hours and location — a real-looking address in Indiranagar, opening hours as a proper table.
6. Footer — one line, a phone number, an Instagram handle.

Use CSS gradients and solid blocks for imagery. Do not hotlink photographs you cannot verify, and never leave a broken image.

${CRAFT}`,
  },
  {
    id: "stillwater",
    category: "landing",
    title: "Stillwater",
    blurb: "A calm, editorial page for a lakeside retreat",
    look: {
      background: "#eae6de",
      ink: "#22201c",
      accent: "#5b6b52",
      muted: "#7c766c",
      display: "'Georgia', 'Times New Roman', serif",
      shape: "split",
      headline: "Stillwater",
      sub: "Four cabins, one lake, and nothing scheduled.",
    },
    prompt: `Build a single-page site for Stillwater, a four-cabin retreat on a lake in the Nilgiris.

Voice: quiet and unhurried. Short sentences. It sells stillness, not activities.

Look: warm paper background (#eae6de), near-black ink (#22201c), a muted green accent (#5b6b52). A serif display face for headings, set large with generous leading; a plain sans at 17px for body. Wide margins — the page should feel like a printed page, with content capped around 68 characters.

Sections, in this order:
1. Hero — the word "Stillwater" set very large over a soft gradient standing in for the lake, one line beneath: "Four cabins, one lake, and nothing scheduled."
2. The cabins — four cabins, each with a name, sleeping capacity, and one honest sentence. No stock adjectives like "luxurious" or "breathtaking".
3. A day here — a short prose paragraph describing an actual day, morning to night. Prose, not bullet points.
4. What is not here — a deliberately short list of what the retreat does not have (no wifi in the cabins, no restaurant, no pool). This is the selling point; treat it that way.
5. Rates and booking — a real table of rates per night by season, and a booking form with name, email, dates and number of guests. Validate the form and show a real confirmation state.
6. Footer — how to get there, in two sentences.

Use CSS gradients and colour blocks for imagery rather than hotlinked photographs.

${CRAFT}`,
  },
  {
    id: "ledger",
    category: "app",
    title: "Split the bill",
    blurb: "A working expense splitter that survives a reload",
    look: {
      background: "#ffffff",
      ink: "#12131a",
      accent: "#3b5bdb",
      muted: "#6b7280",
      display: "'Inter', 'Helvetica Neue', sans-serif",
      shape: "grid",
      headline: "Who owes what",
      sub: "Add people, add expenses, settle up in the fewest transfers.",
    },
    prompt: `Build a working shared-expense splitter — the kind of thing a group uses after a trip.

It must actually work, not mock the interaction:
- Add and remove people.
- Add an expense: description, amount, who paid, and who it is split between. Support an even split and exact amounts.
- Show a running balance per person — who is up, who is down — that always sums to zero.
- Settle up: compute the minimum set of transfers that clears every balance, and show them as a plain list ("Asha pays Ravi ₹420").
- Everything persists to localStorage, wrapped in try/catch so a blocked-storage browser still works with an in-memory fallback.
- Edit and delete any expense, with the balances updating immediately.

Look: white, one blue accent (#3b5bdb), near-black text. Amounts in a tabular-figures font so columns line up. Negative balances in red, positive in green, and never colour alone — always a sign as well.

Handle the awkward cases properly: rounding so the splits sum exactly to the total, an expense paid by someone who is not in the split, a person with no expenses, and an empty state that explains what to do first.

${CRAFT}`,
  },
  {
    id: "pulse",
    category: "dashboard",
    title: "Service health",
    blurb: "A dense operations dashboard with real charts",
    look: {
      background: "#0d1117",
      ink: "#e6edf3",
      accent: "#2f81f7",
      muted: "#7d8590",
      display: "'Inter', 'Helvetica Neue', sans-serif",
      shape: "board",
      headline: "All systems nominal",
      sub: "p99 latency 240ms · error rate 0.04% · 14 services",
    },
    prompt: `Build an operations dashboard for a fictional service called Relay — the view an on-call engineer actually looks at.

Data: generate a realistic seeded dataset in the page (24 hours, one point per minute) so the charts have real shape rather than smooth noise — include a latency spike around 03:10 and a short error burst after it, so the page has something to show.

Panels:
1. A status strip: overall state, p50/p95/p99 latency, error rate, requests per second. Each one a number with its unit and a small sparkline.
2. Request volume over 24h — an area chart with a readable time axis.
3. Latency percentiles — a line chart with p50, p95 and p99 as three distinguishable series, each labelled directly on the line rather than in a legend far away.
4. Errors by service — a horizontal bar chart, sorted, top eight services.
5. Recent incidents — a table with time, service, severity and one-line description. Sortable by column.

Draw the charts yourself with inline SVG or canvas. Do not pull in a charting library from a CDN.

Look: dark (#0d1117), one blue accent (#2f81f7), grey text for anything secondary. Grid lines barely visible. Numbers in tabular figures. Severity shown with a shape or label as well as colour, never colour alone.

Hover on any chart shows a tooltip with the exact value and timestamp at that point.

${CRAFT}`,
  },
  {
    id: "orbit",
    category: "game",
    title: "Orbit",
    blurb: "A one-button arcade game with real physics",
    look: {
      background: "#07060f",
      ink: "#ffffff",
      accent: "#7132f5",
      muted: "#7b7594",
      display: "'Inter', 'Helvetica Neue', sans-serif",
      shape: "play",
      headline: "ORBIT",
      sub: "Hold to pull in. Release to fly. Don't hit anything.",
    },
    prompt: `Build a one-button arcade game called Orbit that runs in a canvas and is genuinely playable.

Rules: a ship travels forward continuously. Holding the mouse button (or space, or a touch) attaches it to the nearest anchor point and it swings around that anchor under gravity; releasing lets it fly off on its tangent. Anchors scroll past. Hitting an obstacle ends the run. Distance is the score.

It must actually work as a game:
- A real fixed-timestep game loop with the physics decoupled from the frame rate.
- Circular-motion physics that feel right — angular velocity conserved on attach, tangential velocity on release.
- Procedurally generated course that gets harder with distance, and is always survivable.
- Start screen, playing state, game-over state with the score and a restart, and a high score kept in localStorage.
- Keyboard, mouse and touch all work.
- Pauses when the tab is hidden, and resumes without a physics jump.

Look: near-black (#07060f), the ship and anchors in white, the tether line in purple (#7132f5). Score in the corner in tabular figures. A short particle trail behind the ship. No sound.

Tune the difficulty so a first run lasts about 20 seconds and a good one lasts a couple of minutes.

${CRAFT}`,
  },
  {
    id: "margin",
    category: "writing",
    title: "Margin",
    blurb: "A writer's site that treats reading as the feature",
    look: {
      background: "#fdfcfa",
      ink: "#1a1a1a",
      accent: "#9a3412",
      muted: "#6b6660",
      display: "'Georgia', 'Times New Roman', serif",
      shape: "article",
      headline: "Margin",
      sub: "Essays on software, cities and the things that connect them.",
    },
    prompt: `Build a personal writing site called Margin, for someone who writes essays about software and cities.

Pages, as separate files that link to each other:
1. index.html — the essay index: a title, one line about the writer, then the essays as a list with title, date and a one-sentence standfirst. Newest first. No cards, no thumbnails — a list.
2. essay.html — one full essay, written out properly. Write around 900 words of genuine prose on "Why cities are bad at software and software is bad at cities". It must read as a real essay with an argument, not filler.
3. about.html — three short paragraphs and a way to get in touch.

Reading is the feature:
- Measure capped at 68 characters. 19px body, 1.65 line-height.
- A serif for the prose, a sans only for navigation and metadata.
- Proper typography: real em dashes, curly quotes, hanging punctuation on blockquotes, small caps for the date line.
- A thin reading-progress bar at the top of the essay.
- Footnotes that link both ways and are reachable by keyboard.
- Dark mode that follows prefers-color-scheme and is genuinely designed, not inverted.
- Prints cleanly: a print stylesheet that drops the navigation and sets the body in a serif at 11pt.

One accent colour (#9a3412), used for links and nothing else.

${CRAFT}`,
  },
];

export const templatesIn = (category: string) =>
  TEMPLATES.filter((template) => template.category === category);
