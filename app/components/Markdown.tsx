"use client";

// A small, dependency-free Markdown renderer.
//
// Trion is a coding agent: its answers are mostly file paths, commands, and
// code. The interface rendered every reply as a single <p> of raw text, so a
// fenced code block arrived as a wall of backticks with the indentation running
// into the prose — which is also why the output prompts used to forbid Markdown
// entirely. They now require it, and this renders it.
//
// It builds React elements rather than HTML strings, so model output can never
// inject markup. Only the subset that actually appears in agent replies is
// supported; anything unrecognised falls through as literal text.

import { useState } from "react";
import { Check, Copy } from "lucide-react";

type MarkdownProps = {
  children: string;
  className?: string;
};

export function Markdown({ children, className }: MarkdownProps) {
  return <div className={className ? `md ${className}` : "md"}>{renderBlocks(children ?? "")}</div>;
}

// ---------------------------------------------------------------------------
// Block level
// ---------------------------------------------------------------------------

function renderBlocks(source: string) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let index = 0;
  let key = 0;

  while (index < lines.length) {
    const line = lines[index];

    // Fenced code block
    const fence = line.match(/^\s*```+\s*([\w+-]*)\s*$/);
    if (fence) {
      const language = fence[1] || "";
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```+\s*$/.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1; // closing fence (or end of input)
      blocks.push(<CodeBlock key={key++} language={language} code={body.join("\n")} />);
      continue;
    }

    // Blank line
    if (!line.trim()) {
      index += 1;
      continue;
    }

    // Heading
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const Tag = (`h${Math.min(level + 2, 6)}`) as "h3" | "h4" | "h5" | "h6";
      blocks.push(<Tag key={key++}>{renderInline(heading[2])}</Tag>);
      index += 1;
      continue;
    }

    // Horizontal rule
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      blocks.push(<hr key={key++} />);
      index += 1;
      continue;
    }

    // Lists — an unbroken run of bullets or numbers
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (index < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*([-*+]|\d+[.)])\s+/, ""));
        index += 1;
        // A wrapped continuation line belongs to the item above it.
        while (index < lines.length && lines[index].trim() && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[index]) && !/^\s*```/.test(lines[index])) {
          items[items.length - 1] += ` ${lines[index].trim()}`;
          index += 1;
        }
      }
      const rendered = items.map((item, i) => <li key={i}>{renderInline(item)}</li>);
      blocks.push(ordered ? <ol key={key++}>{rendered}</ol> : <ul key={key++}>{rendered}</ul>);
      continue;
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quoted.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push(<blockquote key={key++}>{renderInline(quoted.join(" "))}</blockquote>);
      continue;
    }

    // Paragraph — consume until a blank line or the start of another block
    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^\s*```/.test(lines[index]) &&
      !/^\s*([-*+]|\d+[.)])\s+/.test(lines[index]) &&
      !/^#{1,4}\s/.test(lines[index]) &&
      !/^\s*>\s?/.test(lines[index])
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(<p key={key++}>{renderInline(paragraph.join(" "))}</p>);
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Inline level
// ---------------------------------------------------------------------------

/** `code`, **bold**, *italic*, and [links](url) — matched in one pass so a URL
 *  inside backticks is never re-parsed as a link. */
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*|_[^_\n]+_)|(\[[^\]\n]+\]\([^)\s]+\))/g;

function renderInline(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  let key = 0;

  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0;
    if (start > cursor) nodes.push(text.slice(cursor, start));
    const token = match[0];

    if (token.startsWith("`")) {
      nodes.push(<code key={key++}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("[")) {
      const link = token.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
      if (link && /^https?:\/\//i.test(link[2])) {
        // Only http(s) — a javascript: or data: href from model output must
        // never become a clickable link.
        nodes.push(
          <a key={key++} href={link[2]} target="_blank" rel="noreferrer noopener">
            {link[1]}
          </a>
        );
      } else {
        nodes.push(token);
      }
    } else {
      nodes.push(<em key={key++}>{token.slice(1, -1)}</em>);
    }

    cursor = start + token.length;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

// ---------------------------------------------------------------------------

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access denied — the code is still selectable.
    }
  }

  return (
    <figure className="mdCode">
      <figcaption>
        <span>{language || "code"}</span>
        <button type="button" onClick={() => void copy()} title="Copy code">
          {copied ? <Check size={12} /> : <Copy size={12} />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </figcaption>
      <pre>
        <code>{code}</code>
      </pre>
    </figure>
  );
}
