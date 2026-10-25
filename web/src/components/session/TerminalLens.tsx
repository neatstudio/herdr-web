import { useEffect, useRef, useState } from "react";

import "@xterm/xterm/css/xterm.css";
import "../../terminal.css";

import type { FitAddon } from "@xterm/addon-fit";
import type { ITheme, Terminal } from "@xterm/xterm";

import { sendPaneKeys, sendPaneText, terminalKeyName, type KeyStroke } from "@/lib/herdr";
import type { PageTheme } from "@/lib/fleet";
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
  const snapshotRef = useRef("");

  const [failed, setFailed] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
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
        const [xterm, fitModule] = await Promise.all([
          import("@xterm/xterm"),
          import("@xterm/addon-fit"),
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
      snapshotRef.current = "";
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
  // page changed theme". Setting `theme` also repaints xterm's own cells.
  useEffect(() => {
    const term = termRef.current;
    if (term === null) {
      return;
    }
    term.options.theme = readTheme();
    syncScrollState();
  }, [theme]);

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
      <KeyMenu paneId={paneId} latches={latches} onLatches={setLatches} />
    </div>
  );
}
