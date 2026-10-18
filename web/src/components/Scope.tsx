import { useEffect, useRef, useState } from "react";
import { ansiLineToHtml, dominantBackground } from "@/lib/ansi";
import { READ_LINES, readPane } from "@/lib/herdr";
import { splitLines } from "@/lib/fleet";

const POLL_MS = 1500;
const TAIL_SLOP_PX = 48;

/**
 * The transcript scope for one pane. Polls pane.read, repaints only when the
 * daemon revision moves (revision 0 means "unknown", so it always repaints),
 * and keeps the tail pinned unless the operator scrolled up.
 */
export function Scope({ paneId }: { paneId: string }) {
  const [lines, setLines] = useState<string[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [failed, setFailed] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);
  const revisionRef = useRef(-1);

  useEffect(() => {
    let cancelled = false;
    followRef.current = true;
    revisionRef.current = -1;
    setLines([]);
    setTruncated(false);
    setFailed(false);

    async function poll(): Promise<void> {
      const read = await readPane(paneId, READ_LINES).catch(() => null);
      if (cancelled) {
        return;
      }
      if (read === null) {
        setFailed(true);
        return;
      }
      setFailed(false);
      if (read.revision !== 0 && read.revision === revisionRef.current) {
        return;
      }
      revisionRef.current = read.revision;
      setLines(splitLines(read.text));
      setTruncated(read.truncated);
    }

    void poll();
    const timer = setInterval(() => {
      void poll();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [paneId]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element && followRef.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [lines]);

  const canvas = dominantBackground(lines);

  return (
    <section className="scope" aria-label="Pane output">
      {truncated && (
        <div className="scope__notice" id="herdr-feed-truncated">
          <span className="signal" data-tone="blocked" aria-hidden />
          <span>scrollback truncated — recent lines only</span>
        </div>
      )}
      {failed && (
        <div className="scope__notice" id="herdr-read-failed">
          <span className="signal" data-tone="blocked" aria-hidden />
          <span>pane read failed — retrying</span>
        </div>
      )}
      <div
        id="herdr-feed-text"
        ref={scrollRef}
        className="scope__scroll"
        role="log"
        aria-live="polite"
        aria-relevant="text"
        // A full-screen app paints its own canvas; matching it here keeps the
        // viewport continuous instead of showing the page through the gaps.
        data-canvas={canvas !== null ? "content" : undefined}
        style={canvas !== null ? { background: canvas } : undefined}
        onScroll={(event) => {
          const element = event.currentTarget;
          followRef.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < TAIL_SLOP_PX;
        }}
      >
        {lines.map((line, index) => (
          <div
            key={index}
            className="scope__line"
            // Renderer output only: ANSI escape sequences become spans, and
            // text is HTML-escaped before any markup is added.
            dangerouslySetInnerHTML={{ __html: ansiLineToHtml(line) }}
          />
        ))}
      </div>
    </section>
  );
}
