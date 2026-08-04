// A host-filesystem stand-in for the browser's WebContainer.
//
// The product executes tools in a WebContainer inside the user's tab, so
// anything server-side (tests, scripts, curl) hangs at the first tool call and
// execute-mode turns cannot be measured at all. This module plays the client
// half of the execution bridge against a real temp directory instead, mirroring
// app/lib/workspace-container.ts result-for-result: same JSON envelopes, same
// "a missing file is a successful read of a non-existent path" semantics, same
// long-running-process message. The agent loop cannot tell the difference,
// which is the point — it is the loop under measurement, not the sandbox.
//
// run_command is SIMULATED rather than shelled out. A benchmark that really
// runs `npm install` measures npm and the network, not the agent, and stops
// being reproducible. The simulated set covers what the plans actually emit.

import fs from "node:fs/promises";
import path from "node:path";

const MAX_READ_BYTES = 100_000;
const MAX_SEARCH_FILES = 400;

const BINARY_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2", ".ttf", ".mp4", ".mov", ".zip"]);

/** POSIX-relative, no escapes — the same normalisation the container applies. */
function normalizePath(value) {
  if (typeof value !== "string") return "";
  const clean = value.replace(/\\/g, "/").trim();
  if (!clean || clean.includes("\0")) return "";
  const segments = clean.split("/").filter((part) => part !== "" && part !== ".");
  if (segments.some((part) => part === "..")) return "";
  return segments.join("/");
}

function ok(stepId, output, artifacts) {
  return { step_id: stepId, ok: true, status: "success", output, ...(artifacts ? { artifacts } : {}) };
}

function fail(stepId, error) {
  return { step_id: stepId, ok: false, status: "error", output: "", error };
}

