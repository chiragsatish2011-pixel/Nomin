import type { IncomingMessage, ServerResponse } from "node:http";
import { runTurn } from "../model/agent.js";
import { captureBaseline, diffFromBaseline, isStale, loadBaseline } from "../model/evidence.js";
import { createSupervisor } from "../model/supervisor.js";
import { describeMedia, visionContext } from "../model/vision.js";
import { Workspace } from "../model/workspace.js";

/**
 * The agent API, written once.
 *
 * The dev server mounts these as middleware; Vercel mounts them as functions.
 * Keeping one implementation is the point: an endpoint that only exists in
 * `vite.config.ts` works perfectly on a laptop and is simply absent in
 * production, which is exactly the failure this module removes.
 *
 * Everything here runs server-side, so credentials stay on the server in both
 * environments and the browser only ever receives frames.
 */

/** True on a platform with a read-only filesystem and no long-lived process. */
export const isServerless = (): boolean =>
  Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY);

export async function readJson(req: IncomingMessage): Promise<Record<string, any>> {
  // Some platforms parse the body for us; others hand over the raw stream.
  const parsed = (req as IncomingMessage & { body?: unknown }).body;
  if (parsed && typeof parsed === "object") return parsed as Record<string, any>;
  if (typeof parsed === "string") {
    try {
      return JSON.parse(parsed);
    } catch {
      return {};
    }
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

/** POST /api/chat — streams one agent turn as server-sent events. */
export async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    json(res, 405, { error: "Method not allowed" });
    return;
  }

  const body = await readJson(req);
  const controller = new AbortController();
  let gone = false;
  // Abort only when the client goes away: `req`'s own close fires as soon as
  // its body has been read, which would kill the stream before it starts.
  res.on("close", () => {
    if (!res.writableEnded) {
      gone = true;
      controller.abort();
    }
  });
  // A reader that closes the tab mid-build resets the socket, and an unhandled
  // reset on the response takes the whole process down — locally it killed the
  // dev server outright, and on a serverless host it is a 500 on a turn that
  // was going perfectly well. There is nothing to do about a reader who has
  // left except stop writing to them.
  const forget = () => {
    gone = true;
  };
  res.on("error", forget);
  req.on("error", forget);
  req.on("aborted", forget);

  /** Write a frame, unless the reader has already gone. */
  const send = (frame: unknown): boolean => {
    if (gone || res.writableEnded) return false;
    try {
      res.write(`data: ${JSON.stringify(frame)}\n\n`);
      return true;
    } catch {
      gone = true;
      return false;
    }
  };

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Without this a proxy will buffer the whole turn and deliver it at the end.
    "X-Accel-Buffering": "no",
  });
  if (res.flushHeaders) res.flushHeaders();

  try {
    for await (const frame of runTurn({
      messages: body.messages ?? [],
      title: body.title,
      model: body.model,
      mode: body.mode,
      sessionId: body.sessionId,
      plan: body.plan ?? null,
      files: Array.isArray(body.files) ? body.files : undefined,
      signal: controller.signal,
    })) {
      // Stop pulling on the agent the moment there is nobody to send it to.
      if (!send(frame)) break;
    }
  } catch (error) {
    // An abort is the reader leaving, not a failure worth reporting to them.
    if (!gone && !controller.signal.aborted) {
      const message = error instanceof Error ? error.message : "The turn failed.";
      send({ kind: "error", message });
      send({ kind: "end" });
    }
  }
  try {
    if (!res.writableEnded) res.end();
  } catch {
    /* the socket is already gone */
  }
}

/** POST /api/review — the manager's verdict on a finished turn. */
export async function handleReview(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    json(res, 405, { error: "Method not allowed" });
    return;
  }
  const body = await readJson(req);
  try {
    const verdict = await createSupervisor().review(body.digest ?? body);
    json(res, 200, verdict);
  } catch (error) {
    json(res, 500, {
      status: "unverified",
      summary: "The manager could not run.",
      issues: [error instanceof Error ? error.message : "unknown"],
      evidence: [],
      usedModel: false,
      approved: false,
    });
  }
}

/** POST /api/vision — frames in, words out. */
export async function handleVision(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    json(res, 405, { error: "Method not allowed" });
    return;
  }
  const body = await readJson(req);
  try {
    const results = [];
    for (const item of body.media ?? []) {
      results.push(
        await describeMedia({
          name: String(item.name ?? "attachment"),
          kind: item.kind === "video" ? "video" : "image",
          frames: Array.isArray(item.frames) ? item.frames : [],
          duration: typeof item.duration === "number" ? item.duration : undefined,
          question: typeof body.question === "string" ? body.question : undefined,
        }),
      );
    }
    json(res, 200, { results, context: visionContext(results) });
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : "Vision failed" });
  }
}

/**
 * POST /api/evidence — the baseline the manager measures against.
 *
 * It reads the project's own source and runs its typecheck, neither of which
 * exists on a serverless host, so it reports that plainly instead of returning
 * a baseline it could not take.
 */
export async function handleEvidence(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (isServerless()) {
    json(res, 200, {
      baseline: null,
      stale: true,
      unavailable: "The evidence baseline reads the project source, which a serverless host does not have.",
    });
    return;
  }

  const body = await readJson(req);
  try {
    const root = process.cwd();
    if (body.action === "capture") {
      const baseline = await captureBaseline(root, body.force === true);
      json(res, 200, { ...baseline, files: baseline.files.length });
      return;
    }
    const baseline = await loadBaseline(root);
    if (!baseline) {
      json(res, 200, { baseline: null, stale: true });
      return;
    }
    const diff = await diffFromBaseline(root, baseline);
    json(res, 200, {
      takenAt: baseline.takenAt,
      green: baseline.green,
      stale: isStale(baseline),
      fileCount: baseline.fileCount,
      diff,
    });
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : "failed" });
  }
}

