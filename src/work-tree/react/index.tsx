import { useEffect, useRef, useState } from "react";
import type { AgentEvent } from "../events.js";
import type { FlatRow } from "../model.js";
import { WorkTree, type WorkTreeOptions, type WorkTreeStatus } from "../work-tree.js";

export interface WorkTreeViewProps extends WorkTreeOptions {
  /**
   * The event log so far. New entries appended to the end are folded into the
   * tree; the component never re-plays events it has already consumed, so the
   * animation is continuous across renders.
   */
  events: AgentEvent[];
  className?: string;
  style?: React.CSSProperties;
  onStatusChange?: (status: WorkTreeStatus, rows: FlatRow[]) => void;
}

/**
 * React wrapper around the framework-free `WorkTree`. The SVG lives outside
 * React's render cycle on purpose — the animation runs on its own rAF loop and
 * must not re-mount when a parent re-renders.
 */
export function WorkTreeView({
  events,
  className,
  style,
  onStatusChange,
  ...options
}: WorkTreeViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<WorkTree | null>(null);
  const consumed = useRef(0);
  const [, force] = useState(0);

  useEffect(() => {
    if (!hostRef.current) return;
    const tree = new WorkTree(hostRef.current, options);
    treeRef.current = tree;
    consumed.current = 0;
    force((n) => n + 1);
    return () => {
      tree.destroy();
      treeRef.current = null;
    };
    // Options are read once at construction, by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const tree = treeRef.current;
    if (!tree || !onStatusChange) return;
    return tree.subscribe(onStatusChange);
  }, [onStatusChange]);

  useEffect(() => {
    const tree = treeRef.current;
    if (!tree) return;
    if (events.length < consumed.current) {
      tree.reset();
      consumed.current = 0;
    }
    if (events.length > consumed.current) {
      tree.emit(events.slice(consumed.current));
      consumed.current = events.length;
    }
  }, [events]);

  return <div ref={hostRef} className={className} style={style} />;
}

export { WorkTree };
export type { WorkTreeOptions, WorkTreeStatus };
