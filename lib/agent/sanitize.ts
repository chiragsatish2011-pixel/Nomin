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

export function sanitizeTraceEntry(entry: {
  step_id: number;
  tool_name: string;
  input: Record<string, unknown>;
  output: string;
  status: "success" | "error";
  attempt: number;
  path_used?: "hosted" | "gemini" | "deterministic";
}): {
  step_id: number;
  tool_name: string;
  input: Record<string, unknown>;
  output: string;
  status: "success" | "error";
  attempt: number;
  path_used?: "hosted" | "gemini" | "deterministic";
} {
  return {
    ...entry,
    output: sanitize(entry.output),
    input: sanitizeObject(entry.input) as Record<string, unknown>,
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
  return {
    ...artifact,
    content: sanitize(artifact.content),
    language: artifact.language ? sanitize(artifact.language) : undefined,
    preview_url: artifact.preview_url ? sanitize(artifact.preview_url) : undefined,
  };
}

export function assertNoLeaks(text: string, context: string): void {
  if (!text || typeof text !== "string") return;
  for (const { pattern } of BANNED_PATTERNS) {
    // The shared patterns carry the /g flag; .test() advances lastIndex, which
    // would make leak detection skip matches intermittently. Test against a
    // fresh, non-global clone instead.
    const probe = new RegExp(pattern.source, pattern.flags.replace(/g/g, ""));
    if (probe.test(text)) {
      throw new Error(`Identity leak in ${context}: matched ${pattern.source}`);
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
