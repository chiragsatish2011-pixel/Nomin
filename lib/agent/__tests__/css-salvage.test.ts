import { describe, expect, it } from "vitest";
import { salvageCssPrefix } from "../executor/step-runner";

describe("CSS length-boundary recovery", () => {
  it("keeps complete top-level rules and drops an unfinished nested block", () => {
    const truncated = ":root { --ink: #111; }\n.hero { color: var(--ink); }\n@media (max-width: 700px) {\n  .hero { padding: 2rem; }";
    expect(salvageCssPrefix(truncated)).toBe(":root { --ink: #111; }\n.hero { color: var(--ink); }\n");
  });

  it("does not count braces inside strings or comments", () => {
    const css = `.label::after { content: "}"; }\n/* { ignored } */\n.card { display: grid; }`;
    expect(salvageCssPrefix(css)).toBe(`${css}\n`);
  });
});
