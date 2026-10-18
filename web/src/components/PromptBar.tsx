import { useRef, useState } from "react";
import { sendPaneKeys, sendPaneText } from "@/lib/herdr";

const HISTORY_MAX = 50;

/**
 * Prompt line for one pane. Enter sends the line, Tab flushes the line and
 * then sends a real Tab so the shell completes instead of executing, and
 * ArrowUp/Down walks the send history.
 */
export function PromptBar({ paneId }: { paneId: string }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const history = useRef<string[]>([]);
  const historyIndex = useRef(-1);

  async function send(text: string): Promise<void> {
    if (text.trim() === "" || busy) {
      return;
    }
    setBusy(true);
    try {
      if (!(await sendPaneText(paneId, text))) {
        return;
      }
      if (history.current[history.current.length - 1] !== text) {
        history.current.push(text);
        if (history.current.length > HISTORY_MAX) {
          history.current.shift();
        }
      }
      historyIndex.current = -1;
      // Clear only what was sent: a slow POST must not wipe text typed after
      // Enter was pressed.
      setValue((current) => (current === text ? "" : current));
    } finally {
      setBusy(false);
    }
  }

  async function complete(): Promise<void> {
    if (value.trim() === "" || busy) {
      return;
    }
    setBusy(true);
    try {
      // The line goes out without a newline, then Tab asks the shell to
      // complete it; the box keeps the text so the result stays editable.
      if (await sendPaneText(paneId, value.replace(/\n$/, ""), false)) {
        await sendPaneKeys(paneId, ["Tab"]);
      }
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send(value);
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      void complete();
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (history.current.length === 0) {
        return;
      }
      historyIndex.current =
        historyIndex.current < 0
          ? history.current.length - 1
          : Math.max(0, historyIndex.current - 1);
      setValue(history.current[historyIndex.current] ?? "");
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (historyIndex.current < 0) {
        return;
      }
      historyIndex.current += 1;
      if (historyIndex.current >= history.current.length) {
        historyIndex.current = -1;
        setValue("");
        return;
      }
      setValue(history.current[historyIndex.current] ?? "");
    }
  }

  return (
    <div className="prompt">
      <span className="prompt__glyph" aria-hidden>
        ❯
      </span>
      <input
        id="herdr-input"
        className="prompt__input"
        type="text"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        placeholder={`send to ${paneId}`}
        aria-label={`Send input to ${paneId}`}
        value={value}
        disabled={busy}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="prompt__hints" aria-hidden>
        <span>
          <kbd>↑↓</kbd> history
        </span>
        <span>
          <kbd>⇥</kbd> complete
        </span>
      </div>
      <button
        type="button"
        id="herdr-send"
        className="prompt__send"
        disabled={busy || value.trim() === ""}
        onClick={() => void send(value)}
      >
        send
      </button>
    </div>
  );
}
