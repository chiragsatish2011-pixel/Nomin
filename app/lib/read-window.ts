export const MAX_READ_LINES = 200;
const OUTLINE_LINES = 80;

export type ReadWindow = {
  content: string;
  totalLines: number;
  startLine?: number;
  endLine?: number;
  truncated?: boolean;
  note?: string;
};

/**
 * Keep a single tool result small enough to be useful as model context.
 * WebContainer's filesystem returns a string, but the model never needs a
 * 2,000-line blob merely to choose where to inspect next.
 */
export function selectReadWindow(content: string, startLine?: number, endLine?: number): ReadWindow {
  const lines = content.split(/\r?\n/);
  const totalLines = lines.length;

  if (startLine !== undefined || endLine !== undefined) {
    const start = Math.max(1, startLine ?? 1);
    const end = Math.min(totalLines, endLine ?? Math.min(totalLines, start + MAX_READ_LINES - 1));
    return {
      content: lines.slice(start - 1, end).join("\n"),
      totalLines,
      startLine: start,
      endLine: end,
      truncated: start > 1 || end < totalLines,
    };
  }

  if (totalLines <= MAX_READ_LINES) return { content, totalLines };

  const headEnd = Math.min(OUTLINE_LINES, totalLines);
  const tailStart = Math.max(headEnd + 1, totalLines - OUTLINE_LINES + 1);
  return {
    content: [
      `[Lines 1–${headEnd}]`,
      lines.slice(0, headEnd).join("\n"),
      `\n… ${tailStart - headEnd - 1} lines omitted …\n`,
      `[Lines ${tailStart}–${totalLines}]`,
      lines.slice(tailStart - 1).join("\n"),
    ].join("\n"),
    totalLines,
    truncated: true,
    note: `This file has ${totalLines} lines. Request startLine and endLine (at most ${MAX_READ_LINES} lines) for a focused section.`,
  };
}
