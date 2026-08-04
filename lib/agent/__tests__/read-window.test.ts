import { describe, expect, it } from "vitest";
import { MAX_READ_LINES, selectReadWindow } from "@/app/lib/read-window";

const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");

describe("selectReadWindow", () => {
  it("returns small files intact", () => {
    const result = selectReadWindow(lines(3));
    expect(result).toMatchObject({ content: lines(3), totalLines: 3 });
    expect(result).not.toHaveProperty("truncated");
  });

  it("returns an outline rather than a whole large file", () => {
    const result = selectReadWindow(lines(500));
    expect(result).toMatchObject({ totalLines: 500, truncated: true });
    expect(result.content).toContain("[Lines 1–80]");
    expect(result.content).toContain("[Lines 421–500]");
    expect(result.content).not.toContain("line 250");
  });

  it("returns an exact focused range", () => {
    const result = selectReadWindow(lines(500), 210, 215);
    expect(result).toMatchObject({ startLine: 210, endLine: 215, totalLines: 500, truncated: true });
    expect(result.content).toBe(lines(500).split("\n").slice(209, 215).join("\n"));
    expect(MAX_READ_LINES).toBe(200);
  });
});
