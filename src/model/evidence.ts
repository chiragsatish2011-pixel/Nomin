import { execFile } from "node:child_process";
import { readdir, readFile, stat, mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * The evidence baseline — what "green" looks like.
 *
 * The manager cannot tell "this is broken" from "this was always like that"
 * without a record of the last known-good state. This module takes that record:
 * the files that exist, their sizes and hashes, and whether the project's own
 * checks passed. It is the thing a repair is measured against, and the thing a
 * repair must restore.
 *
 * It refreshes every 24 hours, and deliberately not more often — a baseline
 * taken too eagerly will happily record a broken state as normal.
 */

export interface FileFact {
  path: string;
  bytes: number;
  /** Cheap content fingerprint; enough to notice a file changed. */
  hash: string;
}

export interface Baseline {
  takenAt: number;
  /** True when the project's own checks passed at capture time. */
  green: boolean;
  typecheck: { ok: boolean; output: string };
  files: FileFact[];
  fileCount: number;
  totalBytes: number;
}

export interface Difference {
  added: string[];
  removed: string[];
  changed: string[];
  /** Plain sentences the manager can hand to the doctors. */
  summary: string[];
}

const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STORE = ".nomin";
const FILE = "baseline.json";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "dist-demo", ".nomin", ".vite", "coverage"]);
const WATCH_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".css", ".html", ".json"]);

/** Load the stored baseline, or null when there is none or it is unreadable. */
export async function loadBaseline(root: string): Promise<Baseline | null> {
  try {
    const raw = await readFile(join(root, STORE, FILE), "utf8");
    return JSON.parse(raw) as Baseline;
  } catch {
    return null;
  }
}

export const isStale = (baseline: Baseline | null): boolean =>
  !baseline || Date.now() - baseline.takenAt > MAX_AGE_MS;

/**
 * Capture a fresh baseline. Refuses to overwrite a green baseline with a
 * broken one: recording a failing state as "normal" is how a self-healing
 * system learns to ignore its own illness.
 */
export async function captureBaseline(root: string, force = false): Promise<Baseline> {
  const existing = await loadBaseline(root);
  if (!force && existing && !isStale(existing)) return existing;

  const files = await collectFiles(root);
  const typecheck = await runTypecheck(root);
  const baseline: Baseline = {
    takenAt: Date.now(),
    green: typecheck.ok,
    typecheck,
    files,
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
  };

  if (existing?.green && !baseline.green && !force) {
    // Keep the last healthy record; return the new reading for comparison.
    return { ...baseline, takenAt: existing.takenAt };
  }

  await mkdir(join(root, STORE), { recursive: true });
  await writeFile(join(root, STORE, FILE), JSON.stringify(baseline, null, 2), "utf8");
  return baseline;
}

/** What changed since the baseline was taken. */
export async function diffFromBaseline(root: string, baseline: Baseline): Promise<Difference> {
  const now = await collectFiles(root);
  const before = new Map(baseline.files.map((file) => [file.path, file]));
  const after = new Map(now.map((file) => [file.path, file]));

  const added = [...after.keys()].filter((path) => !before.has(path));
  const removed = [...before.keys()].filter((path) => !after.has(path));
  const changed = [...after.keys()].filter((path) => {
    const old = before.get(path);
    return old && old.hash !== after.get(path)!.hash;
  });

  const summary: string[] = [];
  if (added.length) summary.push(`${added.length} file(s) added since the last healthy state.`);
  if (removed.length) summary.push(`${removed.length} file(s) removed: ${removed.slice(0, 5).join(", ")}.`);
  if (changed.length) summary.push(`${changed.length} file(s) changed: ${changed.slice(0, 8).join(", ")}.`);
  if (!summary.length) summary.push("No file has changed since the last healthy state.");

  return { added, removed, changed, summary };
}

/** The project's own gate. If this fails, the system is not green. */
export async function runTypecheck(root: string): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await run("npx", ["tsc", "--noEmit"], {
      cwd: root,
      timeout: 180_000,
      windowsHide: true,
      shell: process.platform === "win32",
    });
    return { ok: true, output: `${stdout}${stderr}`.trim().slice(0, 4000) };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    const output = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() || err.message || "typecheck failed";
    return { ok: false, output: output.slice(0, 4000) };
  }
}

async function collectFiles(root: string): Promise<FileFact[]> {
  const facts: FileFact[] = [];

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(full);
        continue;
      }
      const dot = entry.name.lastIndexOf(".");
      const ext = dot === -1 ? "" : entry.name.slice(dot);
      if (!WATCH_EXT.has(ext)) continue;
      try {
        const info = await stat(full);
        const content = await readFile(full, "utf8");
        facts.push({ path: relative(root, full).replace(/\\/g, "/"), bytes: info.size, hash: fingerprint(content) });
      } catch {
        /* unreadable files are simply not part of the record */
      }
    }
  };

  await walk(root);
  return facts.sort((a, b) => a.path.localeCompare(b.path));
}

/** A small, fast, dependency-free content hash. */
function fingerprint(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 16777619) >>> 0;
    h2 = Math.imul(h2 + code, 2246822519) >>> 0;
  }
  return `${h1.toString(16)}${h2.toString(16)}`;
}
