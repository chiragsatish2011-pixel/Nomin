import { describe, it, expect } from "vitest";
import { sanitize, sanitizeObject, sanitizeTraceEntry, sanitizeArtifact, assertNoLeaks, assertNoLeaksInObject } from "../sanitize";

const LEAK_STRINGS = [
  "I am Nemotron 3 Ultra",
  "Running on NVIDIA NIM",
  "Model: nvidia/nemotron-3-ultra-550b-a55b",
  "NIM API returned 429",
  "The NIM circuit is open",
  "Powered by NVIDIA Nemotron",
  "This is a Nemotron model",
  "NIM request failed",
  "nvidia/nemotron-3-ultra",
];

const SAFE_STRINGS = [
  "I am Trion, a coding agent by Nomin",
  "Trion request completed successfully",
  "The Trion circuit is closed",
  "Trion API returned 200",
  "Hello, how can I help you?",
  "This is a normal response",
];

describe("sanitize", () => {
  it("replaces Nemotron with Trion", () => {
    expect(sanitize("I am Nemotron 3 Ultra")).toBe("I am Trion 3 Ultra");
    expect(sanitize("Powered by Nemotron")).toBe("Powered by Trion");
  });

  it("replaces NVIDIA NIM with Trion", () => {
    expect(sanitize("Running on NVIDIA NIM")).toBe("Running on Trion");
    expect(sanitize("NVIDIA NIM is fast")).toBe("Trion is fast");
  });

  it("replaces standalone NIM with Trion", () => {
    expect(sanitize("NIM request failed")).toBe("Trion request failed");
    expect(sanitize("The NIM circuit is open")).toBe("The Trion circuit is open");
  });

  it("replaces nvidia/nemotron paths", () => {
    expect(sanitize("Model: nvidia/nemotron-3-ultra-550b-a55b")).toBe("Model: Trion");
    expect(sanitize("Using nvidia/nemotron-3-ultra")).toBe("Using Trion");
  });

  it("replaces nvidia/ with empty string", () => {
    expect(sanitize("nvidia/some-path")).toBe("some-path");
  });

  it("replaces NVIDIA with Nomin", () => {
    expect(sanitize("NVIDIA provides GPUs")).toBe("Nomin provides GPUs");
  });

  it("does not expose the internal Gemini execution lane", () => {
    expect(sanitize("Gemini completed the build")).toBe("Trion completed the build");
  });

  it("leaves safe strings unchanged", () => {
    for (const str of SAFE_STRINGS) {
      expect(sanitize(str)).toBe(str);
    }
  });

  it("handles empty and null inputs", () => {
    expect(sanitize("")).toBe("");
    expect(sanitize(null as any)).toBe(null);
    expect(sanitize(undefined as any)).toBe(undefined);
  });
});

describe("sanitizeObject", () => {
  it("sanitizes nested objects", () => {
    const input = {
      message: "Nemotron response",
      nested: {
        error: "NIM failed",
        details: ["nvidia/nemotron-3-ultra", "safe value"],
      },
    };
    const output = sanitizeObject(input) as any;
    expect(output.message).toBe("Trion response");
    expect(output.nested.error).toBe("Trion failed");
    expect(output.nested.details[0]).toBe("Trion");
    expect(output.nested.details[1]).toBe("safe value");
  });

  it("sanitizes arrays", () => {
    const input = ["Nemotron", "NIM", "safe"];
    const output = sanitizeObject(input) as string[];
    expect(output).toEqual(["Trion", "Trion", "safe"]);
  });

  it("handles primitives", () => {
    expect(sanitizeObject(123)).toBe(123);
    expect(sanitizeObject(true)).toBe(true);
    expect(sanitizeObject(null)).toBe(null);
  });
});

describe("sanitizeTraceEntry", () => {
  it("sanitizes all string fields in trace entry", () => {
    const entry = {
      step_id: 1,
      tool_name: "Nemotron-tool",
      input: { query: "NIM search" },
      output: "NIM returned results",
      status: "success" as const,
      attempt: 1,
    };
    const output = sanitizeTraceEntry(entry);
    expect(output.tool_name).toBe("Trion-tool");
    expect(output.input.query).toBe("Trion search");
    expect(output.output).toBe("Trion returned results");
    expect(output.step_id).toBe(1);
    expect(output.attempt).toBe(1);
  });
});

describe("sanitizeArtifact", () => {
  it("sanitizes artifact content and metadata", () => {
    const artifact = {
      type: "file" as const,
      language: "typescript",
      content: "const model = 'nvidia/nemotron-3-ultra'",
      preview_url: "https://nvidia.com/preview",
    };
    const output = sanitizeArtifact(artifact);
    expect(output.content).toBe("const model = 'Trion'");
    expect(output.language).toBe("typescript");
    expect(output.preview_url).toBe("https://Nomin.com/preview"); // nvidia -> Nomin
  });
});

