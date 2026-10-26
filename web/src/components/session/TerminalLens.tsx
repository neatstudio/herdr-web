import { useEffect, useRef, useState } from "react";

import "@xterm/xterm/css/xterm.css";
import "../../terminal.css";

import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon } from "@xterm/addon-search";
import type { ITheme, Terminal } from "@xterm/xterm";

import { sendPaneKeys, sendPaneText, terminalKeyName, type KeyStroke } from "@/lib/herdr";
import type { PageTheme } from "@/lib/fleet";
import { FIND_MISS, findInk, findLabel, type FindHit } from "@/lib/find";
import { emptyLatches, type KeyLatch } from "@/lib/keybar";
import { gridFor, TerminalSync } from "@/lib/terminalSync";
import { usePaneRead } from "@/lib/usePaneRead";

import { KeyMenu } from "./KeyMenu";

export type TerminalLensProps = {
  paneId: string;
  status: string | null;
  theme: PageTheme;
};

/** The API's own 16-colour palette, in the order ANSI numbers them. */
const ANSI_TOKENS = [
  "--ansi-0",
  "--ansi-1",
  "--ansi-2",
  "--ansi-3",
  "--ansi-4",
  "--ansi-5",
  "--ansi-6",
  "--ansi-7",
  "--ansi-8",
  "--ansi-9",
  "--ansi-10",
  "--ansi-11",
  "--ansi-12",
  "--ansi-13",
  "--ansi-14",
  "--ansi-15",
] as const;

const ANSI_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

/**
 * xterm's theme, resolved from the console's own custom properties.
 *
 * The lens takes `theme` as a prop, but that prop is a *trigger*, not a
 * palette: the colours live in `index.css` / `session.css` and are inherited by
 * whatever theme the page is wearing, so the only honest source is
 * `getComputedStyle`. Nothing here invents a colour; every fallback is another
 * token, so a missing token degrades to the console's ink rather than to a
 * hardcoded hex.
 */
function readTheme(): ITheme {
  const styles = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string): string => {
    const value = styles.getPropertyValue(name).trim();
    return value === "" ? fallback : value;
  };

  const foreground = token("--ui-term-fg", token("--ink", "#e8e6df"));
  const background = token("--ui-term-bg", token("--paper", "#0b0b0c"));
  const theme: ITheme = {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: token("--ui-accent", foreground),
    selectionForeground: token("--ui-accent-ink", background),
  };
  ANSI_KEYS.forEach((name, index) => {
    theme[name] = token(ANSI_TOKENS[index] ?? "--ansi-0", foreground);
  });
  return theme;
}

/** The row geometry the sync works in: the terminal's own grid, no margin. */
function geometryFor(term: Terminal): { cols: number; rows: number } {
  return gridFor(term.cols, term.rows);
}

/**
 * The real terminal lens.
 *
 * herdr has no byte stream. The only thing the daemon offers is
 * `pane.read`, which re-serialises the *whole screen* as ANSI on every poll, so
 * this lens cannot pipe bytes into xterm the way a socket client would: it
 * diffs consecutive snapshots (`TerminalSync`) and writes only the changed
 * rows. A poll that changes nothing writes nothing at all.
 *
 * The terminal itself is loaded lazily. It is the largest dependency in the
 * console and most sessions never open the lens, so the chunk is fetched on
 * mount; if that fetch fails the lens says so in one line instead of going
 * blank.
 */
