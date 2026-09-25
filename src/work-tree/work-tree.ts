import type { AgentEvent, NodeState } from "./events.js";
import {
  applyEvent,
  createTreeState,
  currentStatus,
  flatten,
  type FlatRow,
  type TreeState,
} from "./model.js";
import { TreeRenderer, type RendererOptions } from "./renderer.js";

export interface WorkTreeOptions extends RendererOptions {}

export interface WorkTreeStatus {
  label: string;
  state: NodeState;
}

type Listener = (status: WorkTreeStatus, rows: FlatRow[]) => void;

/**
 * The public handle. Feed it agent events; it keeps the tree state and the
 * animated SVG in sync. Nothing else in Nomin Code needs to know how either
 * one works.
 *
 *   const tree = new WorkTree(host, { title: "Nomin Code" });
 *   tree.emit({ type: "task.started", id: "task", label: "Build a dashboard" });
 *   tree.emit({ type: "command.started", label: "Run command", detail: "npm test" });
 */
export class WorkTree {
  private readonly renderer: TreeRenderer;
  private readonly listeners = new Set<Listener>();
  private state: TreeState = createTreeState();

  constructor(host: HTMLElement, options: WorkTreeOptions = {}) {
    this.renderer = new TreeRenderer(host, options);
    this.renderer.attach(this.state);
  }

  /** Fold one event (or a batch) into the tree. */
  emit(event: AgentEvent | AgentEvent[]): void {
    const batch = Array.isArray(event) ? event : [event];
    let changed = false;
    for (const item of batch) changed = applyEvent(this.state, item) || changed;
    if (changed) this.notify();
  }

  /** Clear the tree for a new task. */
  reset(): void {
    this.state = createTreeState();
    this.renderer.attach(this.state);
    this.renderer.reset();
    this.notify();
  }

  get status(): WorkTreeStatus {
    return currentStatus(this.state);
  }

  get rows(): FlatRow[] {
    return flatten(this.state);
  }

  setTitle(title: string): void {
    this.renderer.setTitle(title);
  }

  /** Subscribe to status/shape changes — for headers, TUI mirrors, logs. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.status, this.rows);
    return () => this.listeners.delete(listener);
  }

  destroy(): void {
    this.listeners.clear();
    this.renderer.destroy();
  }

  private notify(): void {
    const status = this.status;
    const rows = this.rows;
    for (const listener of this.listeners) listener(status, rows);
  }
}