/**
 * POST /api/files — the workspace as the canvas sees it.
 *
 * The canvas used to read code out of the chat, which stopped working the
 * moment the agent started writing real files instead of pasting them. This
 * returns what is actually on disk: the listing, and the contents of the text
 * files small enough to render.
 */
export async function handleFiles(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  const sessionId = String(body.sessionId ?? "");
  if (!sessionId) {
    json(res, 400, { error: "A sessionId is required." });
    return;
  }

  try {
    const workspace = await Workspace.open(sessionId);
    const listing = await workspace.list();
    const wanted = listing.filter((file) => READABLE.test(file.path) && file.bytes <= MAX_READ_BYTES);

    const files = await Promise.all(
      wanted.map(async (file) => ({
        path: file.path,
        bytes: file.bytes,
        modified: file.modified,
        content: await workspace.read(file.path).catch(() => ""),
      })),
    );

    json(res, 200, {
      files,
      // Files too large or too binary to render still belong in the listing.
      others: listing
        .filter((file) => !wanted.includes(file))
        .map((file) => ({ path: file.path, bytes: file.bytes, modified: file.modified })),
    });
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : "Could not read the workspace." });
  }
}

const READABLE = /\.(html?|css|m?js|jsx|tsx?|json|md|txt|svg|ya?ml)$/i;
const MAX_READ_BYTES = 400_000;

/** GET /api/health — what this deployment can actually do. */
export function handleHealth(_req: IncomingMessage, res: ServerResponse): void {
  const serverless = isServerless();
  const supervisor = createSupervisor();
  json(res, 200, {
    ok: true,
    // Never the key itself, and never the backend's name — only whether the
    // deployment is configured at all.
    worker: Boolean(process.env.NVIDIA_API_KEY),
    // Asked of the manager itself rather than of one variable: it falls back
    // through three credentials, so testing only the first reported a manager
    // that was missing when one was configured, and vice versa.
    manager: supervisor.mode === "model",
    managerMode: supervisor.mode,
    managerCanSee: supervisor.canSee,
    vision: Boolean(
      process.env.NOMIN_VISION_API_KEY ||
        process.env.NOMIN_SUPERVISOR_API_KEY ||
        process.env.NVIDIA_API_KEY,
    ),
    doctors: [1, 2, 3, 4, 5, 6].filter((n) => process.env[`NOMIN_DOCTOR_${n}_API_KEY`]).length,
    environment: serverless ? "serverless" : "server",
    capabilities: {
      tools: true,
      commands: !serverless,
      evidence: !serverless,
      persistentWorkspace: !serverless,
    },
  });
}
/**
 * POST /api/v1/generate - Custom API for external users.
 * Requires Authorization: Bearer <API_KEY>.
 */
export async function handleApiGenerate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    json(res, 405, { error: "Method not allowed" });
    return;
  }

  const auth = req.headers.authorization;
  const keys = (process.env.NOMIN_API_KEYS || "master-key-123").split(",").map(k => k.trim());
  
  if (!auth || !auth.startsWith("Bearer ") || !keys.includes(auth.slice(7).trim())) {
    json(res, 401, { error: "Unauthorized. Please email nominofficial2026@gmail.com to request an API key." });
    return;
  }

  const body = await readJson(req);
  if (!body.prompt) {
    json(res, 400, { error: "Missing 'prompt' in request body." });
    return;
  }

  const controller = new AbortController();
  
  // We don't stream for the REST API by default to make it easy for consumers,
  // we just collect the final files and return them as JSON.
  try {
    const finalFiles: Record<string, string> = {};
    const messages = [{ role: "user", content: body.prompt }];
    let pass = 0;
    const MAX_PASSES = 3;
    let resolved = false;

    while (pass < MAX_PASSES && !resolved) {
      pass++;
      let currentVerdict = null;
      let aiResponse = "";

      for await (const frame of runTurn({
        messages: messages as any,
        title: "API Generation",
        model: body.model || "core",
        mode: "balanced",
        sessionId: "api-" + Date.now(),
        plan: null,
        files: Object.keys(finalFiles).map(p => ({ path: p, bytes: finalFiles[p].length, content: finalFiles[p] })),
        signal: controller.signal,
      })) {
        if (frame.kind === "text" && frame.text) {
          aiResponse += frame.text;
        }
        if (frame.kind === "files" && frame.files) {
          for (const file of frame.files) {
            if (file.content) {
              finalFiles[file.path] = file.content;
            }
          }
        }
        if (frame.kind === "verdict" && frame.verdict) {
          currentVerdict = frame.verdict;
        }
      }
      
      messages.push({ role: "assistant", content: aiResponse });

      if (currentVerdict && (currentVerdict.status === "concerns" || currentVerdict.status === "failed")) {
        const brief = [
          "The review found this work incomplete. Fix it now - edit the files that exist, do not start over.",
          currentVerdict.summary,
          currentVerdict.issues.length ? "Findings:\n" + currentVerdict.issues.map((i: string) => "- " + i).join("\n") : "",
          "Finish the deliverable, then say what you changed and what you checked."
        ].filter(Boolean).join("\n\n");
        messages.push({ role: "user", content: brief });
        resolved = false;
      } else {
        resolved = true;
      }
    }
    
    json(res, 200, { success: true, passes: pass, verified: resolved, files: finalFiles });
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : "Generation failed." });
  }
}
