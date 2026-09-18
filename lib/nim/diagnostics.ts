/**
 * Provider-call diagnostics.
 *
 * The agent loop is deliberately quiet about provider identity in USER-facing
 * output, and that is correct. But it had become quiet in the SERVER LOGS too:
 * every failure path swallowed its cause (classifier fell back to a keyword
 * heuristic, direct-answer rewrote the error into "couldn't compose a reply",
 * the chat route caught everything into "Trion paused"). The result was an app
 * that could make zero network calls for an entire turn and still look healthy.
 *
 * This module is the one place that records what actually happened on the wire.
 * It NEVER logs the key itself — only whether one was present and its length.
 */

/** Set TRION_DEBUG_PROVIDER=0 to silence successful-call lines. Failures are
 *  always logged: a swallowed auth error is precisely the bug this exists for. */
const VERBOSE = process.env.TRION_DEBUG_PROVIDER !== "0";

export type ProviderCallLog = {
  label: string;
  route: string;
  endpoint: string;
  model: string;
  keyPresent: boolean;
  keyLength: number;
  status?: number;
  ms?: number;
  bodyPreview?: string;
  error?: unknown;
};

function redactUrl(endpoint: string): string {
  // Gemini carries the credential in the query string. Never log it.
  return endpoint.replace(/([?&]key=)[^&]+/i, "$1[REDACTED]");
}

export function logProviderRequest(entry: ProviderCallLog) {
  if (!VERBOSE) return;
  console.log(
    `[trion:provider] -> ${entry.label} route=${entry.route} model=${entry.model} ` +
    `endpoint=${redactUrl(entry.endpoint)} keyPresent=${entry.keyPresent} keyLength=${entry.keyLength}`
  );
}

export function logProviderResponse(entry: ProviderCallLog) {
  const failed = entry.status !== undefined && (entry.status < 200 || entry.status >= 300);
  if (!failed && !VERBOSE) return;
  const line =
    `[trion:provider] <- ${entry.label} route=${entry.route} model=${entry.model} ` +
    `status=${entry.status} ms=${entry.ms}`;
  if (failed) {
    console.error(`${line} body=${entry.bodyPreview ?? "<empty>"}`);
  } else {
    console.log(line);
  }
}

/** Always logged, with the stack. A provider error that reaches a user as
 *  generic copy must still be fully recoverable from the server log. */
export function logProviderError(entry: ProviderCallLog) {
  const error = entry.error;
  console.error(
    `[trion:provider] !! ${entry.label} route=${entry.route} model=${entry.model} ` +
    `endpoint=${redactUrl(entry.endpoint)} keyPresent=${entry.keyPresent} ` +
    `error=${error instanceof Error ? error.message : String(error)}`
  );
  if (error instanceof Error && error.stack) console.error(error.stack);
}

/** Logged wherever the agent loop deliberately degrades instead of failing.
 *  Each of these was previously an empty `catch {}`. */
export function logSwallowedFailure(stage: string, error: unknown) {
  console.error(
    `[trion:swallowed] stage=${stage} error=${error instanceof Error ? error.message : String(error)}`
  );
  if (error instanceof Error && error.stack) console.error(error.stack);
}
