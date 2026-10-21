import { useEffect, useRef, useState } from "react";
import {
  quotePath,
  sendPaneKeys,
  sendPaneText,
  typePaneText,
  uploadFile,
} from "@/lib/herdr";
import { PROMPT_ID, keyboardIsPrimary, shouldClaimKey } from "@/lib/focus";

const HISTORY_MAX = 50;
/** Longest line that is typed key by key before it becomes a paste. */
const TYPE_LIMIT = 400;
/** The box grows to this many lines, then scrolls. */
const MAX_ROWS = 8;

/**
 * Whether a line can be typed instead of pasted: a key carries one ASCII
 * character, and a multi-line line is a pasted block by definition.
 */
function canType(text: string): boolean {
  return text.length > 0 && text.length <= TYPE_LIMIT && /^[\x20-\x7e]+$/.test(text);
}

/**
 * herdr's name for one browser key, or null when the key means nothing to a
 * terminal. Raw mode forwards these one by one, which is how completion,
 * history and a TUI's own menus keep working.
 */
function terminalKey(event: React.KeyboardEvent): string | null {
  if (event.ctrlKey && !event.altKey && !event.metaKey && event.key.length === 1) {
    return `ctrl+${event.key.toLowerCase()}`;
  }
  if (event.metaKey || event.altKey) {
    return null;
  }
  if (event.key === " ") {
    // The daemon rejects " " and takes "space" for it.
    return "space";
  }
  if (event.key.length === 1) {
    return event.key;
  }
  switch (event.key) {
    case "Enter":
      return "Enter";
    case "Tab":
      return "Tab";
    case "Backspace":
      return "Backspace";
    case "Delete":
      return "Delete";
    case "Escape":
      return "esc";
    case "ArrowUp":
      return "Up";
    case "ArrowDown":
      return "Down";
    case "ArrowLeft":
      return "Left";
    case "ArrowRight":
      return "Right";
    case "Home":
      return "Home";
    case "End":
      return "End";
    case "PageUp":
      return "PageUp";
    case "PageDown":
      return "PageDown";
    default:
      return null;
  }
}

/**
 * Composer for one pane.
 *
 * Enter sends, Shift+Enter makes a newline, and the box wraps and grows, so a
 * long message is readable before it goes out. Two things follow from the fact
 * that the terminal — not this box — owns the real line editor:
 *
 *   - A line is *typed* rather than pasted when it is plain ASCII. A TUI reads
 *     pasted text literally and opens no menus for it, so "/model" pasted does
 *     nothing while the same characters typed open the agent's picker.
 *   - Raw mode forwards every key to the pane, which is the only way shell
 *     completion, arrow-key history and Ctrl-C can work: they belong to the
 *     pane's line editor, not to a text box.
 */
