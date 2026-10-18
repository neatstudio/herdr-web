import { useEffect, useRef, useState } from "react";
import { quotePath, sendPaneKeys, sendPaneText, uploadFile } from "@/lib/herdr";
import { PROMPT_ID, keyboardIsPrimary, shouldClaimKey } from "@/lib/focus";

const HISTORY_MAX = 50;

/**
 * Prompt line for one pane. Enter sends the line, Tab flushes the line and
 * then sends a real Tab so the shell completes instead of executing, and
 * ArrowUp/Down walks the send history.
 *
 * Focus is part of the contract: opening a pane puts the caret here, and a
 * Tab or Enter pressed while nothing on the page has focus brings it back, so
 * typing never needs the mouse first.
 */
export function PromptBar({ paneId }: { paneId: string }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const history = useRef<string[]>([]);
  const historyIndex = useRef(-1);
  const inputRef = useRef<HTMLInputElement | null>(null);
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
      input.focus();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

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
    <div
      className="prompt"
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
        ❯
      </span>
      <input
        ref={inputRef}
        id={PROMPT_ID}
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
    </div>
  );
}