describe("assertNoLeaks", () => {
  it("throws on leak strings", () => {
    for (const leak of LEAK_STRINGS) {
      expect(() => assertNoLeaks(leak, "test")).toThrow(`Identity leak in test`);
    }
  });

  it("passes on safe strings", () => {
    for (const safe of SAFE_STRINGS) {
      expect(() => assertNoLeaks(safe, "test")).not.toThrow();
    }
  });
});

describe("assertNoLeaksInObject", () => {
  it("throws on nested leaks", () => {
    const obj = {
      message: "Safe message",
      nested: {
        error: "NIM request failed",
      },
    };
    expect(() => assertNoLeaksInObject(obj, "test")).toThrow("Identity leak in test.nested.error");
  });

  it("passes on clean objects", () => {
    const obj = {
      message: "Trion response",
      data: ["item1", "item2"],
    };
    expect(() => assertNoLeaksInObject(obj, "test")).not.toThrow();
  });
});

// Integration test: full pipeline simulation
describe("full pipeline sanitization", () => {
  it("simulates a turn with leaked model output being sanitized", () => {
    // Simulate raw model output with leaks
    const rawModelOutput = {
      thought: "I need to use the Nemotron model to answer",
      action: "read_file",
      action_input: { path: "nvidia/nemotron/config.json" },
      summary: "NIM returned the file content",
    };

    // Simulate what model gateway does
    const sanitizedTurn = {
      ...rawModelOutput,
      thought: sanitize(rawModelOutput.thought),
      summary: rawModelOutput.summary ? sanitize(rawModelOutput.summary) : undefined,
      action_input: sanitizeObject(rawModelOutput.action_input) as Record<string, unknown>,
    };

    // Verify no leaks remain
    expect(sanitizedTurn.thought).not.toMatch(/Nemotron|NIM|nvidia\/nemotron/i);
    expect(sanitizedTurn.summary).not.toMatch(/Nemotron|NIM|nvidia\/nemotron/i);
    expect(JSON.stringify(sanitizedTurn.action_input)).not.toMatch(/Nemotron|NIM|nvidia\/nemotron/i);

    // Verify positive replacements
    expect(sanitizedTurn.thought).toContain("Trion");
    expect(sanitizedTurn.summary).toContain("Trion");
  });

  it("simulates trace entry sanitization", () => {
    const rawTrace = {
      step_id: 1,
      tool_name: "Nemotron-search",
      input: { query: "NVIDIA NIM documentation" },
      output: "NIM returned 429 error",
      status: "error" as const,
      attempt: 2,
    };

    const sanitized = sanitizeTraceEntry(rawTrace);
    
    expect(sanitized.tool_name).toBe("Trion-search");
    expect(sanitized.input.query).toBe("Trion documentation");
    expect(sanitized.output).toBe("Trion returned 429 error");
  });

  it("simulates final AgentOutput sanitization", () => {
    const rawOutput = {
      message: "Nemotron completed the task",
      status: "done" as const,
      plan: null,
      tool_trace: [
        {
          step_id: 1,
          tool_name: "read_file",
          input: { path: "nvidia/nemotron/file.ts" },
          output: "NIM returned file content",
          status: "success" as const,
          attempt: 1,
        },
      ],
      artifacts: [
        {
          type: "file" as const,
          content: "Model: nvidia/nemotron-3-ultra",
        },
      ],
      next_action_hint: "Check NIM logs",
    };

    // Sanitize everything
    const sanitizedOutput = {
      ...rawOutput,
      message: sanitize(rawOutput.message),
      tool_trace: rawOutput.tool_trace.map(sanitizeTraceEntry),
      artifacts: rawOutput.artifacts.map(sanitizeArtifact),
      next_action_hint: rawOutput.next_action_hint ? sanitize(rawOutput.next_action_hint) : null,
    };

    // Assert no leaks in final output
    const json = JSON.stringify(sanitizedOutput);
    expect(json).not.toMatch(/Nemotron|NIM|nvidia\/nemotron/i);
    
    // Verify positive content
    expect(sanitizedOutput.message).toBe("Trion completed the task");
    expect(sanitizedOutput.tool_trace[0].input.path).toBe("Trion/file.ts");
    expect(sanitizedOutput.artifacts[0].content).toBe("Model: Trion");
    expect(sanitizedOutput.next_action_hint).toBe("Check Trion logs");
  });
});
