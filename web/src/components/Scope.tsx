import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ansiLineToHtml, canvasBackdrop, canvasTone, isHorizontalRule } from "@/lib/ansi";
import { READ_LINES, readPane } from "@/lib/herdr";
import { canvasModeFor, splitLines, type PageTheme } from "@/lib/fleet";
import { DISPLAY_MODES, type DisplayMode } from "@/lib/theme";

/**
 * How often to look for new output. A read costs a few milliseconds against the
 * local socket, so a fast tick is affordable and is what makes typing feel like
 * a terminal rather than a poll behind one. herdr reports revision 0 ("unknown")
 * for panes, so the cheap comparison has to be the text itself: an unchanged
 * read skips the ANSI conversion and the React render entirely, which is where
 * the cost actually is.
 */
const FAST_MS = 150;
/** Idle backoff: nobody is typing, so stop asking five times a second. */
const IDLE_MS = 600;
/** Ticks without a change before the slow interval takes over. */
const IDLE_TICKS = 8;
/** The tab is in the background: freshen occasionally, not constantly. */
const HIDDEN_MS = 2500;
const TAIL_SLOP_PX = 48;
/** Monospace advance as a fraction of the font size, for fit-to-width. */
const MONO_ADVANCE = 0.6;
const BASE_FONT_PX = 12.5;
/**
 * Floor for fit-to-width. Scaling a 300-column pane to 4px makes a grey smear;
 * below a readable size the transcript keeps the floor and scrolls sideways
 * instead of pretending to fit.
 */
const MIN_FIT_PX = 10;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Past this share, a background is worth mirroring for the page theme. The bar
 * is low because an absolute colour was chosen for a terminal: a TUI that paints
 * its echoed input on a navy bar leaves hard navy blocks on paper otherwise.
 * Palette references are untouched either way, so a theme's own colours stay.
 */
const MIRROR_SHARE = 0.1;

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
  /** A path in the output was clicked; the caller opens its preview. */
  onOpenPath?: (path: string) => void;
};

function ScopeView({ paneId, theme, display, onDisplay, onOpenPath }: Props) {
  const [lines, setLines] = useState<string[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [failed, setFailed] = useState(false);
  const [width, setWidth] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);
  const revisionRef = useRef(-1);
  const lastTextRef = useRef("");
  const truncatedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    followRef.current = true;
    revisionRef.current = -1;
    lastTextRef.current = "";
    setLines([]);
    setTruncated(false);
    setFailed(false);

    async function readOnce(): Promise<void> {
      const read = await readPane(paneId, READ_LINES).catch(() => null);
      if (cancelled) {
        return;
      }
      if (read === null) {
        setFailed(true);
        return;
      }
      setFailed(false);
      // Repainting 200 lines of ANSI is the expensive part, far more than the
      // read itself, so an unchanged pane costs nothing here.
      if (read.text === lastTextRef.current && read.truncated === truncatedRef.current) {
        return;
      }
      lastTextRef.current = read.text;
      truncatedRef.current = read.truncated;
      setLines(splitLines(read.text));
      setTruncated(read.truncated);
    }

    async function watch(): Promise<void> {
      let idle = 0;
      while (!cancelled) {
        const before = lastTextRef.current;
        await readOnce();
        if (cancelled) {
          return;
        }
        idle = lastTextRef.current === before ? idle + 1 : 0;
        const interval = document.visibilityState === "hidden"
          ? HIDDEN_MS
          : idle > IDLE_TICKS
            ? IDLE_MS
            : FAST_MS;
        await sleep(interval);
      }
    }

    // A keystroke is written to the daemon and drawn by it; waiting for the next
    // tick would show it up to a tick late. The write pokes this scope instead.
    function onPoke(): void {
      void readOnce();
    }
    window.addEventListener("herdr:poke", onPoke);
    void watch();

    return () => {
      cancelled = true;
      window.removeEventListener("herdr:poke", onPoke);
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
  // Converting 200 lines of ANSI is the expensive half of a repaint, and the
  // page re-renders for reasons that have nothing to do with this pane (a fleet
  // poll, a theme switch). Memoised on exactly what the output depends on.
  const rendered = useMemo(() => lines.map((line) => ansiLineToHtml(line, mode)), [lines, mode]);
  // A wrapped transcript needs the canvas behind every row, so the backdrop is
  // the pane's own canvas, mirrored when the page theme disagrees with it.
  const backdrop = canvasBackdrop(paintCanvas, mode);
  // A rule is decoration, not a column the reader needs; letting a 120-dash
  // separator decide the fit size would shrink every word around it.
  const rules = useMemo(() => lines.map(isHorizontalRule), [lines]);
  const columns = lines.reduce(
    (widest, line, index) => (rules[index] ? widest : Math.max(widest, stripLength(line))),
    0,
  );
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
        // A path link is rendered by the ANSI renderer, so the click is
        // delegated here rather than attaching a handler per line.
        onClick={(event) => {
          const link = (event.target as HTMLElement).closest("[data-path]");
          if (link === null || onOpenPath === undefined) {
            return;
          }
          event.preventDefault();
          onOpenPath(link.getAttribute("data-path") ?? "");
        }}
        onScroll={(event) => {
          const element = event.currentTarget;
          followRef.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < TAIL_SLOP_PX;
        }}
      >
        {rendered.map((html, index) => (
          <div
            key={index}
            className={`scope__line${rules[index] ? " scope__line--rule" : ""}`}
            // Renderer output only: ANSI escape sequences become spans, and
            // text is HTML-escaped before any markup is added.
            dangerouslySetInnerHTML={{ __html: html }}
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
                  : `scale down to ${MIN_FIT_PX}px, then scroll sideways (${columns} columns)`
            }
            onClick={() => onDisplay(item)}
          >
            {item}
          </button>
        ))}
        {overflows && (
          <span className="scope__display-hint" aria-hidden>
            {columns}c ↔
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

/**
 * The transcript is the most expensive thing on the page and the fleet poll
 * re-renders the tree every few seconds; memo keeps an unchanged pane from
 * paying for ANSI conversion again.
 */
export const Scope = memo(ScopeView);
