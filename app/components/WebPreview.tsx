"use client";

// WebPreview — a window onto the ONE workspace container, not a second one.
//
// It used to POST the raw user prompt to /api/trion/preview, have a model
// generate a throwaway Vite app, boot its own WebContainer, and render that.
// So the "live preview" showed an app nobody had asked for, built from a
// different code path than the agent's, while the agent's real output was
// discarded. This component now renders the dev server running inside the
// container the agent actually wrote into.

import { useState } from "react";
import { Check, ChevronDown, Maximize2, Monitor, RotateCw, Smartphone, Square, Tablet, X } from "lucide-react";
import type { ContainerStatus } from "@/app/lib/workspace-container";

type WebPreviewProps = {
  status: ContainerStatus;
  previewUrl: string | null;
  serverCommand: string | null;
  logs: string[];
  error: string | null;
  onStop?: () => void;
};

const STATUS_LABEL: Record<ContainerStatus, string> = {
  idle: "Sandbox not started",
  booting: "Booting the sandbox",
  installing: "Installing dependencies",
  ready: "Sandbox ready",
  error: "Sandbox error",
};

export function WebPreview({ status, previewUrl, serverCommand, logs, error, onStop }: WebPreviewProps) {
  const [reloadKey, setReloadKey] = useState(0);
  const [viewport, setViewport] = useState<"desktop" | "tablet" | "mobile">("desktop");
  const [expanded, setExpanded] = useState(false);
  const live = Boolean(previewUrl);
  const label = error ?? (live ? "Preview running" : STATUS_LABEL[status]);

  return (
    <section className={`runtimePanel ${error ? "error" : live ? "complete" : "working"}`}>
      <div className="panelTitle split">
        <span>Live browser preview</span>
        <span className="previewState">
          {live ? <Check size={14} /> : <span className="miniPulse" />}
          {label}
        </span>
      </div>

      <p>
        {live
          ? serverCommand
            ? `Serving your workspace via “${serverCommand}”.`
            : "Serving your workspace."
          : "Trion runs your project inside an in-browser sandbox. Start a dev server and the running app appears here."}
      </p>

      {live && previewUrl ? (
        <>
          <div className="previewToolbar">
            <div className="previewDevices" role="group" aria-label="Preview size">
              <button className={viewport === "desktop" ? "active" : ""} type="button" onClick={() => setViewport("desktop")} title="Desktop preview" aria-label="Desktop preview">
                <Monitor size={14} />
              </button>
              <button className={viewport === "tablet" ? "active" : ""} type="button" onClick={() => setViewport("tablet")} title="Tablet preview" aria-label="Tablet preview">
                <Tablet size={14} />
              </button>
              <button className={viewport === "mobile" ? "active" : ""} type="button" onClick={() => setViewport("mobile")} title="Mobile preview" aria-label="Mobile preview">
                <Smartphone size={14} />
              </button>
            </div>
            <button type="button" onClick={() => setReloadKey((key) => key + 1)} title="Reload the preview" aria-label="Reload the preview">
              <RotateCw size={13} />
              <span>Reload</span>
            </button>
            <button type="button" onClick={() => setExpanded(true)} title="Open the preview full screen" aria-label="Open the preview full screen">
              <Maximize2 size={13} />
              <span>Open</span>
            </button>
            {onStop ? (
              <button type="button" onClick={onStop} title="Stop the dev server" aria-label="Stop the dev server">
                <Square size={12} />
                <span>Stop</span>
              </button>
            ) : null}
          </div>
          <div className={`previewCanvas ${viewport}`}>
            <iframe key={reloadKey} className="previewFrame" src={previewUrl} title="Trion workspace preview" />
          </div>
          {expanded ? (
            <div className="previewFullscreen" role="dialog" aria-modal="true" aria-label="Expanded live preview">
              <div className="previewFullscreenBar">
                <span>Live preview</span>
                <button type="button" onClick={() => setExpanded(false)} title="Close expanded preview" aria-label="Close expanded preview">
                  <X size={16} />
                </button>
              </div>
              <iframe key={`expanded-${reloadKey}`} className="previewFullscreenFrame" src={previewUrl} title="Expanded Trion workspace preview" />
            </div>
          ) : null}
        </>
      ) : (
        <div className="previewPreparing">
          <span className="previewWash" />
          <span>{label}</span>
        </div>
      )}

      {logs.length ? (
        <details className="previewLogs">
          <summary>
            <ChevronDown size={14} /> Runtime output
          </summary>
          <pre className="logWindow">
            <code>{logs.slice(-40).join("\n")}</code>
          </pre>
        </details>
      ) : null}
    </section>
  );
}
