// REGRESSION: build-lane credentials are addressed by ROLE, so their ids must
// be stable slots — not positions in a filtered list.
//
// `pump()` prefers `gemini-1` for planning and `gemini-2` for execution/review
// so a long build does not spend one credential's whole per-minute allowance on
// its own decisions. The previous `geminiKeysFromEnv` numbered keys by position
// after filtering, so an unset GEMINI_API_KEY_1 silently renamed
// GEMINI_API_KEY_2 to `gemini-1`: the execution credential did the planning, and
// the execution role's preferred key did not exist. A missing preferred key
// falls back silently, so nothing ever reported this.

import { describe, expect, it } from "vitest";
import { geminiLaneDiagnostics } from "../internal-client";

describe("gemini build-lane topology", () => {
  it("keeps a key's id tied to its env slot, not its position", () => {
    // Only slot 2 is populated. Its id must remain gemini-2 — the execution
    // role's key — rather than being promoted into the planning role.
    const lane = geminiLaneDiagnostics({ GEMINI_API_KEY_2: "second-slot-secret" });
    expect(lane.distinctKeys).toBe(1);
    expect(lane.executionKey).toBe("gemini-2");
  });

  it("gives planning and execution separate credentials when both slots are set", () => {
    const lane = geminiLaneDiagnostics({
      GEMINI_API_KEY_1: "planning-secret",
      GEMINI_API_KEY_2: "execution-secret",
    });
    expect(lane.distinctKeys).toBe(2);
    expect(lane.planKey).toBe("gemini-1");
    expect(lane.executionKey).toBe("gemini-2");
    expect(lane.sharesOneCredential).toBe(false);
  });

  it("reports that one credential is serving both roles instead of hiding it", () => {
    // The real deployment shape that made this visible: GEMINI_API_KEY_2 and the
    // unnumbered GEMINI_API_KEY hold the SAME secret, so the lane has one
    // credential and one rate budget while appearing to have two.
    const lane = geminiLaneDiagnostics({
      GEMINI_API_KEY_2: "same-secret",
      GEMINI_API_KEY: "same-secret",
    });
    expect(lane.distinctKeys).toBe(1);
    expect(lane.sharesOneCredential).toBe(true);
  });

  it("treats duplicate secrets as one credential with one quota", () => {
    // Two variables holding one secret is not two rate allowances. Believing
    // otherwise makes the pool dispatch into a limit it has already spent.
    const lane = geminiLaneDiagnostics({
      GEMINI_API_KEY_1: "duplicate",
      GEMINI_API_KEY_2: "duplicate",
      GEMINI_API_KEY_3: "genuinely-different",
    });
    expect(lane.distinctKeys).toBe(2);
  });

  it("places a lone unnumbered key in the first slot", () => {
    const lane = geminiLaneDiagnostics({ GEMINI_API_KEY: "only-key" });
    expect(lane.distinctKeys).toBe(1);
    expect(lane.planKey).toBe("gemini-1");
    expect(lane.sharesOneCredential).toBe(true);
  });

  it("reports an unconfigured lane without claiming a shared credential", () => {
    const lane = geminiLaneDiagnostics({});
    expect(lane.configured).toBe(false);
    expect(lane.distinctKeys).toBe(0);
    expect(lane.sharesOneCredential).toBe(false);
  });
});
