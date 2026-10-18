import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ansiLineToHtml, dominantBackground } from "@/lib/ansi";
import { READ_LINES, readPane } from "@/lib/herdr";
import { canvasModeFor, splitLines, type PageTheme } from "@/lib/fleet";

const POLL_MS = 1500;
const TAIL_SLOP_PX = 48;
/** Monospace advance as a fraction of the font size, for fit-to-width. */
const MONO_ADVANCE = 0.6;
const BASE_FONT_PX = 12.5;
/**
 * Floor for fit-to-width. A phone reports a device pixel ratio near 3, so 4px
 * of CSS text is still about 12 device pixels; below that a 300-column pane
 * would be a grey smear, so those panes scroll instead of pretending to fit.
 */
const MIN_FIT_PX = 4;

/**
 * The transcript scope for one pane. Polls pane.read, repaints only when the
 * daemon revision moves (revision 0 means "unknown", so it always repaints),
 * and keeps the tail pinned unless the operator scrolled up.
 *
 * Layout depends on what the pane contains, because herdr decides the pane's
 * width, not the browser, and pane.read takes no width argument:
 *
 *  - A full-screen app paints a fixed-width canvas and draws with cursor
 *    escapes. Rewrapping it destroys its layout, so those panes keep one row
 *    per terminal line and can be scaled down to fit a narrow screen.
 *  - Ordinary output is just text, so it rewraps to the viewport and reads
 *    naturally on a phone.
 */
export function Scope({ paneId, theme }: { paneId: string; theme: PageTheme }) {
  const [lines, setLines] = useState<string[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [failed, setFailed] = useState(false);
  const [fit, setFit] = useState(false);
  const [width, setWidth] = useState(0);
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
    setFit(false);

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

  // Track the viewport so a rotation or resize re-fits immediately instead of
  // waiting for the next poll.
  useEffect(() => {
    const element = scrollRef.current;
    if (element === null) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) {
        setWidth(entry.contentRect.width);
      }
    });
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  // Keep the tail pinned after each paint, and after a resize: the wrap and
  // the fit both change the height, which would otherwise leave the reader
  // stranded mid-scroll.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && followRef.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [lines, width, fit]);

  // A pane that paints a canvas is a full-screen app; plain output is not.
  // The raw canvas decides the layout, and the page theme decides whether the
  // content's colours need mirroring to match it.
  const rawCanvas = dominantBackground(lines);
  const mode = canvasModeFor(rawCanvas, theme);
  const canvas = mode === "content" ? rawCanvas : null;
  const columns = lines.reduce((widest, line) => Math.max(widest, stripLength(line)), 0);
  const fitsAtReadableSize =
    width > 0 && columns > 0 && width / (columns * MONO_ADVANCE) >= MIN_FIT_PX;
  const needsFit =
    rawCanvas !== null && columns > 0 && width / (columns * MONO_ADVANCE) < BASE_FONT_PX;
  const fitScale = columns > 0 && width > 0 ? width / (columns * MONO_ADVANCE) : BASE_FONT_PX;
  const fontPx = fit ? Math.max(MIN_FIT_PX, Math.min(BASE_FONT_PX, fitScale)) : BASE_FONT_PX;
  const canOfferFit = needsFit && fitsAtReadableSize;

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
        data-canvas={canvas !== null ? "content" : undefined}
        data-wrap={rawCanvas !== null ? "off" : "on"}
        data-adapt={mode !== "content" ? mode : undefined}
        data-fit={fit ? "on" : undefined}
        style={{
          ...(canvas !== null ? { background: canvas } : {}),
          ...(fit ? { fontSize: `${fontPx.toFixed(2)}px` } : {}),
        }}
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
            dangerouslySetInnerHTML={{ __html: ansiLineToHtml(line, mode) }}
          />
        ))}
      </div>
      {/* Offered only when the pane genuinely cannot fit, so the control is
          absent on every desktop-sized reading. */}
      {canOfferFit && (
        <button
          type="button"
          id="herdr-fit-toggle"
          className="scope__fit"
          aria-pressed={fit}
          title={`${columns} columns in ${Math.round(width)}px`}
          onClick={() => setFit((current) => !current)}
        >
          {fit ? "1:1" : `fit ${columns}c`}
        </button>
      )}
    </section>
  );
}

/** Printable width of a line, ignoring escape sequences. */
function stripLength(line: string): number {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").length;
}
