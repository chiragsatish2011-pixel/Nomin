import { useEffect, useRef, useState } from "react";
import type { CanvasState } from "./artifacts.js";
import { assemble, type WorkspaceSnapshot } from "./workspace.js";
import { probeRuntime, type RuntimeCheck } from "./runtime.js";
import { captureDocument } from "./snapshot.js";
import type { ChatMessage, Verdict } from "./useAgent.js";

/** One thing the manager did, in the order it did it. */
export interface ReviewStep {
  id: string;
  label: string;
  state: "running" | "done" | "skipped" | "failed";
  /** What it found, once it is finished. */
  detail?: string;
  startedAt: number;
  endedAt?: number;
}

export interface MonitorState {
  status: "idle" | "capturing" | "reviewing" | "done" | "failed";
  /** Which turn this verdict belongs to, so a repair is only tried once. */
  turn?: number;
  verdict?: Verdict;
  /** What the page threw when it was actually executed. */
  runtimeErrors?: string[];
  /** The build that was reviewed, so a fix can name it. */
  reviewed?: string;
  /** True when the monitor was given a rendering to look at. */
  sawRendering: boolean;
  /**
   * The review as it happens. The card used to show one frozen line for the
   * whole pass, which read as a decoration rather than as work; these are the
   * actual stages, each one appearing when it starts and settling with what it
   * found.
   */
  steps: ReviewStep[];
  /** When the pass began, so the card can count up. */
  startedAt?: number;
  error?: string;
}

const idle: MonitorState = { status: "idle", sawRendering: false, steps: [] };

/**
 * Runs the manager once per finished turn.
 *
 * It waits until the turn is over — the review is about the delivered result,
 * and running it mid-stream would judge half a page. When the result is
 * previewable it rasterises it and executes it first, so the manager can look
 * at what was built and know whether it actually runs, rather than only
 * reading the code.
 */
