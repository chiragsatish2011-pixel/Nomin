// Zero-leak identity enforcement
// Scans all outbound user-facing strings for banned substrings

// Patterns ordered from most specific to least specific
const BANNED_PATTERNS = [
  // Full model names (most specific)
  { pattern: /nvidia\/nemotron-3-ultra-550b-a55b/gi, replacement: "Trion" },
  { pattern: /nvidia\/nemotron-3-ultra/gi, replacement: "Trion" },
  { pattern: /nvidia\/nemotron[-\w]*/gi, replacement: "Trion" },
  
  // NVIDIA NIM as a phrase
  { pattern: /NVIDIA\s+NIM/gi, replacement: "Trion" },
  { pattern: /NVIDIA\s*NIM/gi, replacement: "Trion" },
  
  // Nemotron standalone
  { pattern: /Nemotron/gi, replacement: "Trion" },
  { pattern: /nemotron/gi, replacement: "Trion" },
  
  // NIM standalone (word boundary)
  { pattern: /\bNIM\b/gi, replacement: "Trion" },
  { pattern: /\bnim\b/gi, replacement: "Trion" },
  
  // nvidia/ paths
  { pattern: /nvidia\//gi, replacement: "" },
  
  // NVIDIA standalone (but not as part of NVIDIA NIM which is handled above)
  { pattern: /NVIDIA/gi, replacement: "Nomin" },

  // Internal planning/execution lane. Explicit BYOK provider labels are
  // rendered by the settings UI separately; this boundary protects model
  // output, traces, artifacts, and errors from exposing internal routing.
  { pattern: /\bGemini\b/gi, replacement: "Trion" },
] as const;

/** Apply every banned-substring replacement to one line. */
function replaceBanned(line: string): string {
  let out = line;
  for (const { pattern, replacement } of BANNED_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Replace every vendor substring with the Trion/Nomin equivalent.
 *
 * Whitespace is preserved EXACTLY. An earlier version collapsed every run of
 * spaces/tabs to a single space and trimmed the result, which ran on
 * `write_file` content (via the gateway's `action_input` sanitizer) and flattened
 * the indentation of every file the agent wrote — plus every fenced code block
 * in every message. The only whitespace cleanup that is safe is the tidy-up of
 * the gap a removed substring leaves behind, so that is scoped to the lines a
 * replacement actually touched, and never to their leading indentation.
 */
export function sanitize(text: string): string {
  if (!text || typeof text !== "string") return text;
  if (!BANNED_PATTERNS.some(({ pattern }) => new RegExp(pattern.source, pattern.flags.replace(/g/g, "")).test(text))) {
    return text;
  }

  return text
    .split("\n")
    .map((line) => {
      const replaced = replaceBanned(line);
      if (replaced === line) return line;
      // Only a line that changed can carry a replacement gap. Keep its
      // indentation byte-for-byte and tidy the interior only.
      const indent = replaced.match(/^[ \t]*/)?.[0] ?? "";
      return indent + replaced.slice(indent.length).replace(/ {2,}/g, " ").replace(/ +$/, "");
    })
    .join("\n");
}

export function sanitizeObject(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") return sanitize(obj);
  if (Array.isArray(obj)) return obj.map(sanitizeObject);
  if (typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      out[key] = sanitizeObject(value);
    }
    return out;
  }
  return obj;
}

/**
 * Sanitize a tool-call input record WITHOUT corrupting the artifact being
 * created. A write_file `content` body must reach the disk byte-exact: the
 * previous behavior replaced vendor-looking substrings inside user code (e.g.
 * a Gemini API integration became a Trion API integration on disk), so the
 * file the trace claimed to verify was not the file the model authored.
 * Identity is enforced on prose (thought/summary/messages), never on code.
 */
export function sanitizeToolInput(action: string, input: Record<string, unknown>): Record<string, unknown> {
  if (action !== "write_file") return sanitizeObject(input) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = key === "content" ? value : sanitizeObject(value);
  }
  return out;
}

export function sanitizeTraceEntry(entry: {
  step_id: number;
  tool_name: string;
  input: Record<string, unknown>;
  output: string;
  status: "success" | "error";
  attempt: number;
  path_used?: "hosted" | "local" | "deterministic";
}): {
  step_id: number;
  tool_name: string;
  input: Record<string, unknown>;
  output: string;
  status: "success" | "error";
  attempt: number;
  path_used?: "hosted" | "local" | "deterministic";
} {
  // write_file content is the artifact being created: it stays byte-exact so
  // the trace remains evidence of what is actually on disk (see
  // sanitizeToolInput). Every other field is model/description prose.
  const input = entry.tool_name === "write_file"
    ? sanitizeToolInput(entry.tool_name, entry.input)
    : (sanitizeObject(entry.input) as Record<string, unknown>);
  return {
    ...entry,
    output: sanitize(entry.output),
    input,
    tool_name: sanitize(entry.tool_name),
  };
}

export function sanitizeArtifact(artifact: {
  type: "code_diff" | "file" | "preview";
  language?: string;
  content: string;
  preview_url?: string;
}): {
  type: "code_diff" | "file" | "preview";
  language?: string;
  content: string;
  preview_url?: string;
} {
  // Artifact content is user code that is written to disk and shown as the
  // deliverable: replacing substrings inside it corrupts the product (and its
  // evidence). Identity is enforced on the surrounding prose instead.
  return {
    ...artifact,
    content: artifact.content,
    language: artifact.language ? sanitize(artifact.language) : undefined,
    preview_url: artifact.preview_url ? sanitize(artifact.preview_url) : undefined,
  };
}

export function assertNoLeaks(text: string, context: string): void {
  if (!text || typeof text !== "string") return;
  for (let index = 0; index < BANNED_PATTERNS.length; index++) {
    const { pattern } = BANNED_PATTERNS[index];
    // The shared patterns carry the /g flag; .test() advances lastIndex, which
    // would make leak detection skip matches intermittently. Test against a
    // fresh, non-global clone instead.
    const probe = new RegExp(pattern.source, pattern.flags.replace(/g/g, ""));
    if (probe.test(text)) {
      // Never echo the matched pattern source: it contains the very vendor
      // strings this boundary exists to suppress, so the error itself would
      // be the leak if it ever reached a user-facing surface.
      throw new Error(`Identity leak in ${context} (rule ${index})`);
    }
  }
}

export function assertNoLeaksInObject(obj: unknown, context: string): void {
  if (obj === null || obj === undefined) return;
  if (typeof obj === "string") {
    assertNoLeaks(obj, context);
    return;
  }
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => assertNoLeaksInObject(item, `${context}[${i}]`));
    return;
  }
  if (typeof obj === "object") {
    for (const [key, value] of Object.entries(obj)) {
      assertNoLeaksInObject(value, `${context}.${key}`);
    }
  }
}

