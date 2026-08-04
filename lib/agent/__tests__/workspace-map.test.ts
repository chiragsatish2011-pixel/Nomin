import { describe, expect, it } from "vitest";
import { buildWorkspaceMap } from "../workspace-map";

describe("workspace map", () => {
  it("surfaces project entry points before less relevant paths", () => {
    const map = buildWorkspaceMap([
      "projects/web/src/components/Hero.tsx",
      "projects/web/public/favicon.svg",
      "projects/web/src/styles.css",
      "projects/web/package.json",
      "projects/web/src/App.tsx",
      "projects/web/src/App.test.tsx",
    ]);

    expect(map).toContain("projects/web/package.json");
    expect(map).toContain("projects/web/src/App.tsx");
    expect(map.indexOf("package.json")).toBeLessThan(map.indexOf("Hero.tsx"));
    expect(map.indexOf("App.tsx")).toBeLessThan(map.indexOf("App.test.tsx"));
  });

  it("keeps an empty workspace explicit", () => {
    expect(buildWorkspaceMap([])).toContain("Empty workspace");
  });

  it("deduplicates paths and keeps the prompt bounded", () => {
    const paths = Array.from({ length: 80 }, (_, index) => `projects/web/src/components/C${index}.tsx`);
    const map = buildWorkspaceMap([...paths, paths[0]]);
    expect(map.length).toBeLessThanOrEqual(3_600);
    expect(map.match(/C0\.tsx/g)).toHaveLength(1);
  });
});
