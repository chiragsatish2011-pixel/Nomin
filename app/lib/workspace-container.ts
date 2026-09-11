"use client";

// The Trion workspace container — ONE WebContainer per tab, owned for the life
// of the session.
//
// WebContainer allows a single booted instance per tab. The previous design had
// two competing owners: the tool executor (which mounted the Nx seed and ran the
// agent's tool calls) and a separate preview component (which generated an
// unrelated Vite app from the raw prompt and mounted it into its own container).
// They took turns booting, so:
//   * every file the agent wrote was destroyed when the turn ended,
//   * a dev server the agent started was killed a moment later,
//   * and the "live preview" showed a throwaway app that had nothing to do with
//     the code the agent had just written.
//
// This module is the single owner. It boots once, mounts the Nx seed once, and
// stays up until the user starts a new thread. The agent writes into it, dev
// servers run inside it, and the preview frame renders that same container's
// server-ready URL — so what the user sees IS what the agent built.

import type { FileSystemTree, WebContainer, WebContainerProcess } from "@webcontainer/api";
import type { Artifact, ToolResult } from "@/lib/agent/types";
import { isSensitiveWorkspacePath } from "@/lib/agent/path-policy";
import { seedFileSystemTree } from "@/app/components/nx-seed";
import { selectReadWindow } from "@/app/lib/read-window";

const MAX_SEARCH_FILE_BYTES = 96_000;
const MAX_SEARCH_FILES = 1_500;
const MAX_LOG_LINES = 200;
/** A command still alive after this long is a server, not a hung one-shot. */
const LONG_RUNNING_GRACE_MS = 6_000;
const IGNORED_DIRS = new Set(["node_modules", ".next", ".git", "dist", "build", "coverage", ".turbo", ".nx"]);
const CHECKPOINT_KEY_PREFIX = "trion.workspace.checkpoint.v1";
const MAX_CHECKPOINT_BYTES = 900_000;

/** The open-source workspace is local-first. This scope is deliberately ready
 * at module load so durable recovery does not depend on the removed auth
 * hydration/scope-switch flow. */
let workspaceStorageScope = "local";

function checkpointKey(): string {
  return `${CHECKPOINT_KEY_PREFIX}:${encodeURIComponent(workspaceStorageScope)}`;
}

type WorkspaceCheckpoint = { version: 1; files: Record<string, string> };

export type ContainerStatus = "idle" | "booting" | "installing" | "ready" | "error";

export type WorkspaceState = {
  status: ContainerStatus;
  error: string | null;
  /** URL of the dev server running inside the container, when one is up. */
  previewUrl: string | null;
  /** The command that started the running server, for the preview header. */
  serverCommand: string | null;
  /** Rolling tail of container output — install, builds, dev server. */
  logs: string[];
};

let state: WorkspaceState = {
  status: "idle",
  error: null,
  previewUrl: null,
  serverCommand: null,
  logs: [],
};

const listeners = new Set<() => void>();

