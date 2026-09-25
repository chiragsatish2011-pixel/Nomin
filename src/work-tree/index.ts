export { WorkTree } from "./work-tree.js";
export type { WorkTreeOptions, WorkTreeStatus } from "./work-tree.js";
export { TreeRenderer } from "./renderer.js";
export type { RendererOptions } from "./renderer.js";
export {
  applyEvent,
  createTreeState,
  currentStatus,
  flatten,
} from "./model.js";
export type { FlatRow, TreeNode, TreeState } from "./model.js";
export { EVENT_RULES } from "./events.js";
export type { AgentEvent, AgentEventType, NodeKind, NodeState } from "./events.js";
export { krakenAurora, krakenDark, metrics, motion, glyphFor } from "./theme.js";
export type { Theme } from "./theme.js";
export { scribblePath } from "./scribble.js";
