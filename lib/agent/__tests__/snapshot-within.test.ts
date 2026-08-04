import { describe, expect, it } from "vitest";
import { snapshotWithin } from "@/app/hooks/useWebContainerExecutor";

describe("snapshotWithin", () => {
  it("returns the real browser workspace snapshot when it is ready", async () => {
    await expect(snapshotWithin(async () => ["projects/web/src/App.tsx"], 50)).resolves.toEqual(["projects/web/src/App.tsx"]);
  });

  it("does not block a chat turn when a fresh WebContainer has not booted", async () => {
    const never = () => new Promise<string[]>(() => undefined);
    await expect(snapshotWithin(never, 5)).resolves.toEqual([]);
  });
});