/**
 * Final-output leak check that respects the code/prose split. Code bodies
 * (write_file trace inputs, artifact contents) are the user's product and may
 * legitimately name third-party SDKs — asserting on them turned a correct
 * Gemini API integration into a turn-ending internal error. Everything
 * model-authored around the code is still checked.
 */
export function assertNoLeaksInOutput(output: {
  message: string;
  plan: { summary: string; steps: Array<{ description: string }> } | null;
  tool_trace: Array<{ tool_name: string; input: Record<string, unknown>; output: string }>;
  artifacts: Array<{ language?: string; preview_url?: string }>;
  next_action_hint?: string | null;
}): void {
  assertNoLeaks(output.message, "final AgentOutput.message");
  if (output.next_action_hint) assertNoLeaks(output.next_action_hint, "final AgentOutput.next_action_hint");
  if (output.plan) {
    assertNoLeaks(output.plan.summary, "final AgentOutput.plan.summary");
    output.plan.steps.forEach((step, i) => assertNoLeaks(step.description, `final AgentOutput.plan.steps[${i}]`));
  }
  output.tool_trace.forEach((entry, i) => {
    assertNoLeaks(entry.tool_name, `final AgentOutput.tool_trace[${i}].tool_name`);
    assertNoLeaks(entry.output, `final AgentOutput.tool_trace[${i}].output`);
    for (const [key, value] of Object.entries(entry.input)) {
      if (entry.tool_name === "write_file" && key === "content") continue;
      assertNoLeaksInObject(value, `final AgentOutput.tool_trace[${i}].input.${key}`);
    }
  });
  output.artifacts.forEach((artifact, i) => {
    if (artifact.language) assertNoLeaks(artifact.language, `final AgentOutput.artifacts[${i}].language`);
    if (artifact.preview_url) assertNoLeaks(artifact.preview_url, `final AgentOutput.artifacts[${i}].preview_url`);
  });
}

/**
 * A `sanitize` that can be applied to a stream without ever printing a banned
 * word and taking it back.
 *
 * `sanitize` is safe on a whole string but NOT on an arbitrary slice of one: a
 * chunk boundary can fall inside "Nemo|tron", and each half passes the filter
 * cleanly while the concatenation on screen does not. The fix is to hold back
 * the tail rather than to weaken the filter — every banned pattern is at most
 * two whitespace-separated tokens ("NVIDIA NIM" is the longest), so retaining
 * the last two tokens of the buffer guarantees that anything released has
 * already been seen in its complete form.
 *
 * Returns a `push` for each chunk and a `flush` for the end of the stream.
 */
export function createStreamSanitizer(): { push: (chunk: string) => string; flush: () => string } {
  let held = "";
  return {
    push(chunk: string): string {
      held += chunk;
      // Keep the last two tokens (and the whitespace between them) back.
      const boundary = held.search(/\s\S*\s\S*$/);
      if (boundary < 0) return "";
      const release = held.slice(0, boundary);
      held = held.slice(boundary);
      return sanitize(release);
    },
    flush(): string {
      const rest = held;
      held = "";
      return sanitize(rest);
    },
  };
}
