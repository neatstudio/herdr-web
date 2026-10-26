import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { copyText, COPY_ACK_MS } from "@/lib/clipboard";
import {
  FENCE_RE,
  HEADING_RE,
  LIST_RE,
  QUOTE_RE,
  foldCode,
  inlineSpans,
  parseList,
  safeHref,
} from "@/lib/markdown";

/**
 * The agent's prose, rendered as a quiet document.
 *
 * Agents print markdown, but they also print things that look like markdown and
 * are not: ASCII tables, box-drawing diagrams, aligned trees. Those are the one
 * place the terminal is better than a browser, so they are kept verbatim in a
 * `<pre>` instead of being re-flowed into a paragraph. Everything else is
 * parsed into React nodes — no `dangerouslySetInnerHTML`, because this text
 * comes from another process.
 */

const BOX_CHARS = /[\u2500-\u257f]/;

/** A run of lines that only makes sense with its original spacing. */
function isArt(line: string): boolean {
  if (BOX_CHARS.test(line)) {
    return true;
  }
  const text = line.trim();
  if (text === "") {
    return false;
  }
  if (/^[|+]/.test(text)) {
    return true;
  }
  if (/^[\\/]\s*$/.test(text)) {
    return false;
  }
  // A run of three or more spaces inside an otherwise short line is a column
  // layout, not a paragraph.
  return /\S {3,}\S/.test(text) && text.length < 96 && !/[。.!?]$/.test(text);
}

function artLines(lines: readonly string[], start: number): number {
  let end = start;
  while (end < lines.length && isArt(lines[end])) {
    end += 1;
  }
  return end;
}

function inline(text: string, keyBase: string): ReactNode[] {
  return inlineSpans(text).map((span, index) => {
    const key = `${keyBase}-${index}`;
    switch (span.kind) {
      case "strong":
        return <strong key={key}>{span.text}</strong>;
      case "code":
        return (
          <code className="markdown__code" key={key}>
            {span.text}
          </code>
        );
      case "em":
        return <em key={key}>{span.text}</em>;
      case "link": {
        const href = safeHref(span.href);
        if (href === null) {
          return <span key={key}>{span.text}</span>;
        }
        return (
          <a key={key} href={href} target="_blank" rel="noreferrer">
            {span.text}
          </a>
        );
      }
      default:
        return span.text;
    }
  });
}

function listItems(
  lines: readonly string[],
  start: number,
  keyBase: string,
): { node: ReactNode; end: number } {
  const list = parseList(lines, start);
  if (list === null) {
    return { node: null, end: start };
  }
  return {
    node: (
      <ul className="markdown__list" key={keyBase} data-ordered={list.ordered ? "true" : undefined}>
        {list.items.map((item, index) => (
          <li key={`${keyBase}-${index}`} data-depth={item.depth > 0 ? item.depth : undefined}>
            {inline(item.text, `${keyBase}-${index}`)}
          </li>
        ))}
      </ul>
    ),
    end: list.end,
  };
}

type CopyState = "idle" | "copied" | "failed";

/**
 * A fenced block: the language, a copy button, and — past 30 lines — a fold,
 * because a build log inside the transcript otherwise buries the answer under
 * a screen of scroll.
 */
function CodeBlock({ language, value }: { language: string; value: string }) {
  const fold = useMemo(() => foldCode(value), [value]);
  const [expanded, setExpanded] = useState(false);
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const block = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (copyState === "idle") {
      return;
    }
    const timer = setTimeout(() => setCopyState("idle"), COPY_ACK_MS);
    return () => clearTimeout(timer);
  }, [copyState]);

  const copy = () => {
    void copyText(value).then((ok) => setCopyState(ok ? "copied" : "failed"));
  };

  const toggle = () => {
    const collapsing = expanded;
    setExpanded(!expanded);
    if (collapsing) {
      // "show less" sits under the block, so bring its top back into view.
      block.current?.scrollIntoView({ block: "nearest" });
    }
  };

  return (
    <div className="chat__code" ref={block}>
      <div className="chat__code-head">
        <span className="chat__code-lang">{language === "" ? "text" : language}</span>
        <button
          type="button"
          className="chat__code-copy"
          onClick={copy}
          aria-label="copy this code block"
        >
          {copyState === "copied" ? "copied" : "copy"}
        </button>
      </div>
      {copyState === "failed" && (
        <p className="chat__code-error" role="alert">
          couldn&apos;t copy — select the text above and copy it
        </p>
      )}
      <pre className="chat__code-body">
        {fold !== null && !expanded ? fold.head : value}
      </pre>
      {fold !== null && (
        <button type="button" className="chat__code-more" aria-expanded={expanded} onClick={toggle}>
          {expanded ? "show less" : `show all ${fold.lines} lines`}
        </button>
      )}
    </div>
  );
}

function blocks(lines: readonly string[]): ReactNode[] {
  const nodes: ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const text = line.trim();
    const fence = FENCE_RE.exec(line);
    if (fence !== null) {
      const code: string[] = [];
      let end = index + 1;
      while (end < lines.length && !/^\s*(```|~~~)\s*$/.test(lines[end])) {
        code.push(lines[end]);
        end += 1;
      }
      index = end + 1;
      nodes.push(<CodeBlock key={`code-${index}`} language={fence[2]} value={code.join("\n")} />);
      continue;
    }
    if (text === "") {
      index += 1;
      continue;
    }
    if (isArt(line)) {
      const end = artLines(lines, index);
      const art = lines.slice(index, end).join("\n").replace(/[ \t]+$/gm, "");
      nodes.push(
        <pre className="chat__pre" key={`pre-${index}`}>
          {art}
        </pre>,
      );
      index = end;
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading !== null) {
      nodes.push(<h3 key={`head-${index}`}>{inline(heading[2], `head-${index}`)}</h3>);
      index += 1;
      continue;
    }
    const quote = QUOTE_RE.exec(line);
    if (quote !== null) {
      const quoted: string[] = [quote[1]];
      let end = index + 1;
      while (end < lines.length) {
        const more = QUOTE_RE.exec(lines[end]);
        if (more === null) {
          break;
        }
        quoted.push(more[1]);
        end += 1;
      }
      nodes.push(
        <blockquote className="markdown__quote" key={`quote-${index}`}>
          {quoted.join(" ")}
        </blockquote>,
      );
      index = end;
      continue;
    }
    if (LIST_RE.test(line)) {
      const list = listItems(lines, index, `list-${index}`);
      if (list.node !== null) {
        nodes.push(list.node);
      }
      index = Math.max(list.end, index + 1);
      continue;
    }
    const paragraph: string[] = [text];
    let end = index + 1;
    while (end < lines.length) {
      const next = lines[end];
      if (
        next.trim() === "" ||
        FENCE_RE.test(next) ||
        HEADING_RE.test(next) ||
        QUOTE_RE.test(next) ||
        LIST_RE.test(next) ||
        isArt(next)
      ) {
        break;
      }
      paragraph.push(next.trim());
      end += 1;
    }
    nodes.push(<p key={`p-${index}`}>{inline(paragraph.join(" "), `p-${index}`)}</p>);
    index = end;
  }
  return nodes;
}

export function Markdown({ text }: { text: string }) {
  return <div className="markdown">{blocks(text.split("\n"))}</div>;
}
