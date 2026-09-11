import { describe, expect, it } from "vitest";
import { MAX_TOTAL_SAVED_SESSION_BYTES, measureStorage, storageHealthLabel } from "@/app/lib/storage-hygiene";

function storage(entries: Record<string, string>) {
  const keys = Object.keys(entries);
  return {
    get length() { return keys.length; },
    key: (index: number) => keys[index] ?? null,
    getItem: (key: string) => entries[key] ?? null,
  };
}

describe("browser storage hygiene", () => {
  it("separates Trion conversations, workspace recovery, and preferences", () => {
    const health = measureStorage(storage({
      "trion-session:a:local": "chat",
      "trion.workspace.checkpoint.v1:local": "workspace",
      "nomin-theme": "dark",
      "unrelated-app": "ignored",
    }));
    expect(health.conversationCount).toBe(1);
    expect(health.conversationsBytes).toBe(8);
    expect(health.workspaceBytes).toBe(18);
    expect(health.preferencesBytes).toBe(8);
    expect(storageHealthLabel(health)).toBe("Healthy");
  });

  it("flags simulated storage growth before browser quota exhaustion", () => {
    const health = measureStorage(storage({
      "trion-session:large:local": "x".repeat(MAX_TOTAL_SAVED_SESSION_BYTES + 1),
    }));
    expect(health.level).toBe("over_limit");
    expect(storageHealthLabel(health)).toBe("Cleanup needed");
  });
});