export function TerminalLens({ paneId, status, theme }: TerminalLensProps) {
  const read = usePaneRead(paneId);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const screenRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const syncRef = useRef<TerminalSync | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const fieldRef = useRef<HTMLInputElement | null>(null);
  const snapshotRef = useRef("");

  const [failed, setFailed] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState("");
  const [hit, setHit] = useState<FindHit>(FIND_MISS);
  // Modifier latches live here, not in the key bar: a character typed into the
  // terminal must spend them too, otherwise a latched Ctrl would quietly turn
  // the next keyboard word into `ctrl+<letter>` an hour later.
  const [latches, setLatches] = useState<KeyLatch>(emptyLatches);

  /** Show the "jump to the newest output" pill only when the reader is behind. */
  const syncScrollState = (): void => {
    const term = termRef.current;
    if (term === null) {
      return;
    }
    const buffer = term.buffer.active;
    setAtBottom(buffer.viewportY >= buffer.baseY);
  };

  /**
   * Search options for the *current* palette.
   *
   * Read on every call rather than memoised: xterm's decorations only accept
   * `#RRGGBB`, so the highlight cannot be a `var()` and has to be re-derived
   * when the page flips theme.
   */
  const searchOptions = () => {
    const ink = findInk(theme);
    return {
      incremental: true,
      decorations: {
        matchBackground: ink.match,
        activeMatchBackground: ink.active,
        activeMatchBorder: ink.accent,
        matchOverviewRuler: ink.match,
        activeMatchColorOverviewRuler: ink.accent,
      },
    };
  };

  /** Search the scrollback; an empty query only clears the highlight. */
  const find = (text: string, back = false): void => {
    const search = searchRef.current;
    if (search === null) {
      return;
    }
    if (text === "") {
      search.clearDecorations();
      setHit(FIND_MISS);
      return;
    }
    if (back) {
      search.findPrevious(text, searchOptions());
    } else {
      search.findNext(text, searchOptions());
    }
  };

  /** Close the bar, drop the highlight, and hand focus back to the grid. */
  const closeFind = (): void => {
    searchRef.current?.clearDecorations();
    setFinding(false);
    setHit(FIND_MISS);
    termRef.current?.focus();
  };

  /** Write whatever the sync says changed. Input is never written locally. */
  const paint = (): void => {
    const term = termRef.current;
    const sync = syncRef.current;
    if (term === null || sync === null) {
      return;
    }
    const snapshot = snapshotRef.current;
    if (snapshot === "") {
      return;
    }
    const bytes = sync.push(snapshot);
    if (bytes === "") {
      return;
    }
    term.write(bytes, syncScrollState);
  };

  /** Match xterm's grid to the box, and repaint if the grid moved. */
  const refit = (): void => {
    const term = termRef.current;
    const fit = fitRef.current;
    const host = hostRef.current;
    const sync = syncRef.current;
    if (term === null || fit === null || host === null) {
      return;
    }
    if (host.clientWidth <= 0 || host.clientHeight <= 0) {
      return;
    }
    const before = `${term.cols}x${term.rows}`;
    try {
      fit.fit();
    } catch {
      return; // a host that is being laid out is asked again by the observer
    }
    if (`${term.cols}x${term.rows}` === before || sync === null) {
      syncScrollState();
      return;
    }
    // Both a new width (every line rewraps) and a new height (the addressable
    // window changes) invalidate the diff, so the screen is redrawn from the
    // current snapshot rather than patched.
    sync.setGeometry(geometryFor(term).cols, geometryFor(term).rows);
    sync.reset();
    term.reset();
    paint();
    syncScrollState();
  };

  useEffect(() => {
    const host = screenRef.current;
    if (host === null) {
      return;
    }

    let disposed = false;
    let term: Terminal | null = null;
    let fit: FitAddon | null = null;
    let observer: ResizeObserver | null = null;
    const viewport = window.visualViewport;

    void (async () => {
      try {
        const [xterm, fitModule, searchModule] = await Promise.all([
          import("@xterm/xterm"),
          import("@xterm/addon-fit"),
          import("@xterm/addon-search"),
        ]);
        if (disposed) {
          return;
        }

        term = new xterm.Terminal({
          allowProposedApi: true,
          convertEol: false,
          cursorBlink: true,
          cursorStyle: "bar",
          fontFamily: '"Geist Mono Variable", ui-monospace, monospace',
          fontSize: 13,
          // A cell the height of the em box clips glyphs that draw to both
          // edges of it — box drawing and block elements lose their last
          // pixel row, which reads as a torn frame at the bottom of the grid.
          // A fifth of a line of leading costs one row on a phone and makes
          // every frame character whole.
          letterSpacing: 0,
          lineHeight: 1.2,
          scrollback: 2000,
          theme: readTheme(),
        });
        fit = new fitModule.FitAddon();
        term.loadAddon(fit);
        const search = new searchModule.SearchAddon();
        term.loadAddon(search);
        searchRef.current = search;
        search.onDidChangeResults(({ resultIndex, resultCount }) => {
          setHit({ index: resultIndex, count: resultCount });
        });
        term.open(host);
        if (disposed) {
          term.dispose();
          return;
        }
        termRef.current = term;
        fitRef.current = fit;
        try {
          fit.fit();
        } catch {
          // no size yet; the observer fits on the first real layout pass
        }

        syncRef.current = new TerminalSync({
          cols: geometryFor(term).cols,
          rows: geometryFor(term).rows,
        });

        // Typed characters go to the pane as text. Everything the terminal
        // would normally render itself (Enter, arrows, Ctrl chords) is caught
        // below and sent as a named key instead: nothing is echoed locally,
        // because the next snapshot is the echo.
        term.onData((data) => {
          if (data !== "") {
            setLatches(emptyLatches());
            void sendPaneText(paneId, data, false);
          }
        });

        term.attachCustomKeyEventHandler((event) => {
          if (event.type !== "keydown") {
            return true;
          }
          if (
            event.metaKey &&
            !event.ctrlKey &&
            !event.altKey &&
            event.key.toLowerCase() === "f"
          ) {
            // ⌘F is the console's own find, not the browser's: xterm paints
            // onto canvases, so Chromium's find bar reports "no results" on
            // rows the reader can plainly see. Ctrl+F is deliberately left to
            // the pane — readline and every TUI behind it bind it.
            setFinding(true);
            return false;
          }
          const stroke: KeyStroke = {
            key: event.key,
            ctrlKey: event.ctrlKey,
            altKey: event.altKey,
            shiftKey: event.shiftKey,
            metaKey: event.metaKey,
          };
          const name = terminalKeyName(stroke);
          if (name === null) {
            return true; // a Meta chord belongs to the browser, not the pane
          }
          if (event.key.length === 1 && !event.ctrlKey && !event.altKey) {
            return true; // printable: let xterm compose it and route it to onData
          }
          setLatches(emptyLatches());
          void sendPaneKeys(paneId, [name]);
          return false;
        });

        term.onScroll(syncScrollState);

        observer = new ResizeObserver(refit);
        observer.observe(hostRef.current ?? host);
        window.addEventListener("orientationchange", refit);
        viewport?.addEventListener("resize", refit);
        document.addEventListener("visibilitychange", refit);

        refit();
        paint();
        syncScrollState();
      } catch {
        if (!disposed) {
          setFailed(true);
        }
      }
    })();

    return () => {
      disposed = true;
      observer?.disconnect();
      window.removeEventListener("orientationchange", refit);
      viewport?.removeEventListener("resize", refit);
      document.removeEventListener("visibilitychange", refit);
      term?.dispose();
      termRef.current = null;
      fitRef.current = null;
      syncRef.current = null;
      searchRef.current = null;
      snapshotRef.current = "";
      // The bar, the query and the highlight belong to the pane that closed.
      setFinding(false);
      setQuery("");
      setHit(FIND_MISS);
    };
    // A different pane means a different grid: xterm is rebuilt from scratch so
    // no scrollback, latch or pending diff can cross the switch.
  }, [paneId]);

  // New snapshot: the diff decides how much of it is written.
  useEffect(() => {
    snapshotRef.current = read.text;
    paint();
  }, [read.text]);

  // The palette is re-read from the live stylesheet; the prop only says "the
  // page changed theme". Setting `theme` also repaints xterm's own cells, so an
  // open highlight has to be re-run: its colours are hex, not custom properties.
  useEffect(() => {
    const term = termRef.current;
    if (term === null) {
      return;
    }
    term.options.theme = readTheme();
    if (finding && query !== "") {
      find(query);
    }
    syncScrollState();
  }, [theme]);

  // Opening the bar takes the keyboard: the field is the only place a reader can
  // type, and `select()` makes a second ⌘F replace the old query.
  useEffect(() => {
    if (!finding) {
      return;
    }
    const field = fieldRef.current;
    if (field !== null) {
      field.focus();
      field.select();
    }
    if (query !== "") {
      find(query);
    }
    // `theme` is here on purpose: reopening after a theme flip must repaint the
    // highlight with the new hex pair.
  }, [finding, theme]);

  return (
    <div className="term" data-status={status ?? "unknown"}>
      <div
        className="term__host"
        ref={hostRef}
        onPointerDown={() => {
          termRef.current?.focus();
        }}
      >
        <div className="term__xterm" ref={screenRef} />
        {finding ? (
          <div
            className="term__find"
            role="search"
            // The host focuses the grid on any pointer down; the bar is the
            // one place inside this box that must keep the keyboard instead.
            onPointerDown={(event) => {
              event.stopPropagation();
            }}
          >
            <input
              ref={fieldRef}
              className="term__find-field"
              type="search"
              value={query}
              placeholder="find in scrollback"
              aria-label="Find in the terminal"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="search"
              onChange={(event) => {
                const next = event.target.value;
                setQuery(next);
                find(next);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  closeFind();
                  return;
                }
                if (event.key === "Enter") {
                  // Enter walks forward, Shift+Enter back: the direction a
                  // reader already has in their fingers from the key bar.
                  event.preventDefault();
                  find(query, event.shiftKey);
                  return;
                }
                if (event.metaKey && event.key.toLowerCase() === "f") {
                  event.preventDefault();
                  event.currentTarget.select();
                }
              }}
            />
            <span className="term__find-count" aria-live="polite">
              {findLabel(hit)}
            </span>
            <button
              type="button"
              className="term__find-step"
              aria-label="Previous match"
              onClick={() => {
                find(query, true);
              }}
            >
              ↑
            </button>
            <button
              type="button"
              className="term__find-step"
              aria-label="Next match"
              onClick={() => {
                find(query);
              }}
            >
              ↓
            </button>
            <button
              type="button"
              className="term__find-close"
              aria-label="Close find"
              onClick={closeFind}
            >
              ×
            </button>
          </div>
        ) : null}
        {failed ? (
          <p>The terminal could not be loaded in this browser. The pane is still running.</p>
        ) : null}
        {!failed && !atBottom ? (
          <button
            type="button"
            className="term__jump"
            onClick={() => {
              termRef.current?.scrollToBottom();
              setAtBottom(true);
            }}
          >
            latest ↓
          </button>
        ) : null}
      </div>
      {/* Beside the grid, not on it. The magnifier is a phone affordance — a
          thumb has no ⌘F — and on a phone it used to float over the grid's
          top-right corner, the one place a TUI puts its status line. At
          390×844 that hid the tail of two paragraphs; on a 844×390 frame with
          the keyboard up the grid is four rows and the 44px disc covered three
          of them. It is a sibling of `.term__host` now, so `terminal.css` can
          dock it into the key strip on touch frames (and nowhere else: on a
          fine pointer the corner it always had is the corner it keeps). The
          tap cancels the pointerdown default so the composer keeps its focus —
          and with it the soft keyboard — while the search field takes over. */}
      {finding ? null : (
        <button
          type="button"
          className="term__find-open"
          aria-label="Find in the terminal"
          title="Find (⌘F)"
          onPointerDown={(event) => {
            event.preventDefault();
          }}
          onClick={() => {
            setFinding(true);
          }}
        >
          <svg
            viewBox="0 0 20 20"
            width="17"
            height="17"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <circle cx="8.75" cy="8.75" r="5.25" />
            <path d="M12.75 12.75 16.5 16.5" />
          </svg>
        </button>
      )}
      <KeyMenu paneId={paneId} latches={latches} onLatches={setLatches} />
    </div>
  );
}