export function useMonitor(
  messages: ChatMessage[],
  canvas: CanvasState,
  running: boolean,
  workspace?: WorkspaceSnapshot,
  activeBuild?: string | null,
): MonitorState {
  const [state, setState] = useState<MonitorState>(idle);
  const reviewed = useRef<string>("");

  useEffect(() => {
    if (running) return;
    const lastIndex = messages.length - 1;
    const last = messages[lastIndex];
    if (!last || last.role !== "assistant" || !last.content || last.error) return;

    // A conversational turn has nothing to verify. Reviewing it wastes a call
    // and puts a meaningless "Verified" badge under a one-line answer.
    const build = workspace?.builds.find((item) => item.entry === activeBuild) ?? workspace?.builds[0];
    const document = build && workspace ? assemble(build, workspace.files) : canvas.document;
    const fileList = workspace?.files.length
      ? workspace.files.map((file) => ({
          name: file.path,
          lines: file.content.split("\n").length,
        }))
      : canvas.artifacts
          // A fence that never closed is work in progress, not a deliverable.
          .filter((file) => !file.partial)
          .map((file) => ({
            name: file.name,
            lines: file.code.split("\n").length,
          }));

    const producedWork =
      Boolean(workspace?.files.length) ||
      canvas.artifacts.length > 0 ||
      (last.events ?? []).some((event) =>
        ["file.created", "file.modified", "tool.started", "command.started", "build.started", "test.started"].includes(
          event.type,
        ),
      );
    if (!producedWork) {
      setState(idle);
      return;
    }

    // One review per turn, keyed by what was actually produced.
    const key = `${lastIndex}:${last.content.length}:${fileList.length}:${document?.length ?? 0}`;
    if (reviewed.current === key) return;
    reviewed.current = key;

    let live = true;
    const startedAt = Date.now();

    /** Open a step. Every stage announces itself before it does the work. */
    const begin = (id: string, label: string) => {
      if (!live) return;
      setState((prev) => ({
        ...prev,
        steps: [...prev.steps, { id, label, state: "running", startedAt: Date.now() }],
      }));
    };
    const settle = (id: string, state: ReviewStep["state"], detail?: string) => {
      if (!live) return;
      setState((prev) => ({
        ...prev,
        steps: prev.steps.map((step) =>
          step.id === id && step.state === "running"
            ? { ...step, state, detail, endedAt: Date.now() }
            : step,
        ),
      }));
    };

    const run = async () => {
      const request =
        [...messages].reverse().find((message) => message.role === "user")?.content ?? "";

      setState({
        status: document ? "capturing" : "reviewing",
        sawRendering: false,
        steps: [],
        startedAt,
      });

      begin("read", "Reading what the turn produced");
      settle(
        "read",
        "done",
        fileList.length
          ? `${fileList.length} file${fileList.length === 1 ? "" : "s"}, ${fileList.reduce((sum, file) => sum + file.lines, 0)} lines`
          : "no files — judging the answer alone",
      );

      let screenshot: string | null = null;
      let runtime: RuntimeCheck | null = null;
      if (document) {
        begin("render", "Rendering the result to look at it");
        begin("execute", "Running the page to see what it throws");
        // Look at it, and run it: a picture cannot show a broken handler.
        [screenshot, runtime] = await Promise.all([
          captureDocument(document),
          probeRuntime(document),
        ]);
        if (!live) return;
        settle("render", screenshot ? "done" : "skipped", screenshot ? "captured" : "could not rasterise");
        settle(
          "execute",
          runtime?.errors.length ? "failed" : "done",
          runtime
            ? runtime.errors.length
              ? `${runtime.errors.length} runtime error${runtime.errors.length === 1 ? "" : "s"}`
              : `ran clean · ${runtime.nodes} elements`
            : "did not run",
        );
      }
      if (!live) return;

      setState((prev) => ({ ...prev, status: "reviewing" }));
      begin("judge", screenshot ? "Manager looking at the rendering" : "Manager reading the record");
      try {
        const response = await fetch("/api/review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            digest: {
              request,
              answer: last.content,
              // Verification events are previous opinions, not evidence;
              // including them lets a provisional verdict be quoted back as
              // though it were a finding.
              events: (last.events ?? [])
                .filter((event) => !event.type.startsWith("verification."))
                .map((event) => ({
                  type: event.type,
                  label: event.label,
                  detail: event.detail,
                })),
              durationMs: Date.now() - last.at,
              rateLimited: (last.events ?? []).some((event) => event.type === "cooldown.started"),
              empty: !last.content.trim(),
              // The workspace is the deliverable when the agent used tools.
              // This used to send the chat's code fences regardless, so on a
              // real build the manager was told "no files" about work that
              // had produced a dozen — and judged it accordingly.
              files: fileList,
              screenshot: screenshot ?? undefined,
              runtime: runtime ?? undefined,
            },
          }),
        });
        if (!response.ok) throw new Error(`The review endpoint answered ${response.status}.`);
        const verdict = (await response.json()) as Verdict;
        if (!live) return;
        settle(
          "judge",
          verdict.usedModel ? "done" : "skipped",
          verdict.usedModel
            ? verdict.approved
              ? "approved"
              : `sent back — ${verdict.status}`
            : (verdict.note ?? "evidence only"),
        );
        setState((prev) => ({
          ...prev,
          status: "done",
          turn: lastIndex,
          verdict,
          sawRendering: Boolean(verdict.sawRendering),
          runtimeErrors: runtime?.errors ?? [],
          reviewed: build?.entry,
        }));
      } catch (error) {
        if (!live) return;
        const message = error instanceof Error ? error.message : "The manager could not run.";
        settle("judge", "failed", message);
        setState((prev) => ({ ...prev, status: "failed", sawRendering: false, error: message }));
      }
    };

    void run();
    return () => {
      live = false;
    };
  }, [messages, canvas, running, workspace, activeBuild]);

  return state;
}