async function walk(root, dir = "", acc = []) {
  if (acc.length >= MAX_SEARCH_FILES) return acc;
  let entries;
  try {
    entries = await fs.readdir(path.join(root, dir), { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (acc.length >= MAX_SEARCH_FILES) break;
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await walk(root, rel, acc);
    else acc.push(rel);
  }
  return acc;
}

export async function snapshot(root) {
  return walk(root);
}

async function readFileTool(root, input, stepId) {
  const rel = normalizePath(input.path);
  if (!rel) return fail(stepId, "read_file requires action_input.path.");
  const abs = path.join(root, rel);
  try {
    const content = await fs.readFile(abs, "utf-8");
    if (content.length > MAX_READ_BYTES) {
      return ok(
        stepId,
        JSON.stringify({
          path: rel,
          truncated: true,
          content: content.slice(0, MAX_READ_BYTES),
          note: `File is ${content.length} characters; the first ${MAX_READ_BYTES} are shown.`,
        })
      );
    }
    return ok(stepId, JSON.stringify({ path: rel, content }));
  } catch {
    // Missing file is a FACT, reported as a successful read — matches the container.
    return ok(
      stepId,
      JSON.stringify({
        path: rel,
        exists: false,
        content: null,
        note: "This path does not exist yet. If the task is to create it, write it with write_file.",
      })
    );
  }
}

async function writeFileTool(root, input, stepId) {
  const rel = normalizePath(input.path);
  const content = typeof input.content === "string" ? input.content : "";
  if (!rel) return fail(stepId, "write_file requires action_input.path.");
  if (!content) return fail(stepId, "write_file content is empty. Emit the complete file body.");

  const abs = path.join(root, rel);
  let existed = true;
  try {
    await fs.access(abs);
  } catch {
    existed = false;
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf-8");
  return ok(
    stepId,
    `${existed ? "Updated" : "Created"} ${rel} (${content.length} characters, ${content.split("\n").length} lines).`,
    [{ type: existed ? "code_diff" : "file", language: rel.split(".").pop(), content }]
  );
}

async function searchTool(root, input, stepId) {
  const query = typeof input.query === "string" ? input.query.trim() : "";
  const maxResults = typeof input.maxResults === "number" ? Math.max(1, Math.min(50, input.maxResults)) : 20;
  if (!query) return fail(stepId, "search_codebase requires action_input.query.");

  const needle = query.toLowerCase();
  const results = [];
  for (const rel of await walk(root)) {
    if (results.length >= maxResults) break;
    if (BINARY_EXT.has(path.extname(rel))) continue;
    const content = await fs.readFile(path.join(root, rel), "utf-8").catch(() => "");
    if (!content || !content.toLowerCase().includes(needle)) continue;
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length && results.length < maxResults; i += 1) {
      if (lines[i].toLowerCase().includes(needle)) {
        results.push({ path: rel, line: i + 1, text: lines[i].trim().slice(0, 240) });
      }
    }
  }
  return ok(stepId, JSON.stringify({ query, results }));
}

/** Deterministic stand-in for the container's process spawning. Mirrors the
 *  container's three outcomes: long-running, clean exit, non-zero exit. */
function runCommandTool(input, stepId, opts) {
  const command = typeof input.command === "string" ? input.command.trim() : "";
  if (!command) return fail(stepId, "run_command requires action_input.command.");
  const [binary, ...args] = command.split(/\s+/);

  if (opts?.failCommands?.some((needle) => command.includes(needle))) {
    return fail(stepId, `Command exited with code 1.\nsh: ${binary}: command not found`);
  }

  const isDevServer = /\b(dev|serve|start|preview)\b/.test(command) && (binary === "npm" || binary === "npx" || binary === "nx" || binary === "yarn");
  if (isDevServer) {
    return ok(
      stepId,
      `The command is still running - this is a long-running process (dev server). Trion is watching for the server to come up and will show its preview URL automatically. Do NOT run it again or wait for it to exit. Output so far:\n  VITE ready in 431 ms\n  Local: http://0.0.0.0:5173/`
    );
  }
  if (binary === "npm" && args[0] === "install") {
    const pkg = args.slice(1).filter((a) => !a.startsWith("-")).join(" ");
    return ok(stepId, `added ${pkg ? 1 : 214} package${pkg ? "" : "s"}${pkg ? ` (${pkg})` : ""} in 3s`);
  }
  if (binary === "node" || binary === "npx" || binary === "tsc" || binary === "nx" || binary === "npm") {
    return ok(stepId, "Command completed successfully with no output.");
  }
  return fail(stepId, `Command exited with code 127.\nsh: ${binary}: command not found`);
}

export async function runTool(root, toolName, input, stepId, opts = {}) {
  switch (toolName) {
    case "read_file":
      return readFileTool(root, input, stepId);
    case "write_file":
      return writeFileTool(root, input, stepId);
    case "search_codebase":
      return searchTool(root, input, stepId);
    case "run_command":
      return runCommandTool(input, stepId, opts);
    default:
      return fail(stepId, `Unknown tool: ${toolName}`);
  }
}

// ---------------------------------------------------------------------------
// Seed — a trimmed version of app/components/nx-seed.ts. Same shape (Nx +
// npm workspaces, a runnable projects/web Vite app), small enough that the
// snapshot the agent sees is realistic without being noise.
// ---------------------------------------------------------------------------

export const SEED_FILES = {
  "package.json": JSON.stringify(
    { name: "workspace", private: true, workspaces: ["projects/*"], devDependencies: { nx: "^19.0.0", vite: "^5.2.0", typescript: "^5.4.0" } },
    null,
    2
  ),
  "nx.json": JSON.stringify({ $schema: "./node_modules/nx/schemas/nx-schema.json", targetDefaults: { build: { cache: true } } }, null, 2),
  "projects/web/package.json": JSON.stringify(
    { name: "web", private: true, scripts: { dev: "vite --host 0.0.0.0 --port 5173", build: "vite build" }, dependencies: { react: "^18.3.1", "react-dom": "^18.3.1" } },
    null,
    2
  ),
  "projects/web/index.html": `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>Web</title></head>
  <body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>
</html>
`,
  "projects/web/src/main.tsx": `import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<App />);
`,
  "projects/web/src/App.tsx": `import React from "react";

export default function App() {
  return (
    <div className="app">
      <h1>Welcome</h1>
      <p>Edit src/App.tsx to get started.</p>
    </div>
  );
}
`,
  "projects/web/src/styles.css": `.app {
  font-family: system-ui, sans-serif;
  padding: 2rem;
}
`,
};

export async function seedWorkspace(root, extra = {}) {
  await fs.rm(root, { recursive: true, force: true });
  for (const [rel, content] of Object.entries({ ...SEED_FILES, ...extra })) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf-8");
  }
  return root;
}
