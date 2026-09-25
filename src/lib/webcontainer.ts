import type { WebContainer, WebContainerProcess } from "@webcontainer/api";
import type { Artifact } from "./artifacts.js";

/**
 * The container runtime.
 *
 * WebContainer has three hard rules that a naive integration gets wrong, and
 * all three are handled here rather than in the UI:
 *
 *  1. **It needs cross-origin isolation.** Without `SharedArrayBuffer` and a
 *     secure, isolated context it cannot boot at all — so support is checked
 *     *before* anything is imported, and reported as a reason, not a crash.
 *  2. **It boots once per page.** A second `boot()` throws. The instance is a
 *     module-level singleton behind a promise, reused for every run.
 *  3. **Processes outlive their run.** A previous dev server keeps holding the
 *     port unless it is killed, so every run tears down the last one first.
 *
 * Nothing here reports "ready" until a server has actually answered with a
 * URL: an install that exits non-zero, a missing script, or a dev server that
 * never binds are all surfaced as failures with their logs.
 */

export type RunStatus =
  | "idle"
  | "checking"
  | "booting"
  | "mounting"
  | "installing"
  | "starting"
  | "ready"
  | "failed"
  | "unsupported";

export interface RunState {
  status: RunStatus;
  url?: string;
  error?: string;
  /** What the container actually printed. Trimmed to the tail. */
  log: string[];
  /** The npm script chosen for this project. */
  script?: string;
}

export interface Support {
  ok: boolean;
  reason?: string;
}

const INSTALL_TIMEOUT_MS = 180_000;
const SERVER_TIMEOUT_MS = 90_000;

/** Can this browser session run a container at all? Checked before importing. */
export function checkSupport(): Support {
  if (typeof window === "undefined") return { ok: false, reason: "No browser environment." };
  if (!window.isSecureContext) {
    return { ok: false, reason: "The page is not running in a secure context." };
  }
  if (typeof SharedArrayBuffer === "undefined") {
    return {
      ok: false,
      reason: "SharedArrayBuffer is unavailable, so a container cannot start in this browser.",
    };
  }
  if (!self.crossOriginIsolated) {
    return {
      ok: false,
      reason:
        "This page is not cross-origin isolated. The COOP/COEP headers are missing — reload after restarting the dev server.",
    };
  }
  return { ok: true };
}

let bootPromise: Promise<WebContainer> | null = null;
let current: WebContainerProcess[] = [];

/** Boot once, reuse forever. A second boot() would throw. */
async function getContainer(): Promise<WebContainer> {
  if (!bootPromise) {
    bootPromise = import("@webcontainer/api")
      .then(({ WebContainer }) => WebContainer.boot({ coep: "credentialless" }))
      .catch((error) => {
        // Let the next attempt try again rather than caching the failure.
        bootPromise = null;
        throw error;
      });
  }
  return bootPromise;
}

/** Kill whatever the previous run left running. */
async function teardown(): Promise<void> {
  const processes = current;
  current = [];
  await Promise.all(
    processes.map(async (process) => {
      try {
        process.kill();
        await process.exit;
      } catch {
        /* already gone */
      }
    }),
  );
}

export interface RunHandle {
  /** Stop the run and release the dev server. */
  dispose: () => Promise<void>;
}

/**
 * Mount the artifacts, install, start the dev server, and resolve when a
 * server is genuinely listening.
 */
export async function runProject(
  artifacts: Artifact[],
  update: (patch: Partial<RunState>) => void,
  push: (line: string) => void,
): Promise<RunHandle> {
  const support = checkSupport();
  if (!support.ok) {
    update({ status: "unsupported", error: support.reason });
    return { dispose: async () => {} };
  }

  const manifest = artifacts.find((file) => file.name.endsWith("package.json"));
  if (!manifest) {
    update({ status: "failed", error: "No package.json, so there is nothing to install or run." });
    return { dispose: async () => {} };
  }

  const script = pickScript(manifest.code);
  if (!script.ok) {
    update({ status: "failed", error: script.reason });
    return { dispose: async () => {} };
  }

  let cancelled = false;
  const dispose = async () => {
    cancelled = true;
    await teardown();
  };

  try {
    update({ status: "booting", script: script.name });
    const container = await getContainer();
    if (cancelled) return { dispose };

    await teardown();

    update({ status: "mounting" });
    await container.mount(toTree(artifacts));
    push(`mounted ${artifacts.length} file${artifacts.length === 1 ? "" : "s"}`);
    if (cancelled) return { dispose };

    update({ status: "installing" });
    const install = await container.spawn("npm", ["install"]);
    current.push(install);
    void install.output.pipeTo(new WritableStream({ write: (chunk) => push(String(chunk)) }));

    const installCode = await withTimeout(
      install.exit,
      INSTALL_TIMEOUT_MS,
      "npm install did not finish in time.",
    );
    if (cancelled) return { dispose };
    if (installCode !== 0) {
      update({ status: "failed", error: `npm install exited with code ${installCode}.` });
      return { dispose };
    }
    push("dependencies installed");

    update({ status: "starting" });
    const dev = await container.spawn("npm", ["run", script.name]);
    current.push(dev);
    void dev.output.pipeTo(new WritableStream({ write: (chunk) => push(String(chunk)) }));

    // "ready" means a server answered — not that a command was issued.
    const url = await Promise.race([
      new Promise<string>((resolve) => {
        container.on("server-ready", (_port, serverUrl) => resolve(serverUrl));
      }),
      dev.exit.then((code) => {
        throw new Error(`\`npm run ${script.name}\` exited with code ${code} before serving.`);
      }),
      delay(SERVER_TIMEOUT_MS).then(() => {
        throw new Error(
          `No server started within ${SERVER_TIMEOUT_MS / 1000}s. Check the log below.`,
        );
      }),
    ]);

    if (cancelled) return { dispose };
    update({ status: "ready", url });
    return { dispose };
  } catch (error) {
    if (!cancelled) {
      update({
        status: "failed",
        error: error instanceof Error ? error.message : "The container failed to start.",
      });
    }
    return { dispose };
  }
}

/** Find a script that actually serves something. */
function pickScript(manifest: string): { ok: true; name: string } | { ok: false; reason: string } {
  let parsed: { scripts?: Record<string, string> };
  try {
    parsed = JSON.parse(manifest) as { scripts?: Record<string, string> };
  } catch {
    return { ok: false, reason: "package.json is not valid JSON, so the project cannot be run." };
  }
  const scripts = parsed.scripts ?? {};
  const candidate = ["dev", "start", "preview", "serve"].find((name) => scripts[name]);
  if (!candidate) {
    return {
      ok: false,
      reason: "package.json has no dev, start, preview or serve script to run.",
    };
  }
  return { ok: true, name: candidate };
}

/** Artifact list → the nested tree the container expects. */
function toTree(artifacts: Artifact[]): Record<string, any> {
  const tree: Record<string, any> = {};
  for (const file of artifacts) {
    const parts = file.name.split("/").filter((part) => part && part !== ".");
    if (!parts.length) continue;
    let node = tree;
    parts.forEach((part, i) => {
      if (i === parts.length - 1) {
        node[part] = { file: { contents: file.code } };
      } else {
        node[part] ??= { directory: {} };
        node = node[part].directory;
      }
    });
  }
  return tree;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    delay(ms).then(() => {
      throw new Error(message);
    }),
  ]);
}