function emit(patch: Partial<WorkspaceState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function log(line: string) {
  const trimmed = line.replace(/\[[0-9;]*m/g, "").trimEnd();
  if (!trimmed) return;
  emit({ logs: [...state.logs, trimmed].slice(-MAX_LOG_LINES) });
}

export function subscribeWorkspace(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getWorkspaceState(): WorkspaceState {
  return state;
}

/** Server snapshot for useSyncExternalStore — the container never exists on the
 *  server, so this is a stable idle value (a new object each call would loop). */
const SERVER_STATE: WorkspaceState = { status: "idle", error: null, previewUrl: null, serverCommand: null, logs: [] };
export function getWorkspaceServerState(): WorkspaceState {
  return SERVER_STATE;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let bootPromise: Promise<WebContainer> | null = null;
let installPromise: Promise<void> | null = null;
/** The long-running dev server, if any. Starting a new one replaces it. */
let devProcess: WebContainerProcess | null = null;
let pageExitCleanupRegistered = false;

/**
 * A WebContainer worker belongs to one browser document. Without an explicit
 * release on reload/close, repeated refreshes leave detached workers alive
 * long enough to exhaust the provider's per-origin worker/request quota. That
 * looks to the user like a random tool timeout, although no agent decision is
 * at fault. Keep a bfcache-restored document intact, but release a document
 * that is genuinely being discarded. File writes are checkpointed separately,
 * so releasing the worker no longer means losing the user's project.
 */
function registerPageExitCleanup() {
  if (pageExitCleanupRegistered || typeof window === "undefined") return;
  pageExitCleanupRegistered = true;
  window.addEventListener("pagehide", (event) => {
    if (event.persisted) return;
    // Browsers do not wait for async pagehide work. Release the worker to avoid
    // leaked WebContainers, but preserve the write checkpoint so a reload can
    // restore the project instead of silently returning to the seed.
    void teardownWorkspace(false);
  });
}

export function boot(): Promise<WebContainer> {
  if (bootPromise) return bootPromise;

  registerPageExitCleanup();
  emit({ status: "booting", error: null });
  bootPromise = (async () => {
    const { WebContainer } = await import("@webcontainer/api");
    const container = await WebContainer.boot({ coep: "require-corp", forwardPreviewErrors: "exceptions-only" });

    container.on("server-ready", (port, url) => {
      emit({ previewUrl: url });
      log(`[trion] dev server ready on port ${port}`);
    });
    container.on("port", (port, type) => {
      if (type === "close" && state.previewUrl?.includes(String(port))) emit({ previewUrl: null });
    });
    container.on("error", (error) => log(`[error] ${error.message}`));

    await container.mount(seedFileSystemTree() as FileSystemTree);
    await restoreCheckpoint(container);
    await repairMissingStylesheetImports(container);
    emit({ status: "ready" });

    // Warm the workspace in the background. Without node_modules the agent's
    // very first `npx <anything>` pays a multi-minute install inside a tool call
    // that then looks like a hang; doing it here overlaps with the user typing.
    void ensureDependencies(container);

    return container;
  })();

  bootPromise.catch((error: unknown) => {
    bootPromise = null;
    emit({ status: "error", error: error instanceof Error ? error.message : "WebContainer failed to boot." });
  });

  return bootPromise;
}

/** Run the workspace-root install exactly once per container. */
export function ensureDependencies(container: WebContainer): Promise<void> {
  if (installPromise) return installPromise;

  installPromise = (async () => {
    emit({ status: "installing" });
    log("[trion] installing workspace dependencies…");
    let failure: string | null = null;
    try {
      const install = await container.spawn("npm", ["install", "--no-audit", "--no-fund"]);
      pipe(install);
      const code = await install.exit;
      if (code === 0) {
        log("[trion] dependencies installed");
      } else {
        failure = `[trion] npm install exited with ${code}`;
        log(failure);
      }
    } catch (error) {
      failure = `[trion] npm install could not start: ${error instanceof Error ? error.message : "unknown error"}`;
      log(failure);
    } finally {
      // A failed install must stay visible as an error: the old code emitted
      // "ready" on both branches, so the UI showed a healthy workspace whose
      // dependencies had never installed and the first command failed oddly.
      if (failure) emit({ status: "error", error: failure });
      else emit({ status: "ready" });
    }
  })();

  return installPromise;
}

/** Tear the container down and forget it. Only ever called for "New thread" —
 *  a turn ending must NOT destroy the workspace the next turn builds on. */
export async function resetWorkspace(): Promise<void> {
  await teardownWorkspace(true);
}

/** Preserve the old owner's checkpoint while releasing its in-memory sandbox. */
export async function switchWorkspaceScope(scope: string): Promise<void> {
  if (!scope || scope === workspaceStorageScope) return;
  await teardownWorkspace(false);
  workspaceStorageScope = scope;
}

/** Release the browser worker. Only New thread clears durable work. */
async function teardownWorkspace(clearCheckpoint: boolean): Promise<void> {
  const pending = bootPromise;
  bootPromise = null;
  installPromise = null;
  devProcess = null;
  emit({ status: "idle", error: null, previewUrl: null, serverCommand: null, logs: [] });
  if (clearCheckpoint) clearCheckpointStore();
  if (!pending) return;
  try {
    const container = await pending;
    await container.teardown();
  } catch {
    // Already torn down, or it never finished booting.
  }
}

export function stopDevServer() {
  devProcess?.kill();
  devProcess = null;
  emit({ previewUrl: null, serverCommand: null });
}

function pipe(process: WebContainerProcess) {
  void process.output
    .pipeTo(
      new WritableStream({
        write(data) {
          for (const line of String(data).split("\n")) log(line);
        },
      })
    )
    .catch(() => {
      // Stream closed with the process; exit codes still report failures.
    });
}

// ---------------------------------------------------------------------------
// Tools — the container half of the execution bridge
// ---------------------------------------------------------------------------

export async function runTool(toolName: string, input: Record<string, unknown>, stepId: number): Promise<ToolResult> {
  const container = await boot();
  switch (toolName) {
    case "read_file":
      return readFile(container, input, stepId);
    case "write_file":
      return writeFile(container, input, stepId);
    case "search_codebase":
      return search(container, input, stepId);
    case "run_command":
      return runCommand(container, input, stepId);
    default:
      return fail(stepId, `Unknown tool: ${toolName}`);
  }
}

export async function snapshot(): Promise<string[]> {
  const container = await boot();
  return walk(container, ".");
}

async function readFile(container: WebContainer, input: Record<string, unknown>, stepId: number): Promise<ToolResult> {
  const path = normalizePath(input.path);
  const startLine = typeof input.startLine === "number" ? input.startLine : undefined;
  const endLine = typeof input.endLine === "number" ? input.endLine : undefined;
  if (!path) return fail(stepId, "read_file requires action_input.path.");

  try {
    const content = await container.fs.readFile(path, "utf-8");
    return ok(stepId, JSON.stringify({ path, ...selectReadWindow(content, startLine, endLine) }));
  } catch {
    // A missing file is a FACT about the workspace, not a tool malfunction. It
    // is reported as a successful read of a non-existent path so the decision
    // loop can branch on it (usually: create it) instead of burning both
    // retries on a "failure" that will never succeed.
    const exists = await pathExists(container, path);
    if (!exists) {
      return ok(stepId, JSON.stringify({ path, exists: false, content: null, note: "This path does not exist yet. If the task is to create it, write it with write_file." }));
    }
    return fail(stepId, `"${path}" exists but could not be read as text (it may be a directory or a binary file).`);
  }
}

async function writeFile(container: WebContainer, input: Record<string, unknown>, stepId: number): Promise<ToolResult> {
  const path = normalizePath(input.path);
  const content = typeof input.content === "string" ? input.content : "";
  if (!path) return fail(stepId, "write_file requires action_input.path.");
  if (!content) return fail(stepId, "write_file content is empty. Emit the complete file body.");

  try {
    const existed = await pathExists(container, path);
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (dir) await container.fs.mkdir(dir, { recursive: true });
    await container.fs.writeFile(path, content, "utf-8");
    saveCheckpointFile(path, content);

    // A common model failure is importing a relative stylesheet from a new
    // React entry file without creating that stylesheet. Vite then stops at
    // import analysis and the preview becomes a blank error page. Create only
    // missing local CSS companions so the workspace remains runnable while
    // the agent continues; never synthesize arbitrary source files or packages.
    if (/\.(?:[cm]?[jt]sx?|jsx)$/i.test(path)) {
      const importedStyles = [...content.matchAll(/from\s+["'](\.\.?\/[^"']+\.css)["']|import\s+["'](\.\.?\/[^"']+\.css)["']/g)]
        .map((match) => match[1] ?? match[2])
        .filter(Boolean);
      for (const relative of importedStyles) {
        const stylePath = normalizePath(`${dir ? `${dir}/` : ""}${relative}`);
        if (!stylePath || await pathExists(container, stylePath)) continue;
        const placeholder = "/* Reserved for the component's styles. */\n";
        await container.fs.writeFile(stylePath, placeholder, "utf-8");
        saveCheckpointFile(stylePath, placeholder);
      }
    }

    const artifact: Artifact = {
      type: existed ? "code_diff" : "file",
      language: languageOf(path),
      content,
      // The panel shows a file tab per artifact; without the path every tab
      // read "Artifact 1", "Artifact 2" with no way to tell them apart.
      preview_url: undefined,
    };

    return {
      step_id: stepId,
      ok: true,
      status: "success",
      output: `${existed ? "Updated" : "Created"} ${path} (${content.length} characters, ${content.split("\n").length} lines).`,
      artifacts: [{ ...artifact, language: artifact.language ?? path.split(".").pop() }],
    };
  } catch (error) {
    return fail(stepId, messageOf(error, "Failed to write file."));
  }
}

async function search(container: WebContainer, input: Record<string, unknown>, stepId: number): Promise<ToolResult> {
  const query = typeof input.query === "string" ? input.query.trim() : "";
  const maxResults = typeof input.maxResults === "number" ? Math.max(1, Math.min(50, input.maxResults)) : 20;
  if (!query) return fail(stepId, "search_codebase requires action_input.query.");

  const needle = query.toLowerCase();
  const results: Array<{ path: string; line: number; text: string }> = [];

  try {
    const files = (await walk(container, ".")).slice(0, MAX_SEARCH_FILES);
    for (const filePath of files) {
      if (results.length >= maxResults) break;
      if (isProbablyBinary(filePath)) continue;
      // Secret material (.env, private keys) is listed but never searched:
      // read_file rejects these paths server-side, so allowing their contents
      // through search would teach the model a bypass for the same bytes.
      if (isSensitiveWorkspacePath(filePath)) continue;
      // Read ONCE. The previous implementation stat'ed each file by reading it
      // in full, then read it again to search — every file was loaded twice.
      const content = await container.fs.readFile(filePath, "utf-8").catch(() => "");
      if (!content || content.length > MAX_SEARCH_FILE_BYTES) continue;
      if (!content.toLowerCase().includes(needle)) continue;

      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length && results.length < maxResults; index += 1) {
        if (lines[index].toLowerCase().includes(needle)) {
          results.push({ path: filePath, line: index + 1, text: lines[index].trim().slice(0, 240) });
        }
      }
    }

    return ok(stepId, JSON.stringify({ query, results }));
  } catch (error) {
    return fail(stepId, messageOf(error, "Search failed."));
  }
}

async function runCommand(container: WebContainer, input: Record<string, unknown>, stepId: number): Promise<ToolResult> {
  const command = typeof input.command === "string" ? input.command.trim() : "";
  const rawCwd = typeof input.cwd === "string" ? normalizePath(input.cwd) : "";
  const cwd = rawCwd || ".";
  if (!command) return fail(stepId, "run_command requires action_input.command.");

  const [binary, ...args] = tokenize(command);
  if (!binary) return fail(stepId, "run_command requires a binary name.");

  // A dev server needs node_modules. Waiting on the background install here
  // turns "command not found" into "starts correctly, a bit later".
  if (binary === "npx" || binary === "npm" || binary === "node" || binary === "nx") {
    await installPromise?.catch(() => undefined);
  }

  log(`[trion] $ ${command}${cwd === "." ? "" : ` (cwd: ${cwd})`}`);

  try {
    const proc = await container.spawn(binary, args, { cwd });
    const chunks: string[] = [];
    void proc.output
      .pipeTo(
        new WritableStream({
          write(data) {
            chunks.push(String(data));
            for (const line of String(data).split("\n")) log(line);
          },
        })
      )
      .catch(() => undefined);

    const exited = proc.exit.then((code) => ({ kind: "exited" as const, code }));
    const stillRunning = new Promise<{ kind: "running" }>((resolve) => setTimeout(() => resolve({ kind: "running" }), LONG_RUNNING_GRACE_MS));
    const outcome = await Promise.race([exited, stillRunning]);
    const output = strip(chunks.join("")).trim();

    if (outcome.kind === "running") {
      // Long-running process: a dev server. Track it so the NEXT one replaces
      // it instead of stacking a second server on another port (which is how
      // the preview ended up pointing at an abandoned first attempt).
      if (devProcess && devProcess !== proc) devProcess.kill();
      devProcess = proc;
      emit({ serverCommand: command });
      return ok(
        stepId,
        `The command is still running — this is a long-running process (dev server). Trion is watching for the server to come up and will show its preview URL automatically. Do NOT run it again or wait for it to exit. Output so far:\n${output.slice(0, 1500) || "(none yet)"}`
      );
    }

    if (outcome.code !== 0) {
      return {
        step_id: stepId,
        ok: false,
        status: "error",
        output: "",
        error: `Command exited with code ${outcome.code}.\n${output.slice(0, 4000) || "(no output)"}`,
      };
    }
    return ok(stepId, output.slice(0, 8000) || "Command completed successfully with no output.");
  } catch (error) {
    return fail(
      stepId,
      `${messageOf(error, "Failed to start command.")} The binary may not be installed in the sandbox — run "npm install" in the directory that owns its package.json first, or invoke it through "npx".`
    );
  }
}

// ---------------------------------------------------------------------------
// Durable write checkpoint
// ---------------------------------------------------------------------------

function readCheckpoint(): WorkspaceCheckpoint | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(checkpointKey());
    if (!raw || raw.length > MAX_CHECKPOINT_BYTES) return null;
    const parsed = JSON.parse(raw) as Partial<WorkspaceCheckpoint>;
    if (parsed.version !== 1 || !parsed.files || typeof parsed.files !== "object") return null;
    const files = Object.fromEntries(
      Object.entries(parsed.files).filter(([path, content]) =>
        typeof path === "string" && path.length <= 512 && typeof content === "string" && content.length <= 500_000
      )
    );
    return { version: 1, files };
  } catch {
    return null;
  }
}

function saveCheckpointFile(path: string, content: string): void {
  if (typeof window === "undefined") return;
  const current = readCheckpoint() ?? { version: 1 as const, files: {} };
  const next: WorkspaceCheckpoint = { version: 1, files: { ...current.files, [path]: content } };
  try {
    const encoded = JSON.stringify(next);
    // Keep the checkpoint a recovery aid, never an unbounded second filesystem.
    if (encoded.length > MAX_CHECKPOINT_BYTES) return;
    window.localStorage.setItem(checkpointKey(), encoded);
  } catch {
    // Private mode or a full storage quota must not make a confirmed write fail.
  }
}

function clearCheckpointStore(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(checkpointKey());
  } catch {
    // Best-effort cleanup only.
  }
}

