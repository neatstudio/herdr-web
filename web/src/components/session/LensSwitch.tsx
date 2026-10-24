import type { Lens } from "@/lib/lens";

/**
 * The two-word switch that decides how the operator reads this session.
 *
 * It lives in the stage header rather than a bar of its own: the header is
 * already 46px tall on a phone and adding a second strip would cost a sixth of
 * the screen for two buttons. Icons are not used — at this size a glyph has to
 * be learned, and the words are the only thing that survives a 320px width.
 */
export function LensSwitch({
  lens,
  onLens,
}: {
  lens: Lens;
  onLens: (lens: Lens) => void;
}) {
  return (
    <div className="lens__switch" role="group" aria-label="session view">
      <button
        type="button"
        className="lens__opt"
        aria-pressed={lens === "chat"}
        title="read this session as a transcript"
        onClick={() => onLens("chat")}
      >
        chat
      </button>
      <button
        type="button"
        className="lens__opt"
        aria-pressed={lens === "terminal"}
        title="the session's real terminal"
        onClick={() => onLens("terminal")}
      >
        term
      </button>
    </div>
  );
}
