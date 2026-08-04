import { describe, expect, it } from "vitest";
import { getOrCreateSession, getSession, pruneExpiredSessions, SESSION_TTL_MS } from "../session-store";

describe("session retention", () => {
  it("expires inactive sessions after 30 days while retaining current work", () => {
    const stale = getOrCreateSession("ttl-stale", "execute", "trion-1.4", "workspace");
    const active = getOrCreateSession("ttl-active", "execute", "trion-1.4", "workspace");
    const now = Date.now();
    stale.updatedAt = new Date(now - SESSION_TTL_MS - 1).toISOString();
    // Leave a real-time margin because getSession() performs its own prune
    // with Date.now(). A one-millisecond margin can expire while the suite is
    // still running, making this otherwise valid boundary test flaky.
    active.updatedAt = new Date(now - SESSION_TTL_MS + 5_000).toISOString();

    expect(pruneExpiredSessions(now)).toBeGreaterThanOrEqual(1);
    expect(getSession("ttl-stale")).toBeUndefined();
    expect(getSession("ttl-active")).toBeDefined();
  });

  it("does not delete legacy sessions with an unparsable timestamp", () => {
    const legacy = getOrCreateSession("ttl-legacy", "execute", "trion-1.4", "workspace");
    legacy.updatedAt = "unknown";
    pruneExpiredSessions(Date.now() + SESSION_TTL_MS * 2);
    expect(getSession("ttl-legacy")).toBeDefined();
  });
});