async function restoreCheckpoint(container: WebContainer): Promise<void> {
  const checkpoint = readCheckpoint();
  if (!checkpoint) return;

  for (const [path, content] of Object.entries(checkpoint.files)) {
    try {
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (dir) await container.fs.mkdir(dir, { recursive: true });
      await container.fs.writeFile(path, content, "utf-8");
    } catch {
      // A single stale path must not stop the rest of the project restoring.
    }
  }
}

/** Repair the narrow, deterministic class of preview failures caused by a
 * restored React/Vite entry file importing a local stylesheet that was never
 * checkpointed. This is intentionally limited to CSS imports: arbitrary
 * missing source files or packages still belong to the agent's tool loop and
 * must not be silently invented here. */
async function repairMissingStylesheetImports(container: WebContainer): Promise<void> {
  const files = await walk(container, ".");
  for (const path of files) {
    if (!/\.(?:[cm]?[jt]sx?|jsx)$/i.test(path)) continue;
    const content = await container.fs.readFile(path, "utf-8").catch(() => "");
    if (!content) continue;
    const importedStyles = [...content.matchAll(/from\s+["'](\.\.?\/[^"']+\.css)["']|import\s+["'](\.\.?\/[^"']+\.css)["']/g)]
      .map((match) => match[1] ?? match[2])
      .filter(Boolean);
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    for (const relative of importedStyles) {
      const stylePath = normalizePath(`${dir ? `${dir}/` : ""}${relative}`);
      if (!stylePath || await pathExists(container, stylePath)) continue;
      const styleDir = stylePath.includes("/") ? stylePath.slice(0, stylePath.lastIndexOf("/")) : "";
      if (styleDir) await container.fs.mkdir(styleDir, { recursive: true });
      const placeholder = "/* Reserved for the component's styles. */\n";
      await container.fs.writeFile(stylePath, placeholder, "utf-8");
      saveCheckpointFile(stylePath, placeholder);
      log(`[trion] repaired missing stylesheet ${stylePath}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function walk(container: WebContainer, dir: string): Promise<string[]> {
  const files: string[] = [];
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = (await container.fs.readdir(dir, { withFileTypes: true })) as typeof entries;
  } catch {
    return files;
  }

  for (const entry of entries) {
    const name = entry.name;
    // Dotfiles ARE part of the project (.gitignore, .env, .eslintrc). Only the
    // known-heavy tool directories are skipped; skipping every dotfile made
    // config files invisible to both search and the workspace snapshot.
    if (IGNORED_DIRS.has(name)) continue;
    const fullPath = dir === "." ? name : `${dir}/${name}`;
    if (entry.isDirectory()) {
      files.push(...(await walk(container, fullPath)));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

async function pathExists(container: WebContainer, path: string): Promise<boolean> {
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
  const base = path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path;
  try {
    const entries = await container.fs.readdir(dir, { withFileTypes: true });
    return entries.some((entry) => entry.name === base);
  } catch {
    return false;
  }
}

function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;
  let escaped = false;

  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

/** POSIX-relative, with the redundant "./" and duplicate separators removed. */
function normalizePath(value: unknown): string {
  if (typeof value !== "string") return "";
  const parts = value
    .replace(/\\/g, "/")
    .trim()
    .split("/")
    .filter((part) => part !== "" && part !== ".");
  if (parts.some((part) => part === "..")) return "";
  return parts.join("/");
}

function isProbablyBinary(filePath: string): boolean {
  return /\.(png|jpe?g|gif|webp|avif|ico|svgz|woff2?|ttf|eot|pdf|zip|gz|tar|mp[34]|wasm|lock)$/i.test(filePath);
}

function strip(value: string): string {
  return value.replace(/\[[0-9;]*m/g, "");
}

function languageOf(filePath: string): string | undefined {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    mjs: "javascript",
    cjs: "javascript",
    py: "python",
    css: "css",
    scss: "scss",
    html: "html",
    json: "json",
    md: "markdown",
    yml: "yaml",
    yaml: "yaml",
    sh: "bash",
  };
  return map[ext];
}

function ok(stepId: number, output: string): ToolResult {
  return { step_id: stepId, ok: true, status: "success", output };
}

function fail(stepId: number, error: string): ToolResult {
  return { step_id: stepId, ok: false, status: "error", output: "", error };
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