export function PromptBar({ paneId }: { paneId: string }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [raw, setRaw] = useState(false);
  const history = useRef<string[]>([]);
  const historyIndex = useRef(-1);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [dropping, setDropping] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [problem, setProblem] = useState("");

  /**
   * Attach files by putting their paths on the herdr host into the prompt.
   * That is how a CLI agent takes an image: it reads the file it is told about.
   */
  async function attach(files: FileList | File[]): Promise<void> {
    const list = Array.from(files);
    if (list.length === 0) {
      return;
    }
    setProblem("");
    setUploading((count) => count + list.length);
    try {
      const paths: string[] = [];
      for (const file of list) {
        const stored = await uploadFile(file);
        if (stored === null) {
          setProblem(`could not attach ${file.name}`);
          continue;
        }
        paths.push(quotePath(stored.path));
      }
      if (paths.length > 0) {
        setValue((current) => (current === "" ? `${paths.join(" ")} ` : `${current} ${paths.join(" ")} `));
        inputRef.current?.focus();
      }
    } finally {
      setUploading((count) => Math.max(0, count - list.length));
    }
  }

  // A new pane takes the caret with it, but only where a keyboard is primary:
  // on a phone this would raise the on-screen keyboard over the transcript.
  useEffect(() => {
    if (keyboardIsPrimary()) {
      inputRef.current?.focus();
    }
  }, [paneId]);

  // Leave raw mode when the pane changes: those keys belong to the pane that
  // was focused when the operator turned it on.
  useEffect(() => {
    setRaw(false);
    setValue("");
  }, [paneId]);

  // Grow with the content, up to MAX_ROWS lines, then scroll.
  useEffect(() => {
    const box = inputRef.current;
    if (box === null) {
      return;
    }
    box.style.height = "auto";
    const line = parseFloat(getComputedStyle(box).lineHeight) || 17;
    box.style.height = `${Math.min(box.scrollHeight, line * MAX_ROWS)}px`;
  }, [value, raw]);

  // Reaching for the prompt from anywhere on the page. Keys that belong to a
  // focused control are left alone, so the page stays keyboard navigable.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (!shouldClaimKey(event.key, document.activeElement)) {
        return;
      }
      const input = document.getElementById(PROMPT_ID);
      if (input === null) {
        return;
      }
      event.preventDefault();
      (input as HTMLTextAreaElement).focus();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  /**
   * Type the line into the pane, then hand the keyboard to it.
   *
   * Completion, history and a TUI's menus belong to the pane's line editor.
   * Continuing to hold the text in this box after a Tab would leave two copies
   * of the same line, and an Enter here would send the stale one; so the line
   * leaves the box and raw mode takes over.
   */
  async function handOff(text: string, keys: string[]): Promise<void> {
    const line = text.replace(/\n+$/, "");
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      const delivered = canType(line)
        ? await typePaneText(paneId, line, false)
        : await sendPaneText(paneId, line, false);
      if (!delivered) {
        return;
      }
      if (keys.length > 0) {
        await sendPaneKeys(paneId, keys);
      }
      setValue("");
      setRaw(true);
    } finally {
      setBusy(false);
    }
  }

  async function send(text: string): Promise<void> {
    const line = text.replace(/\n+$/, "");
    if (line.trim() === "" || busy) {
      return;
    }
    // An agent's slash command opens a menu for the rest of the line; sending
    // Enter here would pick the first entry before the operator saw it. The
    // characters go in, the menu stays open, and raw mode takes the next keys.
    if (line.startsWith("/") && canType(line)) {
      await handOff(line, []);
      return;
    }
    setBusy(true);
    try {
      // Typed input keeps a TUI's own menus alive; anything a key cannot carry
      // (non-ASCII, a pasted block) goes out as text.
      const delivered = canType(line)
        ? await typePaneText(paneId, line)
        : await sendPaneText(paneId, line);
      if (!delivered) {
        return;
      }
      if (history.current[history.current.length - 1] !== line) {
        history.current.push(line);
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
    // Tab is completion, and completion happens in the pane: the line moves
    // there and the next keys belong to it, so Tab can be pressed again.
    await handOff(value, ["Tab"]);
  }

  function onRawKey(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    // Escape belongs to the pane: it cancels a menu, leaves insert mode, closes
    // a dialog. Taking it to leave raw mode is what made "/model" impossible to
    // back out of, so the way out is Shift+Esc, which a TUI does not want.
    if (event.key === "Escape" && event.shiftKey) {
      event.preventDefault();
      setRaw(false);
      return;
    }
    const key = terminalKey(event);
    if (key === null) {
      return;
    }
    event.preventDefault();
    void sendPaneKeys(paneId, [key]);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (raw) {
      onRawKey(event);
      return;
    }
    // Ctrl+letter is a terminal key, not a document shortcut: Ctrl-C interrupts,
    // Ctrl-D ends input, Ctrl-Z suspends. It is only handed to the pane when
    // nothing is selected, because with a selection Ctrl-C means copy.
    if (event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1) {
      const box = event.currentTarget;
      if (box.selectionStart !== box.selectionEnd) {
        return;
      }
      event.preventDefault();
      void sendPaneKeys(paneId, [`ctrl+${event.key.toLowerCase()}`]);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send(value);
      return;
    }
    if (event.key === "Enter" && event.shiftKey) {
      // A newline in the box, not a send.
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      void complete();
      return;
    }
    if (event.key === "Escape") {
      // Escape closes whatever is open before it changes the keyboard: a viewer
      // or a sheet also listens for it, and swallowing it here would leave the
      // overlay open with no way out.
      if (document.querySelector(".viewer, .sheet, .hostpanel, [role='dialog']") !== null) {
        return;
      }
      // Otherwise raw mode is how completion, history and a TUI's menus work:
      // they are the pane's line editor, and a text box cannot stand in for them.
      event.preventDefault();
      setRaw(true);
      return;
    }
    if (event.key === "ArrowUp" && !event.shiftKey) {
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
    if (event.key === "ArrowDown" && !event.shiftKey) {
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
    <div
      className="prompt"
      data-raw={raw ? "on" : undefined}
      data-drop={dropping ? "on" : undefined}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          setDropping(true);
        }
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(event) => {
        if (event.dataTransfer.files.length === 0) {
          return;
        }
        event.preventDefault();
        setDropping(false);
        void attach(event.dataTransfer.files);
      }}
    >
      <span className="prompt__glyph" aria-hidden>
        {raw ? "⌨" : "❯"}
      </span>
      <textarea
        ref={inputRef}
        id={PROMPT_ID}
        className="prompt__input"
        rows={1}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        placeholder={raw ? `keys go to ${paneId} — esc leaves raw mode` : `send to ${paneId}`}
        aria-label={`Send input to ${paneId}`}
        value={raw ? "" : value}
        disabled={busy}
        readOnly={raw}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
        onPaste={(event) => {
          // An image on the clipboard arrives as a file with no name of its
          // own, so give it one that says what it is.
          const files = Array.from(event.clipboardData.files);
          if (files.length === 0) {
            return;
          }
          event.preventDefault();
          void attach(
            files.map((file) =>
              file.name === ""
                ? new File([file], "pasted.png", { type: file.type })
                : file,
            ),
          );
        }}
      />
      <div className="prompt__actions">
        {problem !== "" && (
          <span className="prompt__problem" role="status">
            {problem}
          </span>
        )}
        {raw && (
          <button
            type="button"
            id="herdr-raw-off"
            className="prompt__keys prompt__keys--on"
            title="leave raw keyboard mode (shift+esc)"
            onClick={() => {
              setRaw(false);
              inputRef.current?.focus();
            }}
          >
            keys on · ⇧esc
          </button>
        )}
        <input
          ref={fileRef}
          id="herdr-attach"
          className="prompt__file"
          type="file"
          multiple
          tabIndex={-1}
          aria-hidden
          onChange={(event) => {
            if (event.target.files !== null) {
              void attach(event.target.files);
            }
            event.target.value = "";
          }}
        />
        <button
          type="button"
          id="herdr-attach-button"
          className="prompt__attach"
          title="attach a file or image by path"
          aria-label="Attach a file or image"
          disabled={uploading > 0}
          onClick={() => fileRef.current?.click()}
        >
          {uploading > 0 ? "…" : "＋"}
        </button>
        <div className="prompt__hints" aria-hidden>
          {raw ? (
            <span>
              <kbd>⇧esc</kbd> back
            </span>
          ) : (
            <>
              <span>
                <kbd>⇥</kbd> complete
              </span>
              <span>
                <kbd>^c</kbd> interrupt
              </span>
              <span>
                <kbd>⇧⏎</kbd> newline
              </span>
            </>
          )}
        </div>
        <button
          type="button"
          id="herdr-send"
          className="prompt__send"
          disabled={busy || raw || value.trim() === ""}
          onClick={() => void send(value)}
        >
          send
        </button>
      </div>
    </div>
  );
}
