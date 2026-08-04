"use client";

import { useEffect, useRef, useState } from "react";
import { Code2, Eye, X } from "lucide-react";
import { WebPreview } from "./WebPreview";
import type { ContainerStatus } from "@/app/lib/workspace-container";

export type LiveFile = {
  path: string;
  content: string;
};

type WorkPanelProps = {
  open: boolean;
  files: LiveFile[];
  /** True while the agent is still working — decides the default tab. */
  working: boolean;
  previewUrl: string | null;
  previewStatus: ContainerStatus;
  serverCommand: string | null;
  logs: string[];
  error: string | null;
  onStop: () => void;
  onClose: () => void;
};

/**
 * The side panel: code while it is being written, the running result once there
 * is one.
 *
 * WHY IT EXISTS
 *
 * A build takes tens of seconds during which the only feedback was a spinner
 * and a checklist. Watching the files actually appear is the difference between
 * waiting and watching — and it is honest feedback rather than a progress
 * animation, because every line on screen is content that was really sent to
 * write_file.
 *
 * The tab flips to Preview by itself the first time a dev server comes up, and
 * only that first time: after that the tab is the user's to choose, because
 * yanking someone out of the code they are reading every time the server
 * reloads is worse than showing them the wrong tab.
 */
export function WorkPanel({
  open,
  files,
  working,
  previewUrl,
  previewStatus,
  serverCommand,
  logs,
  error,
  onStop,
  onClose,
}: WorkPanelProps) {
  const [tab, setTab] = useState<"code" | "preview">("code");
  const [activePath, setActivePath] = useState<string | null>(null);
  const autoSwitched = useRef(false);
  const codeRef = useRef<HTMLPreElement | null>(null);

  // Follow the newest file while work is in flight; stop following the moment
  // the user picks one, so their selection is not stolen by the next write.
  const pinned = useRef(false);
  useEffect(() => {
    if (pinned.current || files.length === 0) return;
    setActivePath(files[files.length - 1].path);
  }, [files]);

  // One automatic hop to the preview, on the first URL only.
  useEffect(() => {
    if (!previewUrl || autoSwitched.current) return;
    autoSwitched.current = true;
    setTab("preview");
  }, [previewUrl]);

  // Keep the newest lines in view while a file streams in.
  useEffect(() => {
    if (tab !== "code" || pinned.current) return;
    const el = codeRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [files, tab]);

  if (!open) return null;

  const active = files.find((file) => file.path === activePath) ?? files[files.length - 1] ?? null;
  const lines = active ? active.content.split("\n") : [];

  return (
    <aside className="workPanel" aria-label="Work in progress">
      <header className="workPanelBar">
        <div className="workPanelTabs" role="tablist">
          <button
            className={tab === "code" ? "workPanelTab active" : "workPanelTab"}
            type="button"
            role="tab"
            aria-selected={tab === "code"}
            onClick={() => setTab("code")}
            title="Code"
          >
            <Code2 size={15} />
            <span className="workPanelTabLabel">Code</span>
          </button>
          <button
            className={tab === "preview" ? "workPanelTab active" : "workPanelTab"}
            type="button"
            role="tab"
            aria-selected={tab === "preview"}
            onClick={() => setTab("preview")}
            title="Preview"
          >
            <Eye size={15} />
            <span className="workPanelTabLabel">Preview</span>
          </button>
        </div>

        <span className="workPanelTitle">
          {tab === "code"
            ? active?.path ?? "No files yet"
            : previewUrl
              ? "Live preview"
              : working
                ? "Preview starting…"
                : "No preview yet"}
        </span>

        <button className="workPanelClose" type="button" onClick={onClose} title="Close panel" aria-label="Close panel">
          <X size={15} />
        </button>
      </header>

      {tab === "code" ? (
        <div className="workPanelBody">
          {files.length > 1 ? (
            <div className="workFileTabs" role="tablist">
              {files.map((file) => (
                <button
                  className={file.path === active?.path ? "workFileTab active" : "workFileTab"}
                  key={file.path}
                  type="button"
                  role="tab"
                  aria-selected={file.path === active?.path}
                  onClick={() => {
                    pinned.current = true;
                    setActivePath(file.path);
                  }}
                  title={file.path}
                >
                  {file.path.split("/").pop()}
                </button>
              ))}
            </div>
          ) : null}

          {active ? (
            <pre className="workCode" ref={codeRef}>
              <code>
                {lines.map((line, index) => (
                  <span className="workCodeLine" key={index}>
                    <span className="workCodeGutter">{index + 1}</span>
                    <span className="workCodeText">{line || " "}</span>
                  </span>
                ))}
              </code>
            </pre>
          ) : (
            <p className="workPanelEmpty">
              {working ? "Waiting for the first file…" : "Nothing has been written in this conversation yet."}
            </p>
          )}
        </div>
      ) : (
        <div className="workPanelBody preview">
          <WebPreview
            status={previewStatus}
            previewUrl={previewUrl}
            serverCommand={serverCommand}
            logs={logs}
            error={error}
            onStop={onStop}
          />
        </div>
      )}
    </aside>
  );
}
