"use client";

// useWebContainerExecutor — the client half of the execution bridge.
//
// It executes the agent's tool calls against the ONE workspace container
// (app/lib/workspace-container.ts) and posts typed results back to
// /api/trion/tool-result so the server's Step 3 loop can continue.
//
// The container is deliberately NOT released when a turn ends. It is the user's
// project: files written in turn 1 must still be there in turn 2, and a dev
// server started in turn 3 must keep serving the preview. Only "New thread"
// resets it.
//
// No host filesystem or host shell is ever touched.

import { useCallback, useSyncExternalStore } from "react";
import type { ToolResult } from "@/lib/agent/types";
import {
  boot,
  getWorkspaceServerState,
  getWorkspaceState,
  resetWorkspace,
  runTool,
  snapshot,
  stopDevServer,
  subscribeWorkspace,
  switchWorkspaceScope,
  type ContainerStatus,
} from "@/app/lib/workspace-container";

type ToolCallInput = {
  tool_name: string;
  tool_input: Record<string, unknown>;
  step_id: number;
  execution_id?: string;
};

export type ExecutorState = ContainerStatus;

// A browser-owned WebContainer can fail to boot or install without rejecting
// its promise. Do not let that silent client-side hang keep the server bridge
// alive through heartbeats forever; return a typed result before the server's
// own bridge timeout so the saved step can pause and resume cleanly.
const CLIENT_TOOL_TIMEOUT_MS = 35_000;
const WORKSPACE_READY_TIMEOUT_MS = 25_000;

async function withDeadline<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: number | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

async function runToolWithinDeadline(
  toolName: string,
  input: Record<string, unknown>,
  stepId: number,
): Promise<ToolResult> {
  let timer: number | undefined;
  try {
    return await Promise.race([
      runTool(toolName, input, stepId),
      new Promise<ToolResult>((resolve) => {
        timer = window.setTimeout(() => resolve({
          step_id: stepId,
          ok: false,
          status: "error",
          output: "",
          error: "The browser workspace did not become ready in time. Keep this tab open and retry the saved step.",
        }), CLIENT_TOOL_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

/**
 * The workspace belongs to the browser, so the first filesystem walk can wait
 * on WebContainer boot. It must never hold the entire chat request hostage:
 * planning can safely start from an empty snapshot while the same boot promise
 * continues in the background for the later tool call.
 */
export async function snapshotWithin(snapshotter: () => Promise<string[]>, timeoutMs = 4_000): Promise<string[]> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      snapshotter(),
      new Promise<string[]>((resolve) => {
        timeout = setTimeout(() => resolve([]), timeoutMs);
      }),
    ]);
  } catch {
    return [];
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export function useWebContainerExecutor() {
  const workspace = useSyncExternalStore(subscribeWorkspace, getWorkspaceState, getWorkspaceServerState);

  /** Warm the container ahead of the first turn so booting is not on the
   *  critical path of the user's first message. Safe to call repeatedly. */
  const prewarm = useCallback(() => {
    void boot().catch(() => undefined);
  }, []);

  /** Walk the container file tree and return POSIX-relative paths. */
  const getSnapshot = useCallback(async (): Promise<string[]> => {
    return snapshotWithin(snapshot);
  }, []);

  /**
   * Execution must not begin against an imaginary workspace.  Unlike the
   * landing-page prewarm, this is an explicit readiness boundary for a task:
   * wait for WebContainer to mount, then return the actual file tree.  It does
   * not wait for dependency installation, so opening a project remains quick;
   * commands retain their normal progress heartbeats while dependencies warm.
   */
  const prepareForExecution = useCallback(async (): Promise<string[]> => {
    await withDeadline(
      boot(),
      WORKSPACE_READY_TIMEOUT_MS,
      "The browser workspace did not become ready. Keep this tab open and retry the saved request.",
    );
    return withDeadline(
      snapshot(),
      8_000,
      "The browser workspace opened, but its files did not become readable. Retry the saved request.",
    );
  }, []);

  /** Execute a server-emitted tool call inside the container and POST the result. */
  const executeTool = useCallback(async (call: ToolCallInput, sessionId: string): Promise<void> => {
    const { execution_id: executionId, tool_name: toolName, tool_input: input, step_id: stepId } = call;
    if (!executionId) return;

    // Long-running commands (especially the sandbox's first dependency
    // install) are still healthy while they produce no final ToolResult. Keep
    // the server bridge alive until the actual result arrives.
    const heartbeat = window.setInterval(() => {
      void fetch("/api/trion/tool-progress", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, executionId }),
      }).catch(() => undefined);
    }, 10_000);

    let result: ToolResult;
    try {
      result = await runToolWithinDeadline(toolName, input, stepId);
    } catch (error) {
      result = {
        step_id: stepId,
        ok: false,
        status: "error",
        output: "",
        error: error instanceof Error ? error.message : "WebContainer tool execution failed.",
      };
    } finally {
      window.clearInterval(heartbeat);
    }

    // A tool can have completed perfectly while the dev route is briefly
    // unavailable after HMR or a network hiccup. A fire-and-forget POST then
    // leaves the server bridge waiting until its timeout. Acknowledging the
    // hand-off makes delivery reliable without re-running the tool itself.
    const payload = JSON.stringify({ sessionId, executionId, result });
    for (const delay of [0, 250, 750]) {
      if (delay) await new Promise((resolve) => window.setTimeout(resolve, delay));
      try {
        const response = await fetch("/api/trion/tool-result", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: payload,
        });
        if (response.ok || response.status === 404) return;
      } catch {
        // A later attempt may land after the route finishes recovering.
      }
    }
  }, []);

  /** Destroy the workspace and start clean. Only for "New thread". */
  const reset = useCallback(async (): Promise<void> => {
    await resetWorkspace();
  }, []);

  const switchScope = useCallback(async (scope: string): Promise<void> => {
    await switchWorkspaceScope(scope);
  }, []);

  return {
    state: workspace.status,
    bootError: workspace.error,
    booting: workspace.status === "booting" || workspace.status === "installing",
    previewUrl: workspace.previewUrl,
    serverCommand: workspace.serverCommand,
    logs: workspace.logs,
    prewarm,
    getSnapshot,
    prepareForExecution,
    executeTool,
    reset,
    switchScope,
    stopDevServer,
  };
}
