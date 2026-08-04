import type { ToolTraceEntry, VerificationSummary } from "./types";

const RUNNABLE_FILE = /\.(?:[cm]?[jt]sx?|css|scss|sass|less|html?|vue|svelte|json)$/i;
const VERIFICATION_COMMAND = /(?:\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|tests|build|lint|typecheck|type-check|check|validate|dev|start)\b|\bnpx\s+(?:vitest|jest|eslint|tsc)\b|\b(?:vitest|jest|eslint|tsc)\b|\b(?:next|vite)\s+(?:build|dev|preview)\b)/i;

function writtenRunnableFile(entry: ToolTraceEntry): boolean {
  return entry.tool_name === "write_file" && entry.status === "success" &&
    typeof entry.input.path === "string" && RUNNABLE_FILE.test(entry.input.path);
}

function commandFor(entry: ToolTraceEntry): string | null {
  return entry.tool_name === "run_command" && typeof entry.input.command === "string"
    ? entry.input.command.trim()
    : null;
}

/**
 * A coding result is only verified when a successful, relevant command ran
 * after the final runnable file write. A successful `npm install` is useful,
 * but it does not prove the code builds; nor does a build before the final edit.
 */
export function evaluateVerification(trace: ToolTraceEntry[]): VerificationSummary {
  let lastRunnableWrite = -1;
  for (let index = 0; index < trace.length; index++) {
    if (writtenRunnableFile(trace[index])) lastRunnableWrite = index;
  }

  if (lastRunnableWrite < 0) {
    return { required: false, status: "not_needed", message: "No runnable code changed, so no build check was needed." };
  }

  const checks = trace.slice(lastRunnableWrite + 1).filter((entry) => {
    const command = commandFor(entry);
    return command !== null && VERIFICATION_COMMAND.test(command);
  });
  const successful = checks.find((entry) => entry.status === "success");
  if (successful) {
    return {
      required: true,
      status: "passed",
      command: commandFor(successful) ?? undefined,
      message: `Verified by running \`${commandFor(successful)}\`.`,
    };
  }

  const failed = checks.find((entry) => entry.status === "error");
  if (failed) {
    return {
      required: true,
      status: "failed",
      command: commandFor(failed) ?? undefined,
      message: `Verification command \`${commandFor(failed)}\` did not succeed.`,
    };
  }

  return {
    required: true,
    status: "not_run",
    message: "Runnable code changed, but no build, test, lint, typecheck, or ready development server ran after the final change.",
  };
}
