import { describe, expect, it } from "vitest";
import { geminiConfigured, providerFallbackOrder, shouldRouteToGemini } from "../../nim/internal-client";

const configured = { TRION_API_KEY: "hosted-key" };

describe("provider role routing", () => {
  const gemini = {
    GEMINI_API_KEY_1: "test-gemini-key-1",
    GEMINI_API_KEY_2: "test-gemini-key-2",
  };

  it("recognizes the separate Gemini build lane without binding it to NIM", () => {
    expect(geminiConfigured(gemini)).toBe(true);
    expect(shouldRouteToGemini({ label: "plan" }, gemini)).toBe(true);
    expect(shouldRouteToGemini({ label: "execution_decision" }, gemini)).toBe(true);
    expect(shouldRouteToGemini({ label: "synthesis" }, gemini)).toBe(false);
    expect(shouldRouteToGemini({ label: "classification" }, gemini)).toBe(false);
  });

  it("does not activate Gemini with only one unrelated provider configured", () => {
    expect(geminiConfigured({ TRION_API_KEY: "hosted-only" })).toBe(false);
    expect(shouldRouteToGemini({ label: "plan" }, { TRION_API_KEY: "hosted-only" })).toBe(false);
  });

  it("uses Gemini then hosted for planning", () => {
    expect(providerFallbackOrder("plan", { ...configured, ...gemini })).toEqual(["gemini", "hosted"]);
    expect(providerFallbackOrder("plan", configured)).toEqual(["hosted"]);
    expect(providerFallbackOrder("plan", {})).toEqual(["hosted"]);
  });

  it("uses Gemini then hosted for execution", () => {
    expect(providerFallbackOrder("execution_decision", { ...configured, ...gemini })).toEqual(["gemini", "hosted"]);
    expect(providerFallbackOrder("execution_decision", gemini)).toEqual(["gemini", "hosted"]);
  });

});
