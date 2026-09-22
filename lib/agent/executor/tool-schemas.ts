// Machine-readable tool definitions for the execution decision.
//
// The executor has always described its tools in PROSE, inside the system
// prompt, and asked the model to reply with a JSON object matching a schema
// written out in the same prose. That works until it doesn't: an unparseable
// reply is the single most common non-transport failure in this loop, and every
// mitigation around it (the repair re-ask, the raw-output wrapper, the salvage
// paths) exists because the format is advisory rather than enforced.
//
// These are the same tools, expressed the way the provider can actually enforce
// them. The planner already proved the pattern on this endpoint (see
// planner/generator.ts): send `tools`, force a call, and a provider that ignores
// them degrades to exactly the prompted-JSON path that runs today.
//
// Sending them is OPT-IN (see `executorToolOptions`). The parsing side is not:
// a tool_call reply is understood whether or not this deployment asked for one.

import type { ProviderTool, ProviderToolChoice } from "@/lib/nim/internal-client";

const THOUGHT = {
  type: "string",
  description: "One or two sentences: current state, why this action is next.",
} as const;

export const READ_FILE_TOOL: ProviderTool = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read one file from the sandbox workspace.",
    parameters: {
      type: "object",
      properties: {
        thought: THOUGHT,
        path: { type: "string", description: "POSIX path relative to the workspace root." },
      },
      required: ["thought", "path"],
    },
  },
};

export const SEARCH_CODEBASE_TOOL: ProviderTool = {
  type: "function",
  function: {
    name: "search_codebase",
    description: "Search the sandbox workspace for text.",
    parameters: {
      type: "object",
      properties: {
        thought: THOUGHT,
        query: { type: "string", description: "Literal text to search for." },
        maxResults: { type: "number", description: "Optional result cap." },
      },
      required: ["thought", "query"],
    },
  },
};

export const WRITE_FILE_TOOL: ProviderTool = {
  type: "function",
  function: {
    name: "write_file",
    description: "Write a file in the sandbox workspace. Replaces the whole file.",
    parameters: {
      type: "object",
      properties: {
        thought: THOUGHT,
        path: { type: "string", description: "POSIX path relative to the workspace root." },
        content: {
          type: "string",
          description: "The COMPLETE file body. No placeholders, no ellipses, no patch format.",
        },
      },
      required: ["thought", "path", "content"],
    },
  },
};

export const RUN_COMMAND_TOOL: ProviderTool = {
  type: "function",
  function: {
    name: "run_command",
    description: "Run ONE command in the sandbox. There is no shell: operators such as && | > are rejected.",
    parameters: {
      type: "object",
      properties: {
        thought: THOUGHT,
        command: { type: "string", description: "A single command, e.g. 'npx nx build web'." },
        cwd: { type: "string", description: "Optional working directory relative to the workspace root." },
      },
      required: ["thought", "command"],
    },
  },
};

export const FINISH_TOOL: ProviderTool = {
  type: "function",
  function: {
    name: "finish",
    description: "End the turn. Only when every approved step has real, verified evidence behind it.",
    parameters: {
      type: "object",
      properties: {
        thought: THOUGHT,
        summary: { type: "string", description: "What was actually done, grounded in the trace." },
      },
      required: ["thought"],
    },
  },
};

/** Same narrowing rule as `executePromptFor`: a step with a known tool gets the
 *  tools that step can legitimately use, and anything else gets the full set. */
export function executorToolsFor(tool: string | null | undefined, opts: { isRetry: boolean }): ProviderTool[] {
  if (opts.isRetry || !tool) {
    return [READ_FILE_TOOL, SEARCH_CODEBASE_TOOL, WRITE_FILE_TOOL, RUN_COMMAND_TOOL, FINISH_TOOL];
  }
  if (tool === "read_file" || tool === "search_codebase" || tool === "web_fetch") {
    return [READ_FILE_TOOL, SEARCH_CODEBASE_TOOL, FINISH_TOOL];
  }
  if (tool === "write_file") return [WRITE_FILE_TOOL, READ_FILE_TOOL, SEARCH_CODEBASE_TOOL, FINISH_TOOL];
  if (tool === "run_command") return [RUN_COMMAND_TOOL, READ_FILE_TOOL, FINISH_TOOL];
  return [READ_FILE_TOOL, SEARCH_CODEBASE_TOOL, WRITE_FILE_TOOL, RUN_COMMAND_TOOL, FINISH_TOOL];
}

/**
 * Whether this deployment asks the provider to enforce the tool schema.
 *
 * Off by default, deliberately. Turning it on changes the wire format of the
 * busiest call in the system, and that is a change to verify against the live
 * endpoint being used — not one to assume. With it off, nothing about the
 * request changes; with it on, a provider that ignores `tools` still falls back
 * to the prompted-JSON reply the loop already handles.
 */
export function executorToolCallsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TRION_EXECUTOR_TOOL_CALLS === "1";
}

export function executorToolOptions(
  tool: string | null | undefined,
  opts: { isRetry: boolean },
): { tools?: ProviderTool[]; toolChoice?: ProviderToolChoice } {
  if (!executorToolCallsEnabled()) return {};
  return { tools: executorToolsFor(tool, opts), toolChoice: "required" };
}
