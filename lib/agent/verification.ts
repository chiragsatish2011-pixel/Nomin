import type { ToolTraceEntry, VerificationSummary } from "./types";

const RUNNABLE_FILE = /\.(?:[cm]?[jt]sx?|css|scss|sass|less|html?|vue|svelte|json)$/i;
const VERIFICATION_COMMAND = /(?:\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|tests|build|lint|typecheck|type-check|check|validate|dev|start)\b|\bnpx\s+(?:vitest|jest|eslint|tsc)\b|\b(?:vitest|jest|eslint|tsc)\b|\b(?:next|vite)\s+(?:build|dev|preview)\b)/i;
// A dev server beginning to serve proves the PROCESS started, not that the
// change is correct. Only build/test/lint/typecheck-style checks prove
// correctness; a bare start/preview/dev command is startup evidence.
const STARTUP_ONLY_COMMAND = /^\s*(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|preview)(?:\s|$)|\b(?:npx\s+)?(?:next|vite)\s+(?:dev|preview)(?:\s|$))/i;

function writtenRunnableFile(entry: ToolTraceEntry): boolean {
  return entry.tool_name === "write_file" && entry.status === "success" &&
    typeof entry.input.path === "string" && RUNNABLE_FILE.test(entry.input.path);
}

function commandFor(entry: ToolTraceEntry): string | null {
  return entry.tool_name === "run_command" && typeof entry.input.command === "string"
    ? entry.input.command.trim()
    : null;
}

function isStartupOnly(command: string | null | undefined): boolean {
  return typeof command === "string" && STARTUP_ONLY_COMMAND.test(command);
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
  // Prefer a correctness-proving check over a startup-only one: a turn that
  // both started a dev server and ran a build is verified by the build.
  const successful = checks.find((entry) => entry.status === "success" && !isStartupOnly(commandFor(entry)))
    ?? checks.find((entry) => entry.status === "success");
  if (successful) {
    const command = commandFor(successful) ?? undefined;
    // A started dev server is live in preview, but startup is not proof: no
    // build, test, or typecheck validated the change. Report it honestly
    // instead of stamping the turn verified.
    if (isStartupOnly(command)) {
      return {
        required: true,
        status: "started",
        command,
        message: `Development server started (\`${command}\`): the app is live in preview, but no build, test, or typecheck validated the change.`,
      };
    }
    return {
      required: true,
      status: "passed",
      command,
      message: `Verified by running \`${command}\`.`,
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
