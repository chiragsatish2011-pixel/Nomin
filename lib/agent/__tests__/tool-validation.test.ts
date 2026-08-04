// Regressions for the container tool boundary.
//
// The headline symptom: run_command NEVER worked. The default cwd is ".", and
// "." was passed to the file-path validator, which rejects "." segments — so
// every command that did not explicitly name a cwd failed validation three
// times and aborted the turn.

// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

const emitted = [];
const ctx = { sessionId: "s1", stepId: 4, emit: (event) => emitted.push(event) };

vi.mock("../execution/bridge", () => ({
  awaitClientExecution: vi.fn(async () => ({ ok: true, output: "done", status: "success", step_id: 0 })),
}));

const { runTool } = await import("../tool-runner");

function turn(action, action_input) {
  return { thought: "t", action, action_input, done: false };
}

beforeEach(() => {
  emitted.length = 0;
});

describe("run_command", () => {
  it("accepts a command with no cwd (the workspace root)", async () => {
    const result = await runTool(turn("run_command", { command: "npm install" }), ctx);
    expect(result.ok).toBe(true);
    expect(emitted.some((e) => e.type === "tool_call")).toBe(true);
  });

  it("accepts an explicit '.' cwd", async () => {
    expect((await runTool(turn("run_command", { command: "npm run dev", cwd: "." }), ctx)).ok).toBe(true);
  });

  it("accepts a nested project cwd", async () => {
    expect((await runTool(turn("run_command", { command: "vite", cwd: "projects/web" }), ctx)).ok).toBe(true);
  });

  it("rejects an escape out of the workspace", async () => {
    const result = await runTool(turn("run_command", { command: "ls", cwd: "../.." }), ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/parent traversal/i);
  });

  it("explains that there is no shell, rather than failing opaquely", async () => {
    const result = await runTool(turn("run_command", { command: "npm install && npm run dev" }), ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ONE command per run_command call/);
  });

  it("blocks destructive commands", async () => {
    expect((await runTool(turn("run_command", { command: "rm -rf ." }), ctx)).ok).toBe(false);
  });
});

describe("paths", () => {
  it("accepts a plain relative path", async () => {
    expect((await runTool(turn("read_file", { path: "projects/web/src/App.tsx" }), ctx)).ok).toBe(true);
  });

  it("accepts the redundant './' form instead of costing a retry", async () => {
    expect((await runTool(turn("read_file", { path: "./package.json" }), ctx)).ok).toBe(true);
  });

  it("rejects absolute and host paths", async () => {
    for (const path of ["/home/project/a.ts", "C:/Users/x/a.ts", "../secret"]) {
      const result = await runTool(turn("read_file", { path }), ctx);
      expect(result.ok, path).toBe(false);
    }
  });

  it("carries the real step id onto the result", async () => {
    const result = await runTool(turn("read_file", { path: "package.json" }), ctx);
    expect(result.step_id).toBe(4);
  });

  it("accepts a small focused read and rejects oversized ranges", async () => {
    expect((await runTool(turn("read_file", { path: "src/App.tsx", startLine: 10, endLine: 20 }), ctx)).ok).toBe(true);
    expect((await runTool(turn("read_file", { path: "src/App.tsx", startLine: 1, endLine: 201 }), ctx)).ok).toBe(false);
  });

  it("rejects an empty write", async () => {
    const result = await runTool(turn("write_file", { path: "a.ts", content: "" }), ctx);
    expect(result.ok).toBe(false);
  });

  it("blocks environment and credential paths while allowing an env template", async () => {
    for (const path of [".env", ".env.local", "secrets/api.key", ".aws/credentials", "certs/site.pem", "id_rsa"]) {
      expect((await runTool(turn("read_file", { path }), ctx)).ok, path).toBe(false);
    }
    expect((await runTool(turn("read_file", { path: ".env.example" }), ctx)).ok).toBe(true);
  });

  it("blocks direct network utilities and commands targeting secrets", async () => {
    expect((await runTool(turn("run_command", { command: "curl https://example.com" }), ctx)).ok).toBe(false);
    expect((await runTool(turn("run_command", { command: "cat .env" }), ctx)).ok).toBe(false);
  });
});

describe("web_fetch", () => {
  it("rejects local and private-network destinations before fetching", async () => {
    for (const url of ["http://127.0.0.1:3000/", "http://10.0.0.4/private", "http://192.168.1.2/"]) {
      const result = await runTool(turn("web_fetch", { url }), ctx);
      expect(result.ok, url).toBe(false);
      expect(result.error).toMatch(/private|local/i);
    }
  });

  it("rejects credentials embedded in a URL", async () => {
    const result = await runTool(turn("web_fetch", { url: "https://user:secret@example.com/" }), ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/credentials/i);
  });
});
