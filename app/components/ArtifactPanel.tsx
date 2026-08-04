"use client";

import { useState } from "react";
import { Check, Copy, FileCode2, Globe, X } from "lucide-react";
import type { Artifact } from "@/lib/agent/types";

// ---------------------------------------------------------------------------
// ArtifactPanel — side panel opened when AgentOutput.artifacts is non-empty
// after Step 5 resolves. Code view + rendered preview for previewable types.
// Slides in with a spring entrance while the chat column resizes in sync.
// ---------------------------------------------------------------------------

function artifactName(artifact: Artifact, index: number): string {
  if (artifact.type === "preview" && artifact.preview_url) {
    return `preview-${index + 1}`;
  }
  return `artifact-${index + 1}${artifact.language ? `.${artifact.language}` : ""}`;
}

function isPreviewable(artifact: Artifact): boolean {
  if (artifact.type === "preview") return true;
  const trimmed = artifact.content.trim().toLowerCase();
  return trimmed.startsWith("<!doctype html") || trimmed.startsWith("<html");
}

type ArtifactPanelProps = {
  artifacts: Artifact[];
  open: boolean;
  onClose: () => void;
  /** URL of a running dev server inside the WebContainer — rendered as a
   *  live-preview tab at the end of the artifact list. */
  previewUrl?: string | null;
};

export function ArtifactPanel({ artifacts, open, onClose, previewUrl }: ArtifactPanelProps) {
  const [active, setActive] = useState(0);
  const [copied, setCopied] = useState(false);

  if (!open || (artifacts.length === 0 && !previewUrl)) return null;

  const liveIndex = previewUrl ? artifacts.length : -1;
  const totalTabs = artifacts.length + (previewUrl ? 1 : 0);
  const safeIndex = Math.min(active, totalTabs - 1);
  const isLive = previewUrl !== undefined && previewUrl !== null && safeIndex === liveIndex;
  const artifact = isLive
    ? ({ type: "preview", content: "", preview_url: previewUrl } as Artifact)
    : artifacts[Math.min(safeIndex, artifacts.length - 1)];
  const previewable = isLive ? true : isPreviewable(artifact);

  async function copyContent() {
    try {
      await navigator.clipboard.writeText(artifact.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard unavailable — ignore
    }
  }

  return (
    <aside className="artifactPanel" aria-label="Build artifact">
      <div className="artifactPanelHead">
        <span className="artifactPanelTitle">
          {previewable ? <Globe size={14} /> : <FileCode2 size={14} />}
          Build result
        </span>
        <button className="artifactPanelClose" type="button" onClick={onClose} title="Close panel" aria-label="Close build artifact panel">
          <X size={16} />
        </button>
      </div>

      {totalTabs > 1 ? (
        <div className="artifactTabs" role="tablist">
          {artifacts.map((a, i) => (
            <button
              className={i === safeIndex ? "artifactTab active" : "artifactTab"}
              key={i}
              onClick={() => setActive(i)}
              role="tab"
              type="button"
              title={artifactName(a, i)}
            >
              {artifactName(a, i)}
            </button>
          ))}
          {previewUrl ? (
            <button
              className={safeIndex === liveIndex ? "artifactTab active" : "artifactTab"}
              key="live"
              onClick={() => setActive(liveIndex)}
              role="tab"
              type="button"
            >
              <Globe size={12} />
              Live preview
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="artifactPanelBody">
        {previewable ? (
          isLive ? (
            <iframe
              className="artifactPreviewFrame"
              src={previewUrl ?? ""}
              title="Live dev-server preview"
              sandbox="allow-scripts allow-same-origin"
            />
          ) : (
            <iframe className="artifactPreviewFrame" srcDoc={artifact.content} title={artifactName(artifact, safeIndex)} sandbox="allow-scripts" />
          )
        ) : (
          <div className="artifactCodeWrap">
            <pre><code>{artifact.content}</code></pre>
          </div>
        )}
      </div>

      <div className="artifactPanelFoot">
        <span className="artifactPanelMeta">
          {isLive ? "live dev server" : artifact.type === "code_diff" ? "modified file" : artifact.type === "file" ? "new file" : "preview"}
        </span>
        {!isLive ? (
          <button className="artifactCopyButton" type="button" onClick={copyContent}>
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {copied ? "Copied" : "Copy file"}
          </button>
        ) : null}
      </div>
    </aside>
  );
}
