/** Lightweight browser-storage accounting for local-first Trion. It never
 * scans files or touches WebContainer; it only inspects the small set of
 * keys Trion itself owns, so it is safe to run in the background. */

export const MAX_SAVED_SESSION_BYTES = 600_000;
export const MAX_TOTAL_SAVED_SESSION_BYTES = 3_000_000;
export const MAX_WORKSPACE_CHECKPOINT_BYTES = 900_000;
export const STORAGE_MONITOR_INTERVAL_MS = 5 * 60_000;

type StorageLike = Pick<Storage, "length" | "key" | "getItem">;

export type StorageHealth = {
  conversationsBytes: number;
  workspaceBytes: number;
  preferencesBytes: number;
  conversationCount: number;
  level: "healthy" | "warning" | "over_limit";
};

function bytes(value: string | null): number {
  // Storage quota is measured in implementation bytes, but UTF-16 length is a
  // stable, cheap upper-bound signal for the JSON/text Trion writes.
  return (value?.length ?? 0) * 2;
}

export function measureStorage(storage: StorageLike): StorageHealth {
  let conversationsBytes = 0;
  let workspaceBytes = 0;
  let preferencesBytes = 0;
  let conversationCount = 0;

  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key) continue;
    const size = bytes(storage.getItem(key));
    if (key.startsWith("trion-session:")) {
      conversationsBytes += size;
      conversationCount += 1;
    } else if (key.startsWith("trion-sessions:") || key.startsWith("trion-active-session:")) {
      preferencesBytes += size;
    } else if (key.startsWith("trion.workspace.checkpoint.v1:")) {
      workspaceBytes += size;
    } else if (key.startsWith("nomin-")) {
      preferencesBytes += size;
    }
  }

  const conversationRatio = conversationsBytes / (MAX_TOTAL_SAVED_SESSION_BYTES * 2);
  const workspaceRatio = workspaceBytes / (MAX_WORKSPACE_CHECKPOINT_BYTES * 2);
  const preferenceRatio = preferencesBytes / (64_000 * 2);
  const peak = Math.max(conversationRatio, workspaceRatio, preferenceRatio);
  return {
    conversationsBytes,
    workspaceBytes,
    preferencesBytes,
    conversationCount,
    level: peak > 1 ? "over_limit" : peak >= 0.8 ? "warning" : "healthy",
  };
}

export function storageHealthLabel(health: StorageHealth | null): string {
  if (!health) return "Checking";
  if (health.level === "over_limit") return "Cleanup needed";
  if (health.level === "warning") return "Nearly full";
  return "Healthy";
}

export function storageHealthDetail(health: StorageHealth | null): string {
  if (!health) return "Measuring browser-owned data";
  const total = health.conversationsBytes + health.workspaceBytes + health.preferencesBytes;
  return `${Math.ceil(total / 1024)} KB across ${health.conversationCount} saved ${health.conversationCount === 1 ? "conversation" : "conversations"}`;
}
