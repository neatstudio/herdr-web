import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ansiLineToHtml, canvasBackdrop, canvasTone } from "@/lib/ansi";
import { READ_LINES, readPane } from "@/lib/herdr";
import { canvasModeFor, splitLines, type PageTheme } from "@/lib/fleet";
import { DISPLAY_MODES, type DisplayMode } from "@/lib/theme";

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

/** Past this share, a background is worth mirroring for the page theme. */
const MIRROR_SHARE = 0.4;

/** Past this share, it is the pane's own canvas and may be painted behind it. */
const CANVAS_SHARE = 0.6;

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
type Props = {
  paneId: string;
  theme: PageTheme;
  display: DisplayMode;
  onDisplay: (mode: DisplayMode) => void;
};

export function Scope({ paneId, theme, display, onDisplay }: Props) {
  const [lines, setLines] = useState<string[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [failed, setFailed] = useState(false);
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
  }, [lines, width, display]);

  // A pane that paints a canvas is a full-screen app; plain output is not.
  // The raw canvas decides the layout, and the page theme decides whether the
  // content's colours need mirroring to match it.
  // Two bars for the same colour. Half a pane of dark background is enough to
  // mirror on paper, but the pane is only painted with it when it is really the
  // pane's own canvas; otherwise a band of highlighted output would become a
  // wall of colour.
  const tone = canvasTone(lines);
  const rawCanvas = tone.share >= MIRROR_SHARE ? tone.colour : null;
  const paintCanvas = tone.share >= CANVAS_SHARE ? tone.colour : null;
  const mode = canvasModeFor(rawCanvas, theme);
  // A wrapped transcript needs the canvas behind every row, so the backdrop is
  // the pane's own canvas, mirrored when the page theme disagrees with it.
  const backdrop = canvasBackdrop(paintCanvas, mode);
  const columns = lines.reduce((widest, line) => Math.max(widest, stripLength(line)), 0);
  const fitScale = columns > 0 && width > 0 ? width / (columns * MONO_ADVANCE) : BASE_FONT_PX;
  const fontPx =
    display === "fit"
      ? Math.max(MIN_FIT_PX, Math.min(BASE_FONT_PX, fitScale))
      : BASE_FONT_PX;
  const overflows = columns * MONO_ADVANCE * fontPx > width + 1;

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
        data-canvas={backdrop !== null ? "content" : undefined}
        data-wrap={display === "wrap" ? "on" : "off"}
        data-display={display}
        data-adapt={mode !== "content" ? mode : undefined}
        style={{
          ...(backdrop !== null ? { background: backdrop } : {}),
          ...(display === "fit" ? { fontSize: `${fontPx.toFixed(2)}px` } : {}),
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
      {/* How the transcript follows the screen. herdr owns the pane width and
          pane.read takes no width argument, so the browser cannot ask for
          narrower output: wrapping is the only way text follows the screen,
          and scaling is the only way a fixed-width pane shows its whole row. */}
      <div className="scope__display" role="group" aria-label="Transcript layout">
        {DISPLAY_MODES.map((item) => (
          <button
            key={item}
            type="button"
            id={`herdr-display-${item}`}
            className="scope__display-button"
            aria-pressed={display === item}
            title={
              item === "wrap"
                ? "reflow to the screen width"
                : item === "exact"
                  ? "one row per terminal line, scroll sideways"
                  : `scale so all ${columns} columns fit`
            }
            onClick={() => onDisplay(item)}
          >
            {item}
          </button>
        ))}
        {overflows && display !== "fit" && (
          <span className="scope__display-hint" aria-hidden>
            {columns}c
          </span>
        )}
      </div>
    </section>
  );
}

/** Printable width of a line, ignoring escape sequences. */
function stripLength(line: string): number {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").length;
}
