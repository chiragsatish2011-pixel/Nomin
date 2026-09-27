import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas } from "./components/Canvas.js";
import { Composer, type Mode } from "./components/Composer.js";
import { describe as describeCheckpoint } from "./lib/checkpoints.js";
import { Mark, MarkWatermark } from "./components/Mark.js";
import { Markdown } from "./components/Markdown.js";
import { ReportCard } from "./components/ReportCard.js";
import { ThinkingBlock } from "./components/ThinkingBlock.js";
import { CommandPalette, type Command } from "./components/CommandPalette.js";
import { PlanCard } from "./components/PlanCard.js";
import { QuestionCard } from "./components/QuestionCard.js";
import { Templates } from "./components/Templates.js";
import { parsePlan } from "./model/plan.js";
import { prepare, type PreparedAttachment } from "./lib/media.js";
import { readCanvas } from "./lib/artifacts.js";
import { listen, speak, stopSpeaking, voiceSupport } from "./lib/voice.js";
import { createZip, download } from "./lib/zip.js";
import { useMonitor, type MonitorState } from "./lib/useMonitor.js";
import { formatAnswers, hasPartialBlock, parseQuestions } from "./lib/questions.js";
import { readTheme, storeTheme, watchSystemTheme, type Theme } from "./lib/theme.js";
import { useAgent, type ChatMessage, type Verdict } from "./lib/useAgent.js";
import type { Build } from "./lib/workspace.js";
import type { Plan, PlanStatus } from "./model/plan.js";

const MODEL_NAME = "Trion 1.5";

/** Repairs attempted per turn before the agent stops and reports honestly. */
const MAX_REPAIRS = 2;

/** A file-safe name taken from whatever the thing is called. */
function slug(text: string): string {
  const cleaned = text
    .slice(0, 40)
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return cleaned || "nomin";
}

