import type { PageTheme } from "@/lib/fleet";
import type { Lens } from "@/lib/lens";

import { ChatLens } from "./ChatLens";
import { TerminalLens } from "./TerminalLens";

/**
 * A session on a phone: one pane, two ways to read it.
 *
 * The transcript is the default because a phone is a reading device, and a
 * 46-column xterm of a 201-column TUI is unreadable without pinch-zoom. The
 * terminal is one tap away and is a real xterm, not a mirror — full-screen
 * programs (htop, vi, an agent's own input box) are exactly what it is for.
 *
 * Two deviations from the reference implementation (Ovis), both deliberate:
 *
 *   - The switch between lens lives in the console's own `.stage__head`
 *     (owned by App), not inside this stage. It costs no extra vertical height,
 *     and the composer can drive the same state through `onAction`.
 *   - Only one lens is mounted at a time. Ovis keeps the terminal mounted while
 *     the chat is shown, which is the right call when the viewer may flip back
 *     mid-keystroke; here both lenses poll the same `usePaneRead` cache (400 ms
 *     while live), and a hidden xterm would be rewritten on every snapshot for
 *     a screen nobody is looking at. Remounting is lossless: `TerminalSync`
 *     resets and the next snapshot repaints the screen, and the transcript is
 *     re-derived from that same snapshot.
 *
 * The `narrow` gate that puts this stage on screen is App's, and it is
 * narrower than Ovis's 768px on purpose: herdr-web's own breakpoints already
 * fold the shell's rails at 900px wide, so the lens has to be available before
 * the desktop mirror stops fitting. The gate is a short side (lib/frame.ts),
 * not a width: it is what keeps a landscape phone (932x430) in the lens and a
 * portrait tablet (820x1180) on the stage, whichever way either is turned.
 */
export type SessionStageProps = {
  paneId: string;
  /** herdr agentStatus for the pane; null when the daemon has not said. */
  status: string | null;
  lens: Lens;
  theme: PageTheme;
  /** Switch registers, shared with the header control and the composer. */
  onLens: (lens: Lens) => void;
};

export function SessionStage({ paneId, status, lens, theme, onLens }: SessionStageProps) {
  return (
    <div className="lens" data-lens={lens}>
      <div className="lens__body">
        {lens === "chat" ? (
          // The hint row inside the transcript needs a way out, and the header
          // switch is 46px above the text; both call the same setter.
          <ChatLens paneId={paneId} status={status} onOpenTerminal={() => onLens("terminal")} />
        ) : (
          <TerminalLens paneId={paneId} status={status} theme={theme} />
        )}
      </div>
      {/* The switch the header carries, for the one frame that has no header.
          A phone on its side gives the lenses 180px with the keyboard up and
          the identity row above them is what pays for the key row; the price is
          that the switch is not in the DOM's visible tree while typing, and the
          operator is exactly then most likely to want the other lens (a TUI
          menu needs the terminal, an answer needs the transcript). The key row
          is centred, so its flanks are empty: the same two words ride there,
          costing the body nothing. `index.css` decides *when* — only coarse,
          short frames with a key row and the keyboard up. */}
      <div
        className="flip"
        role="group"
        aria-label="session view"
        // Cancelling the pointerdown keeps the composer's focus, so flipping
        // lenses does not drop the soft keyboard (and with it this control).
        onPointerDown={(event) => event.preventDefault()}
      >
        <button
          type="button"
          className="flip__opt"
          aria-pressed={lens === "chat"}
          title="read this session as a transcript"
          onClick={() => onLens("chat")}
        >
          chat
        </button>
        <button
          type="button"
          className="flip__opt"
          aria-pressed={lens === "terminal"}
          title="the session's real terminal"
          onClick={() => onLens("terminal")}
        >
          term
        </button>
      </div>
    </div>
  );
}