export default function App() {
  // Resolved once from storage, then the OS — so a hard refresh keeps it.
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [mode, setMode] = useState<Mode>("balanced");
  const [draft, setDraft] = useState("");
  // The canvas stays out of the way until it has something to show: the user
  // opens it, or the agent produces something runnable and it opens itself.
  const [canvasOpen, setCanvasOpen] = useState(false);
  const [attachments, setAttachments] = useState<PreparedAttachment[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [apiModalOpen, setApiModalOpen] = useState(false);
  const [conversation, setConversation] = useState(false);
  const spokenFor = useRef<number>(-1);
  const micRef = useRef<{ stop: () => void; abort: () => void } | null>(null);
  // How many repairs this session has attempted, and for which turn. Bounded
  // on purpose: an agent that cannot fix something must not retry for ever.
  const repairs = useRef<{ turn: number; consecutive: number }>({ turn: -1, consecutive: 0 });
  const [canvasPinnedShut, setCanvasPinnedShut] = useState(false);
  /**
   * The side panel.
   *
   * Open on a screen with room for it, shut on one without — a drawer that
   * starts over the conversation on a phone is in the way before it is useful.
   * From then on it is the user's choice, at every width.
   */
  const [railOpen, setRailOpen] = useState(
    () => typeof window === "undefined" || window.innerWidth > 900,
  );
  const {
    messages,
    running,
    usage,
    status,
    cooldown,
    send,
    stop,
    reset,
    sessions,
    sessionId,
    openSession,
    plan,
    planStatus,
    approvePlan,
    requestPlanChanges,
    workspaceFiles,
    workspace,
    addManagerNote,
    recordVerdict,
    checkpoints,
    restoreCheckpoint,
    activeBuild,
    setActiveBuild,
  } = useAgent();

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Follow the operating system until the user picks for themselves.
  useEffect(() => watchSystemTheme(setTheme), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing =
        event.target instanceof HTMLElement &&
        (event.target.tagName === "INPUT" || event.target.tagName === "TEXTAREA");

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (event.key === "Escape" && !typing) {
        setPaletteOpen(false);
        // Escape dismisses the drawer, but only where it is a drawer — on a
        // wide screen the panel is part of the layout and should stay put.
        if (window.innerWidth <= 900) setRailOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((current) => {
      const next = current === "light" ? "dark" : "light";
      storeTheme(next);
      return next;
    });
  }, []);

  const attach = useCallback(async (files: FileList | null) => {
    if (!files?.length) return;
    setAttaching(true);
    try {
      const prepared = await Promise.all(Array.from(files).map((file) => prepare(file)));
      // A re-uploaded name replaces the previous upload — the old code dropped
      // the new file when the name already existed, so the stale preview stayed.
      setAttachments((current) => {
        const byName = new Map(current.map((item) => [item.name, item]));
        for (const item of prepared) byName.set(item.name, item);
        return [...byName.values()];
      });
    } finally {
      setAttaching(false);
    }
  }, []);

  /** A camera still has already been through prepare(); take it as it is. */
  const addPrepared = useCallback((items: PreparedAttachment[]) => {
    setAttachments((current) => [...current, ...items]);
  }, []);

  const removeAttachment = useCallback((idOrName: string) => {
    setAttachments((current) =>
      current.filter((item) => item.id !== idOrName && item.name !== idOrName),
    );
  }, []);

  const submit = useCallback(() => {
    const text = draft.trim();
    repairs.current = { turn: -1, consecutive: 0 };
    if ((!text && !attachments.length) || running) return;
    setDraft("");
    const pending = attachments;
    setAttachments([]);
    void send(text, mode, undefined, pending);
  }, [attachments, draft, mode, running, send]);

  const retry = useCallback(() => {
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    if (lastUser && !running) void send(lastUser.content, mode);
  }, [messages, mode, running, send]);

  const answerQuestions = useCallback(
    (text: string) => {
      if (!running) void send(text, mode);
    },
    [mode, running, send],
  );

  const approveAndBuild = useCallback(() => {
    if (!plan) return;
    approvePlan();
    // The plan travels with the request, not through state: this call is what
    // unlocks the tools, so it cannot wait for a re-render.
    void send("Plan approved. Build it exactly as agreed.", mode, plan);
  }, [approvePlan, mode, plan, send]);

  const sendPlanChanges = useCallback(
    (note: string) => {
      const text = requestPlanChanges(note);
      if (text) void send(`Change the plan: ${text}`, mode);
    },
    [mode, requestPlanChanges, send],
  );

  /** Hand a failure straight back to the agent, with the plan still in force. */
  const requestFix = useCallback(
    (brief: string, internal = false) => {
      if (running) return;
      void send(brief, mode, planStatus === "approved" ? plan : null, undefined, internal);
    },
    [mode, plan, planStatus, running, send],
  );

  /** Take the work out of the browser as an archive that opens anywhere. */
  const downloadWorkspace = useCallback(() => {
    const files = workspace.files.length
      ? workspace.files.map((file) => ({ path: file.path, content: file.content }))
      : readCanvas(messages).artifacts.map((file) => ({ path: file.name, content: file.code }));
    if (!files.length) return;
    download(createZip(files), `${slug(messages[0]?.content ?? "nomin")}.zip`);
  }, [messages, workspace.files]);

  /**
   * Download one build on its own.
   *
   * A session that produced a coffee shop and then an ice cream shop holds two
   * separate things, and handing over the whole workspace would mix them. A
   * build is its entry point plus the files it references, so that is exactly
   * what goes in the archive — and its entry is renamed to index.html so the
   * zip opens straight into the page it is.
   */
  const downloadBuild = useCallback(
    (entry: string) => {
      const build = workspace.builds.find((item) => item.entry === entry);
      if (!build) return;
      const wanted = new Set(build.files);
      const files = workspace.files
        .filter((file) => wanted.has(file.path))
        .map((file) => ({
          path: file.path === build.entry && !/(^|\/)index\.html?$/i.test(file.path)
            ? "index.html"
            : file.path,
          content: file.content,
        }));
      if (!files.length) return;
      download(createZip(files), `${slug(build.title || build.entry)}.zip`);
    },
    [workspace.builds, workspace.files],
  );

  /** On a narrow screen the drawer has done its job once something is picked. */
  const dismissRail = useCallback(() => {
    if (typeof window !== "undefined" && window.innerWidth <= 900) setRailOpen(false);
  }, []);

  const startSession = useCallback(() => {
    reset();
    dismissRail();
  }, [dismissRail, reset]);

  const pickSession = useCallback(
    (id: string) => {
      void openSession(id);
      dismissRail();
    },
    [dismissRail, openSession],
  );

  /** Show one build, and nothing else, in the canvas. */
  const openBuild = useCallback((entry: string) => {
    setActiveBuild(entry);
    setCanvasPinnedShut(false);
    setCanvasOpen(true);
  }, [setActiveBuild]);

  const canvas = useMemo(() => readCanvas(messages), [messages]);
  const monitor = useMonitor(messages, canvas, running, workspace, activeBuild);
  /**
   * Close the loop: a verdict of failed or concerns sends the agent back to
   * work with the manager's findings as the brief. Without this the manager
   * writes an accurate report that nothing acts on.
   */
  useEffect(() => {
    if (running || monitor.status !== "done" || !monitor.verdict) return;
    const verdict = monitor.verdict;
    // The manager's verdict belongs to the turn it judged, so it survives
    // scrolling past: the badge on an old turn must still say what the
    // manager decided, not the provisional evidence read the server made.
    if (monitor.turn !== undefined) recordVerdict(monitor.turn, verdict);
    if (verdict.status !== "failed" && verdict.status !== "concerns") {
      // Work that was sent back and has now passed gets said out loud. This
      // is the only point at which the user hears about the round trip, and
      // they hear the outcome rather than the failure that started it.
      // Approval is the manager's to give, and it is the manager that says so.
      // The worker never closes a turn itself, so this line is the only place
      // the work is called finished — and it appears only once the review has
      // actually passed.
      if (verdict.status === "verified" && verdict.usedModel) {
        addManagerNote(
          repairs.current.consecutive > 0
            ? `Approved. The work came back, was fixed, and now checks out — ${verdict.summary}`
            : `Approved — ${verdict.summary}`,
        );
      }
      // Back to healthy: the next problem gets a full repair budget again.
      repairs.current = { turn: monitor.turn ?? -1, consecutive: 0 };
      return;
    }
    if (planStatus !== "approved") return; // without tools it cannot repair anything

    const turn = monitor.turn ?? messages.length - 1;
    if (repairs.current.turn === turn) return; // already handled this verdict

    // Count consecutive repairs, not repairs per turn: each repair creates a
    // new turn, so a per-turn cap would reset itself and never stop.
    if (repairs.current.consecutive >= MAX_REPAIRS) return;
    repairs.current = { turn, consecutive: repairs.current.consecutive + 1 };

    const brief = [
      "The review found this work incomplete. Fix it now — edit the files that exist, do not start over.",
      verdict.summary,
      monitor.runtimeErrors?.length
        ? `It throws at runtime:\n${monitor.runtimeErrors.map((error) => `- ${error}`).join("\n")}`
        : "",
      verdict.issues.length ? `Findings:\n${verdict.issues.map((issue) => `- ${issue}`).join("\n")}` : "",
      "Finish the deliverable, then say what you changed and what you checked.",
    ]
      .filter(Boolean)
      .join("\n\n");

    // Sent as Nomin's own follow-up, not as words the user typed. What they
    // see is the manager taking the work back, not an instruction they never
    // wrote — and the finished result once it has actually been checked.
    requestFix(brief, true);
  }, [addManagerNote, messages.length, monitor, planStatus, recordVerdict, requestFix, running]);

  /**
   * Conversation mode.
   *
   * When a turn finishes, the answer is read aloud and the microphone opens
   * again — so a build can be steered while looking at the preview rather than
   * the keyboard. It stops the moment the mode is switched off, and it never
   * listens while it is talking, which would otherwise hear itself.
   */
  useEffect(() => {
    if (!conversation) {
      stopSpeaking();
      micRef.current?.abort();
      micRef.current = null;
      return;
    }
    if (running) return;

    const index = messages.length - 1;
    const last = messages[index];
    if (!last || last.role !== "assistant" || !last.content || spokenFor.current === index) return;
    spokenFor.current = index;

    speak(last.content, () => {
      if (!conversation) return;
      micRef.current = listen({
        onPartial: setDraft,
        onFinal: (text) => {
          micRef.current = null;
          setDraft("");
          if (text.trim()) void send(text.trim(), mode);
        },
        onError: () => {
          micRef.current = null;
          setConversation(false);
        },
      });
    });
  }, [conversation, messages, mode, running, send]);

  useEffect(() => () => {
    stopSpeaking();
    micRef.current?.abort();
  }, []);

  const started = messages.length > 0;

  useEffect(() => {
    if (!running) return;
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "The AI is currently working. If you leave now, the generation will be stopped.";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [running]);

  const toggleCanvas = useCallback(() => {
    setCanvasOpen((open) => {
      setCanvasPinnedShut(open);
      return !open;
    });
  }, []);

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [
      {
        id: "new",
        label: "New session",
        hint: "Start again with an empty workspace",
        group: "Session",
        keywords: "reset clear start",
        run: reset,
      },
      {
        id: "canvas",
        label: canvasOpen ? "Hide the canvas" : "Show the canvas",
        hint: "Preview and code",
        group: "View",
        keywords: "preview toggle panel",
        run: toggleCanvas,
      },
      {
        id: "theme",
        label: theme === "light" ? "Switch to dark" : "Switch to light",
        group: "View",
        keywords: "appearance colour color",
        run: toggleTheme,
      },
    ];

    if (voiceSupport().speaking) {
      list.push({
        id: "speak",
        label: conversation ? "Leave conversation mode" : "Talk with Nomin",
        hint: "Speak, and hear the reply",
        group: "Voice",
        keywords: "voice speech microphone talk dictate",
        run: () => setConversation((on) => !on),
      });
      const lastAnswer = [...messages].reverse().find((item) => item.role === "assistant");
      if (lastAnswer?.content) {
        list.push({
          id: "read",
          label: "Read the last answer aloud",
          group: "Voice",
          keywords: "speak tts listen",
          run: () => speak(lastAnswer.content),
        });
      }
    }

    if (workspace.files.length || canvas.artifacts.length) {
      list.push({
        id: "download",
        label: "Download the workspace",
        hint: `${workspace.files.length || canvas.artifacts.length} files as a .zip`,
        group: "Workspace",
        keywords: "export save zip archive",
        run: downloadWorkspace,
      });
    }

    if (monitor.runtimeErrors?.length) {
      list.push({
        id: "fix",
        label: "Fix the runtime errors",
        hint: `${monitor.runtimeErrors.length} found when the page ran`,
        group: "Repair",
        keywords: "repair broken error",
        run: () => requestFix(monitor.runtimeErrors!.join("\n")),
      });
    }

    if (running) {
      list.push({
        id: "stop",
        label: "Stop the agent",
        group: "Session",
        keywords: "cancel halt abort",
        run: stop,
      });
    }

    for (const item of workspace.builds) {
      list.push({
        id: `build-${item.entry}`,
        label: `Open ${item.title}`,
        hint: item.entry,
        group: "Builds",
        keywords: "switch build preview",
        run: () => {
          setActiveBuild(item.entry);
          setCanvasOpen(true);
        },
      });
    }

    for (const item of sessions.slice(0, 8)) {
      list.push({
        id: `session-${item.id}`,
        label: item.title,
        hint: "Open this session",
        group: "Sessions",
        keywords: "history switch open",
        run: () => void openSession(item.id),
      });
    }

    return list;
  }, [
    canvas.artifacts.length,
    canvasOpen,
    conversation,
    messages,
    downloadWorkspace,
    monitor.runtimeErrors,
    openSession,
    requestFix,
    reset,
    running,
    sessions,
    setActiveBuild,
    stop,
    theme,
    toggleCanvas,
    toggleTheme,
    workspace.builds,
    workspace.files.length,
  ]);

  const runnable =
    canvas.kind === "html" || canvas.kind === "project" || workspace.builds.length > 0;
  useEffect(() => {
    if (runnable && !canvasPinnedShut) setCanvasOpen(true);
  }, [runnable, canvasPinnedShut, canvas.artifacts.length, workspace.builds.length]);


  return (
    <div
      className={`workspace${canvasOpen ? " with-canvas" : ""}${railOpen ? " rail-open" : " rail-shut"}`}
    >
      <header className="taskbar">
        <button
          className="rail-toggle"
          onClick={() => setRailOpen((open) => !open)}
          aria-expanded={railOpen}
          aria-controls="nomin-rail"
          title={railOpen ? "Hide the side panel" : "Show the side panel"}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>

        <div className="brand">
          <Mark size={30} busy={running} />
          <span className="brand-name">Nomin Code</span>
        </div>

        <div className="taskbar-mid" />

        <div className="taskbar-right">
          <span className="model-chip" title="The model running this workspace">
            <i className={`model-pip${running ? " live" : ""}`} />
            {MODEL_NAME}
          </span>
          <button
            className={`ghost-btn${canvasOpen ? " on" : ""}`}
            onClick={toggleCanvas}
            title={canvasOpen ? "Hide canvas" : "Show canvas"}
          >
            Canvas{workspace.files.length || canvas.artifacts.length
              ? ` ${workspace.files.length || canvas.artifacts.length}`
              : ""}
          </button>
          <button className="ghost-btn" onClick={toggleTheme}>
            {theme === "light" ? "Light" : "Dark"}
          </button>
          <button
            className="ghost-btn palette-open"
            onClick={() => setPaletteOpen(true)}
            title="Command palette"
          >
            <kbd>⌘K</kbd>
          </button>
        </div>
      </header>

            <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />

      {apiModalOpen && (
        <div className="modal-scrim" onClick={() => setApiModalOpen(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Nomin API Access</h3>
              <button className="modal-close" onClick={() => setApiModalOpen(false)}>?</button>
            </div>
            <div className="modal-body">
              <p>Build autonomous coding agents into your own products.</p>
              <br/>
              <p>The Nomin API allows you to send prompts programmatically and receive fully coded workspaces back.</p>
              <br/>
              <p><strong>Endpoint:</strong> <code>POST /api/v1/generate</code></p>
              <p><strong>Headers:</strong> <code>Authorization: Bearer &lt;API_KEY&gt;</code></p>
              <br/>
              <p>API Keys are currently invite-only.</p>
              <a href="mailto:nominofficial2026@gmail.com?subject=API Access Request" className="primary-btn" style={{display: 'inline-block', marginTop: 15, textDecoration: 'none'}}>Request API Key via Email</a>
            </div>
          </div>
        </div>
      )}

      <div className="frame">
        {/* On a narrow screen the rail is a drawer over the stage, so it needs
            something to dismiss it that is not the toggle in the bar. */}
        <button
          className="rail-scrim"
          aria-label="Close the side panel"
          tabIndex={railOpen ? 0 : -1}
          onClick={() => setRailOpen(false)}
        />
        <nav className="rail" id="nomin-rail" aria-hidden={!railOpen}>
          <button className="new-task" onClick={startSession}>
            <span>+</span> New session
          </button>

          <div className="rail-section">
            <span className="rail-caption">Today</span>
            {sessions.length || started ? (
              <ul className="session-list">
                {started && !sessions.some((item) => item.id === sessionId) && (
                  <li className="session on">{messages[0]?.content.slice(0, 44)}</li>
                )}
                {sessions.map((item) => (
                  <li key={item.id}>
                    <button
                      className={`session${item.id === sessionId ? " on" : ""}`}
                      onClick={() => void pickSession(item.id)}
                      disabled={running}
                    >
                      {item.title}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rail-empty">Nothing yet. Describe what you want built.</p>
            )}
          </div>

          <div className="rail-section">
            <span className="rail-caption">State</span>
            <dl className="state-grid">
              <dt>Status</dt>
              <dd className={running ? "live" : ""}>{status}</dd>
              <dt>Mode</dt>
              <dd>{mode}</dd>
              <dt>Output</dt>
              <dd>{usage ? `${usage.completionTokens} tok` : "—"}</dd>
              <dt>Files</dt>
              <dd>{workspaceFiles.length || canvas.artifacts.length || "—"}</dd>
              <dt>Plan</dt>
              <dd>{planStatus === "none" ? "—" : planStatus}</dd>
              <dt>Review</dt>
              <dd className={monitor.verdict?.status === "verified" ? "live" : ""}>
                {monitor.status === "reviewing" || monitor.status === "capturing"
                  ? "checking"
                  : (monitor.verdict?.status ?? "—")}
              </dd>
            </dl>
          </div>

          {checkpoints.length > 0 && (
            <div className="rail-section">
              <span className="rail-caption">Restore</span>
              <ul className="checkpoint-list">
                {checkpoints.map((point) => (
                  <li key={point.id}>
                    <button
                      type="button"
                      className="checkpoint"
                      disabled={running}
                      title="Put the workspace back to this point"
                      onClick={() => restoreCheckpoint(point.id)}
                    >
                      <span className="checkpoint-label">{point.label}</span>
                      <span className="checkpoint-meta">{describeCheckpoint(point)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="rail-foot">
            <span className="rail-caption">Running on</span>
            <p className="rail-note">Nomin infrastructure</p>
          </div>
                  <div className="rail-section">
            <span className="rail-caption">Developers</span>
            <ul className="session-list">
              <li>
                <button className="session" onClick={() => setApiModalOpen(true)}>
                  API Access
                </button>
              </li>
            </ul>
          </div>
        </nav>

        <main className="stage">
          {cooldown && (
            <div className="cooldown-banner">
              <i className="spin" />
              {cooldown}
            </div>
          )}

          {started ? (
            <Chat
              messages={messages}
              running={running}
              status={status}
              theme={theme}
              retry={retry}
              answer={answerQuestions}
              usage={usage}
              monitor={monitor}
              plan={plan}
              planStatus={planStatus}
              onApprovePlan={approveAndBuild}
              onChangePlan={sendPlanChanges}
              onFix={requestFix}
              builds={workspace.builds}
              activeBuild={activeBuild}
              onOpenBuild={openBuild}
              onDownloadBuild={downloadBuild}
            />
          ) : (
            <Welcome running={running} />
          )}

          <div className={`composer-dock${started ? "" : " centred"}`}>
            <Composer
              draft={draft}
              setDraft={setDraft}
              submit={submit}
              stop={stop}
              running={running}
              status={status}
              mode={mode}
              setMode={setMode}
              placeholder={started ? "Reply, or ask for a change" : "Describe what you want built…"}
              attachments={attachments}
              onAttach={attach}
              onRemoveAttachment={removeAttachment}
              attaching={attaching}
              conversation={conversation}
              onToggleConversation={() => setConversation((on) => !on)}
              onPrepared={addPrepared}
            />
            <p className="disclaimer">
              Trion 1.5 can make mistakes. Nomin verifies work against real evidence — check anything
              marked unverified.
            </p>

            {/* Templates are briefs, not files. Picking one writes it into the
                box above so it can be read and edited before anything is
                built — a starting point, never a surprise. */}
            {!started && <Templates onPick={setDraft} />}
          </div>
        </main>

        {canvasOpen && (
          <Canvas
            state={canvas}
            running={running}
            onClose={toggleCanvas}
            workspace={workspace}
            activeBuild={activeBuild}
            onSelectBuild={setActiveBuild}
          />
        )}
      </div>
    </div>
  );
}

function Welcome({ running }: { running: boolean }) {
  return (
    <div className="welcome">
      {/* Two presentations of the same mark, and the width decides.

          With room, it sits behind the heading as a watermark: large enough to
          be the page's identity, faint enough that the question is still the
          first thing read. In a narrow column there is no room to be faint —
          a watermark at that size is either cropped or invisible — so it
          becomes a solid mark standing above the heading instead. Same file
          either way; only the scale and the opacity change. */}
      <MarkWatermark size={440} />
      <Mark size={56} busy={running} className="welcome-badge" />
      <h1>What are we building?</h1>
      <p>
        Describe the outcome. Nomin Code asks what it needs, plans it for your approval, then builds,
        tests and verifies the work — and keeps going through rate limits.
      </p>
    </div>
  );
}

function Chat({
  messages,
  running,
  status,
  theme,
  retry,
  answer,
  usage,
  monitor,
  plan,
  planStatus,
  onApprovePlan,
  onChangePlan,
  onFix,
  builds,
  activeBuild,
  onOpenBuild,
  onDownloadBuild,
}: {
  messages: ChatMessage[];
  running: boolean;
  status: string;
  theme: Theme;
  retry: () => void;
  answer: (text: string) => void;
  usage: { promptTokens: number; completionTokens: number } | null;
  monitor: MonitorState;
  plan: Plan | null;
  planStatus: PlanStatus;
  onApprovePlan: () => void;
  onChangePlan: (note: string) => void;
  onFix: (brief: string) => void;
  builds: Build[];
  activeBuild: string | null;
  onOpenBuild: (entry: string) => void;
  onDownloadBuild: (entry: string) => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const startedAt = messages[0]?.at ?? Date.now();
  // The plan belongs to the turn that proposed it.
  const lastPlanTurn = messages.reduce(
    (found, message, i) =>
      message.role === "assistant" && parsePlan(message.content).plan ? i : found,
    -1,
  );

  return (
    <div className="chat">
      <div className="chat-inner">
        {messages.map((message, i) =>
          message.manager ? (
            <article key={i} className="turn internal verified">
              <p className="internal-note">
                <ManagerMark />
                <span>{message.content}</span>
              </p>
            </article>
          ) : message.role === "user" ? (
            <UserTurn key={i} message={message} />
          ) : (
            <article key={i} className={`turn${message.error ? " failed" : ""}`}>
              {message.events?.length ? (
                <ThinkingBlock
                  events={message.events}
                  running={running && i === messages.length - 1}
                  status={status}
                  theme={theme}
                />
              ) : null}

              <div className="turn-text">
                {message.error ? (
                  message.content
                ) : (
                  <Markdown text={parsePlan(parseQuestions(message.content).text).text} />
                )}
                {running && i === messages.length - 1 && !message.content && (
                  <span className="dots">
                    <i />
                    <i />
                    <i />
                  </span>
                )}
                
                {/* Everything this session has built, as separate things. Inline with text. */}
                {i === messages.length - 1 && builds.length > 0 && (
                  <BuildCards
                    builds={builds}
                    active={activeBuild}
                    onOpen={onOpenBuild}
                    onDownload={onDownloadBuild}
                  />
                )}
              </div>

              {plan && i === lastPlanTurn && (
                <PlanCard
                  plan={plan}
                  status={planStatus}
                  running={running}
                  onApprove={onApprovePlan}
                  onChange={onChangePlan}
                />
              )}

              {!running && i === messages.length - 1 && !message.error && (
                <Clarify content={message.content} answer={answer} />
              )}

              {!running && message.content && (
                <MessageActions
                  text={message.content}
                  verdict={i === messages.length - 1 ? undefined : message.verdict}
                  retry={retry}
                />
              )}

              {!running && i === messages.length - 1 && !message.error && (
                <ReportCard monitor={monitor} onFix={onFix} fixing={running} />
              )}
            </article>
          ),
        )}

        {running && <SessionFooter startedAt={startedAt} status={status} usage={usage} />}
        <div ref={endRef} />
      </div>
    </div>
  );
}


/**
 * Everything this session has built, each as its own thing.
 *
 * A session is not one deliverable. Ask for a coffee shop and then an ice
 * cream shop and you have two, and the second must not quietly replace the
 * first: each writes its own entry point, so each gets a card. Opening one
 * shows that build alone in the canvas — its preview and its files, not the
 * session's whole file list — and each can be taken away on its own.
 */
function BuildCards({
  builds,
  active,
  onOpen,
  onDownload,
}: {
  builds: Build[];
  active: string | null;
  onOpen: (entry: string) => void;
  onDownload: (entry: string) => void;
}) {
  const current = builds.some((build) => build.entry === active) ? active : builds[0]?.entry;
  return (
    <section className="build-cards">
      <h4 className="build-cards-title">
        {builds.length === 1 ? "What was built" : `${builds.length} things built in this session`}
      </h4>
      <ul>
        {builds.map((build) => (
          <li key={build.entry}>
            <div className={`build-card${build.entry === current ? " on" : ""}`}>
              <button
                type="button"
                className="build-card-open"
                onClick={() => onOpen(build.entry)}
                title={`Open ${build.entry} in the canvas`}
              >
                <span className="build-card-name">{build.title}</span>
                <span className="build-card-meta">
                  {build.entry} · {build.files.length} file{build.files.length === 1 ? "" : "s"}
                </span>
              </button>
              <button
                type="button"
                className="build-card-get"
                onClick={() => onDownload(build.entry)}
                title="Download this build on its own"
              >
                <DownloadIcon />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

const DownloadIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3v12M7.5 10.5 12 15l4.5-4.5M4.5 20h15" />
  </svg>
);

/**
 * One line for the transcript, taken from the manager's own findings.
 *
 * The brief that goes to the model is long and blunt on purpose. None of that
 * belongs on screen: what the user needs is the reason the work came back.
 */
function managerLine(brief: string): string {
  const lines = brief
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  // The first line is the instruction to the model; the second is the finding.
  const finding = lines[1] ?? lines[0] ?? "";
  const summary = finding.replace(/^[-*]\s*/, "").slice(0, 160);
  return summary ? `Sent back: ${summary}` : "Sent back to finish the work.";
}

const ManagerMark = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3l7 4v5c0 4.2-2.9 7.8-7 9-4.1-1.2-7-4.8-7-9V7l7-4z" />
    <path d="M9 12l2 2 4-4" />
  </svg>
);

/** A user message: quiet surface, relative time, actions on hover. */
function UserTurn({ message }: { message: ChatMessage }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const long = message.content.length > 420;
  const text = long && !expanded ? `${message.content.slice(0, 420).trimEnd()}…` : message.content;

  // The manager sending work back is not something the user said, and showing
  // it as their own message makes the transcript a record of things they never
  // wrote. It appears as what it is: Nomin taking the work back, stated once,
  // without the brief it sent behind the scenes.
  if (message.internal) {
    return (
      <article className="turn internal">
        <p className="internal-note">
          <ManagerMark />
          <span>{managerLine(message.content)}</span>
        </p>
      </article>
    );
  }

  return (
    <article className="turn user">
      {message.attachments?.length ? (
        <ul className="turn-attachments">
          {message.attachments.map((item) => (
            <li key={item.name}>
              <span className="attachment-kind">{item.kind}</span>
              <span className="attachment-name">{item.name}</span>
              {item.note && <em>{item.note}</em>}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="user-box">{text}</div>
      {long && (
        <button className="show-more" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
      <div className="user-foot">
        <time>{relative(message.at)}</time>
        <button
          title="Copy"
          onClick={() => {
            void navigator.clipboard?.writeText(message.content);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1400);
          }}
        >
          {copied ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
          )}
        </button>
      </div>
    </article>
  );
}

/** The live line under an in-flight turn: elapsed, tokens, what it is doing. */
function SessionFooter({
  startedAt,
  status,
  usage,
}: {
  startedAt: number;
  status: string;
  usage: { promptTokens: number; completionTokens: number } | null;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
  const tokens = usage ? usage.promptTokens + usage.completionTokens : 0;

  return (
    <div className="session-footer">
      <span className="session-spark" />
      {formatDuration(seconds)}
      {tokens > 0 && ` · ${formatTokens(tokens)} tokens`} · {status}…
    </div>
  );
}

const formatDuration = (seconds: number) =>
  seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;

const formatTokens = (tokens: number) =>
  tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);

function relative(at: number): string {
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 45) return "just now";
  if (seconds < 90) return "1 minute ago";
  if (seconds < 3600) return `${Math.round(seconds / 60)} minutes ago`;
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Shows the selectable question card when the agent asked for requirements. */
function Clarify({ content, answer }: { content: string; answer: (text: string) => void }) {
  const [dismissed, setDismissed] = useState(false);
  const { questions } = useMemo(() => parseQuestions(content), [content]);
  if (dismissed || hasPartialBlock(content) || !questions.length) return null;
  return (
    <QuestionCard
      questions={questions}
      onDismiss={() => setDismissed(true)}
      onSubmit={(answers) => {
        setDismissed(true);
        answer(formatAnswers(questions, answers));
      }}
    />
  );
}

function MessageActions({
  text,
  verdict,
  retry,
}: {
  text: string;
  verdict?: Verdict;
  retry: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="actions">
      <button
        className="feedback-btn"
        onClick={() => {
          void navigator.clipboard?.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1400);
        }}
      >
        {copied ? (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
        )}
      </button>
      <button className="feedback-btn" onClick={retry} title="Retry">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
      </button>
      <button className="feedback-btn" title="Good response">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"></path></svg>
      </button>
      <button className="feedback-btn" title="Bad response">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3"></path></svg>
      </button>
      {verdict && (
        <span className={`verdict ${verdict.status}`} title={verdict.issues.join(" · ")}>
          {/* The badge says what the manager decided, in the manager's own
              terms. "Verified" used to sit here on turns the manager had
              never actually seen, which is precisely the claim it must not
              make on the worker's behalf. */}
          {verdict.approved
            ? "Approved"
            : verdict.status === "verified"
              ? "Checks out · unapproved"
              : verdict.status === "unverified"
                ? "Not approved yet"
                : verdict.status === "concerns"
                  ? "Sent back"
                  : "Rejected"}
          <em>{verdict.usedModel ? "manager" : "evidence"}</em>
        </span>
      )}
    </div>
  );
}

