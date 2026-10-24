import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchAllPanes,
  fetchWorkspaces,
  quotePath,
  sendPaneKeys,
  sendPaneText,
  terminalKeyName,
  typePaneText,
  uploadFile,
  type HerdrPane,
  type HerdrWorkspace,
} from "@/lib/herdr";
import { PROMPT_ID, keyboardIsPrimary, shouldClaimKey } from "@/lib/focus";
import { paneName, toneOf } from "@/lib/fleet";
import { findPaths } from "@/lib/paths";
import {
  ATTACH_IN_FLIGHT,
  attachmentBadge,
  attachmentLabel,
  dropMention,
  formatBytes,
  isPreviewable,
  pickAttachments,
  rejectionNote,
  type AttachmentRejection,
  type AttachmentState,
} from "@/lib/attachments";
import {
  APP_ACTIONS,
  applyCompletion,
  mentionItems,
  mentionQuery,
  readDraft,
  scoreMatches,
  slashQuery,
  writeDraft,
  type ComposerAction,
  type ComposerItem,
  type DraftStore,
} from "@/lib/composer";

const HISTORY_MAX = 50;
/** Longest line that is typed key by key before it becomes a paste. */
const TYPE_LIMIT = 400;
/** The box grows to this many lines, then scrolls. */
const MAX_ROWS = 8;
/** How often pane status is re-read, and only while the tab is visible. */
const STATUS_POLL_MS = 5000;
/** A keyboard may cover at most this share of the viewport before lifting stops. */
const LIFT_MAX_RATIO = 0.6;

type PaletteKind = "slash" | "mention";

/**
 * One picked file, while it is being turned into a path. The tile is the only
 * place the upload is visible: it says whether the bytes are still moving,
 * whether the path is now in the box, and it can be taken back out again.
 */
type Attachment = {
  id: number;
  file: File;
  /** Object URL for an image, drawn as the tile itself; null for a document. */
  preview: string | null;
  state: AttachmentState;
  /** The host path once it exists; the mention in the box is derived from it. */
  path: string | null;
};

/** The open completion menu, in the coordinates of the draft it edits. */
type Palette = {
  kind: PaletteKind;
  start: number;
  end: number;
  query: string;
  items: ComposerItem[];
};

/**
 * Whether a line can be typed instead of pasted: a key carries one ASCII
 * character, and a multi-line line is a pasted block by definition.
 */
function canType(text: string): boolean {
  return text.length > 0 && text.length <= TYPE_LIMIT && /^[\x20-\x7e]+$/.test(text);
}

/**
 * The operator's draft store, or null where a browser refuses it (private
 * windows, a storage policy). A missing draft is recoverable; a throwing
 * keystroke handler is not, so every access goes through the quiet helpers in
 * `lib/composer.ts`.
 */
function draftStore(): DraftStore | null {
  try {
    return window.localStorage;
  } catch {
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
 *
 * On top of that this is the mobile input layer: "/" offers the app's own
 * views, "@" offers panes, workspaces and the paths this client knows, drafts
 * are kept per pane, and a working agent gets an interrupt control.
 */
export function PromptBar({
  paneId,
  onAction,
}: {
  paneId: string;
  onAction?: (action: ComposerAction) => void;
}) {
  const [store] = useState<DraftStore | null>(draftStore);
  const [value, setValue] = useState(() => readDraft(store, paneId));
  const [valuePane, setValuePane] = useState(paneId);
  const [restored, setRestored] = useState(() => value.trim() !== "");
  const [caret, setCaret] = useState(0);
  const [menuClosed, setMenuClosed] = useState(false);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [raw, setRaw] = useState(false);
  const [panes, setPanes] = useState<HerdrPane[]>([]);
  const [workspaces, setWorkspaces] = useState<HerdrWorkspace[] | null>(null);
  const [uploaded, setUploaded] = useState<string[]>([]);
  const [stopping, setStopping] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [rejected, setRejected] = useState<AttachmentRejection[]>([]);
  const history = useRef<string[]>([]);
  const historyIndex = useRef(-1);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const promptRef = useRef<HTMLDivElement | null>(null);
  /** Tiles as they are now, for cleanup that must not re-run on every render. */
  const attachmentsRef = useRef<Attachment[]>([]);
  attachmentsRef.current = attachments;
  const nextAttachmentId = useRef(0);
  /** Files waiting for a slot: only ATTACH_IN_FLIGHT uploads run at once. */
  const queued = useRef<Attachment[]>([]);
  const inFlight = useRef(0);
  /** Tiles dismissed mid-upload: their result must not land in the box. */
  const dismissed = useRef(new Set<number>());
  /** Where the caret goes once the text it belongs to is in the DOM. */
  const pendingCaret = useRef<{ at: number; length: number } | null>(null);

  const pane = panes.find((entry) => entry.id === paneId);
  const working = toneOf(pane?.agentStatus) === "working";
  /** One send control, two jobs: an empty box on a working pane can interrupt it. */
  const stopMode = working && !raw && value.trim() === "";
  const failed = attachments.filter((entry) => entry.state === "error");
  /**
   * One line for everything the pick could not do: a file refused before it
   * left the phone, or an upload that came back empty. A tile carries its own
   * state; this is the sentence the operator needs to act on.
   */
  const note =
    rejected.length > 0
      ? rejectionNote(rejected)
      : failed.length === 0
        ? ""
        : failed.length === 1
          ? `could not attach ${failed[0]?.file.name ?? "file"}`
          : `could not attach ${failed.length} files`;

  /**
   * Paths this client can offer on "@": what was uploaded in this session and
   * what the draft already mentions. There is no directory listing endpoint,
   * so a path the operator has not seen here cannot be completed.
   */
  const knownFiles = useMemo(() => {
    const found = findPaths(value).map((match) => match.path);
    return Array.from(new Set([...uploaded, ...found]));
  }, [value, uploaded]);

  const menu = useMemo<Palette | null>(() => {
    if (raw || menuClosed) {
      return null;
    }
    // App-level slash commands only exist once the app can act on them; an
    // un-wired composer keeps typing "/..." into the pane exactly as before.
    if (onAction !== undefined) {
      const slash = slashQuery(value, caret);
      // A command is one word: "/tmp/x" is a path, not a command.
      if (slash !== null && !slash.query.includes("/")) {
        const items = scoreMatches(slash.query, APP_ACTIONS);
        if (items.length > 0) {
          return { kind: "slash", ...slash, items };
        }
      }
    }
    const mention = mentionQuery(value, caret);
    if (mention === null) {
      return null;
    }
    const items = scoreMatches(
      mention.query,
      mentionItems({
        panes: panes.map((entry) => ({
          id: entry.id,
          name: paneName(entry),
          agent: entry.displayAgent ?? entry.agent,
          cwd: entry.cwd,
        })),
        workspaces: workspaces ?? [],
        files: knownFiles,
      }),
    );
    // Nothing to offer is no menu at all: the text falls through to the pane.
    return items.length === 0 ? null : { kind: "mention", ...mention, items };
  }, [caret, knownFiles, menuClosed, onAction, panes, raw, value, workspaces]);

  const activeIndex = menu === null ? -1 : Math.min(active, menu.items.length - 1);
  const menuKey = menu === null ? "" : `${menu.kind}\u0000${menu.start}\u0000${menu.query}`;

  // A new menu starts at its first entry, so Enter always accepts something
  // the operator has seen.
  useEffect(() => {
    setActive(0);
  }, [menuKey]);

  /**
   * Attach files by putting their paths on the herdr host into the prompt.
   * That is how a CLI agent takes an image: it reads the file it is told about.
   * Each file is a tile while its bytes move, and becomes a mention the moment
   * the host answers with a path, so the box only ever holds paths that exist.
   */
  function attach(files: FileList | File[]): void {
    const picked = pickAttachments(Array.from(files));
    setRejected(picked.rejected);
    if (picked.taken.length === 0) {
      return;
    }
    const added: Attachment[] = picked.taken.map((file) => {
      nextAttachmentId.current += 1;
      return {
        id: nextAttachmentId.current,
        file,
        preview: isPreviewable(file.type) ? URL.createObjectURL(file) : null,
        state: "uploading",
        path: null,
      };
    });
    setAttachments((current) => [...current, ...added]);
    queued.current.push(...added);
    pumpUploads();
  }

  /** Starts uploads until the slots are full; each finish starts the next. */
  function pumpUploads(): void {
    while (inFlight.current < ATTACH_IN_FLIGHT && queued.current.length > 0) {
      const item = queued.current.shift();
      if (item === undefined) {
        return;
      }
      inFlight.current += 1;
      void uploadFile(item.file).then((stored) => {
        inFlight.current -= 1;
        if (!dismissed.current.has(item.id)) {
          if (stored === null) {
            setAttachments((current) =>
              current.map((entry) => (entry.id === item.id ? { ...entry, state: "error" } : entry)),
            );
          } else {
            const mention = quotePath(stored.path);
            setAttachments((current) =>
              current.map((entry) =>
                entry.id === item.id ? { ...entry, state: "ready", path: stored.path } : entry,
              ),
            );
            // An uploaded path is a path this client now knows, so "@" offers it.
            setUploaded((current) =>
              current.includes(stored.path) ? current : [...current, stored.path],
            );
            setValue((current) => (current === "" ? `${mention} ` : `${current} ${mention} `));
            inputRef.current?.focus();
          }
        }
        pumpUploads();
      });
    }
  }

  /** Dismissing a tile also takes the mention it put in the box back out. */
  function removeAttachment(item: Attachment): void {
    dismissed.current.add(item.id);
    if (item.preview !== null) {
      URL.revokeObjectURL(item.preview);
    }
    setAttachments((current) => current.filter((entry) => entry.id !== item.id));
    if (item.path !== null) {
      const mention = quotePath(item.path);
      setValue((current) => dropMention(current, mention));
    }
  }

  /** A failed tile keeps its file, so the same bytes can be tried again. */
  function retryFailed(): void {
    const retried = attachments.filter((entry) => entry.state === "error");
    if (retried.length === 0) {
      return;
    }
    setAttachments((current) =>
      current.map((entry) => (entry.state === "error" ? { ...entry, state: "uploading" } : entry)),
    );
    queued.current.push(...retried);
    pumpUploads();
  }

  // Object URLs are memory the browser keeps until they are told otherwise.
  useEffect(
    () => () => {
      for (const entry of attachmentsRef.current) {
        if (entry.preview !== null) {
          URL.revokeObjectURL(entry.preview);
        }
      }
    },
    [],
  );

  // A new pane takes the caret with it, but only where a keyboard is primary:
  // on a phone this would raise the on-screen keyboard over the transcript.
  useEffect(() => {
    if (keyboardIsPrimary()) {
      inputRef.current?.focus();
    }
  }, [paneId]);

  /**
   * A pane's draft comes back with the pane. The shell keys the composer by
   * pane id, so this is mostly the mount path; the dependency also covers a
   * switch without a remount, and `valuePane` keeps the write effect below from
   * saving the old pane's text under the new pane's key in between.
   *
   * Losing a draft is worse than keeping a stale one, and a draft the operator
   * just sent is gone for good: sending clears the stored copy.
   */
  useEffect(() => {
    const draft = readDraft(store, paneId);
    setValue(draft);
    setValuePane(paneId);
    setRestored(draft.trim() !== "");
    setMenuClosed(false);
    setRaw(false);
    pendingCaret.current = { at: draft.length, length: draft.length };
  }, [paneId, store]);

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

  // Keep the caret state in step with the box, so a menu is computed from where
  // the operator actually is. A completion moves the caret itself; that move is
  // held in `pendingCaret` until the text it belongs to has been rendered.
  useEffect(() => {
    const box = inputRef.current;
    if (box === null) {
      return;
    }
    const pending = pendingCaret.current;
    if (pending !== null) {
      if (box.value.length !== pending.length) {
        return;
      }
      pendingCaret.current = null;
      box.setSelectionRange(pending.at, pending.at);
      setCaret(pending.at);
      return;
    }
    setCaret(box.selectionStart ?? value.length);
  }, [value, paneId]);

  // Every keystroke is a draft; an emptied box is no draft at all.
  useEffect(() => {
    if (valuePane !== paneId) {
      return;
    }
    writeDraft(store, paneId, value);
  }, [store, paneId, value, valuePane]);

  useEffect(() => {
    if (value === "") {
      setRestored(false);
    }
  }, [value]);

  // Whether the pane is working decides which keys the composer owns. The app
  // polls the fleet on its own; this poll is the composer's view of one pane,
  // and it costs nothing while the tab is hidden.
  useEffect(() => {
    let alive = true;
    async function refresh(): Promise<void> {
      if (document.visibilityState !== "visible") {
        return;
      }
      const next = await fetchAllPanes();
      if (alive && next !== null) {
        setPanes(next);
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), STATUS_POLL_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  // Workspaces are only needed once a mention menu is open; fetch them then.
  const paletteKind = menu === null ? null : menu.kind;
  useEffect(() => {
    if (paletteKind !== "mention" || workspaces !== null) {
      return;
    }
    let alive = true;
    void fetchWorkspaces().then((next) => {
      if (alive && next !== null) {
        setWorkspaces(next);
      }
    });
    return () => {
      alive = false;
    };
  }, [paletteKind, workspaces]);

  // The on-screen keyboard shrinks the visual viewport instead of the window on
  // iOS, which would leave the send button underneath it. Lift the composer by
  // what the keyboard covers, and never by more than a phone screenful.
  useEffect(() => {
    const target = promptRef.current;
    const viewport = window.visualViewport;
    if (target === null || viewport === null) {
      return;
    }
    const box: HTMLDivElement = target;
    const view: VisualViewport = viewport;
    function apply(): void {
      const hidden = Math.max(0, Math.round(window.innerHeight - view.height));
      const lift =
        hidden > 0 ? Math.min(hidden, Math.round(window.innerHeight * LIFT_MAX_RATIO)) : 0;
      box.style.transform = lift > 0 ? `translateY(-${lift}px)` : "";
    }
    apply();
    view.addEventListener("resize", apply);
    view.addEventListener("scroll", apply);
    return () => {
      view.removeEventListener("resize", apply);
      view.removeEventListener("scroll", apply);
      box.style.transform = "";
    };
  }, []);

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

  /** Send one terminal key to the pane while its agent is working. */
  async function interrupt(key: string): Promise<void> {
    if (stopping) {
      return;
    }
    setStopping(true);
    try {
      await sendPaneKeys(paneId, [key]);
    } finally {
      setStopping(false);
    }
  }

  /**
   * Take the highlighted menu entry.
   *
   * A slash entry is an app action: its token leaves the box (the rest of the
   * draft stays) and the app — never the pane — is told what was chosen.
   * `upload` is the exception: the file input belongs to this component, so the
   * composer opens it itself. A mention entry inserts text at the caret.
   */
  function accept(item: ComposerItem): void {
    if (menu === null) {
      return;
    }
    const action = menu.kind === "slash" ? item.action : undefined;
    const completed = applyCompletion(value, caret, {
      start: menu.start,
      end: menu.end,
      query: menu.query,
      value: action === undefined ? item.value : "",
    });
    let text = completed.text;
    let at = completed.caret;
    // A mention at the end of the line gets a trailing space, so the next word
    // starts clean instead of running into the inserted token.
    if (action === undefined && menu.kind === "mention" && menu.end >= value.length) {
      text += " ";
      at += 1;
    }
    pendingCaret.current = { at, length: text.length };
    setValue(text);
    setCaret(at);
    setMenuClosed(true);
    setActive(0);
    if (action === "upload") {
      fileRef.current?.click();
    } else if (action !== undefined) {
      onAction?.(action);
    }
    inputRef.current?.focus();
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
    const key = terminalKeyName(event);
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
    if (event.key === "Escape") {
      // Escape dismisses the menu it opened before it touches the keyboard.
      if (menu !== null) {
        event.preventDefault();
        setMenuClosed(true);
        return;
      }
      // A working agent is the one state the composer owns: Shift+Esc interrupts
      // it, because plain Escape still means "raw keyboard" here.
      if (event.shiftKey && working) {
        event.preventDefault();
        void interrupt("esc");
        return;
      }
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
    if (menu !== null) {
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
        event.preventDefault();
        accept(menu.items[activeIndex]);
        return;
      }
      if (!event.shiftKey && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        const count = menu.items.length;
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((activeIndex + step + count) % count);
        return;
      }
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
      // Tab completes here; Shift+Tab is a TUI's own mode switch (accept edits,
      // cycle agents), so it belongs to the pane even before raw mode is on.
      if (event.shiftKey) {
        const key = terminalKeyName(event);
        if (key !== null) {
          void sendPaneKeys(paneId, [key]);
        }
        return;
      }
      void complete();
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
      const recalled = history.current[historyIndex.current] ?? "";
      pendingCaret.current = { at: recalled.length, length: recalled.length };
      setValue(recalled);
      return;
    }
    if (event.key === "ArrowDown" && !event.shiftKey) {
      event.preventDefault();
      if (historyIndex.current < 0) {
        return;
      }
      historyIndex.current += 1;
      const recalled =
        historyIndex.current >= history.current.length
          ? ""
          : (history.current[historyIndex.current] ?? "");
      if (historyIndex.current >= history.current.length) {
        historyIndex.current = -1;
      }
      pendingCaret.current = { at: recalled.length, length: recalled.length };
      setValue(recalled);
    }
  }

  return (
    <div
      ref={promptRef}
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
        attach(event.dataTransfer.files);
      }}
    >
      {menu !== null && (
        <div
          className="prompt__palette"
          role="listbox"
          aria-label={menu.kind === "slash" ? "commands" : "mentions"}
        >
          {menu.items.map((item, index) => (
            <button
              key={`${item.kind}:${item.value}`}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={index === activeIndex}
              className={index === activeIndex ? "prompt__opt prompt__opt--active" : "prompt__opt"}
              // Keep the keyboard in the box: a mousedown that moves focus would
              // blur the textarea before the click lands.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => accept(item)}
            >
              <span className="prompt__kind">{item.kind}</span>
              <span>{item.label}</span>
              {item.hint !== undefined && <span className="prompt__hint">{item.hint}</span>}
            </button>
          ))}
        </div>
      )}
      {attachments.length > 0 && (
        <ul className="prompt__files" aria-label="attached files">
          {attachments.map((entry) => (
            <li
              key={entry.id}
              className="prompt__tile"
              data-state={entry.state}
              title={`${entry.file.name} · ${formatBytes(entry.file.size)}`}
            >
              {entry.preview !== null ? (
                <img className="prompt__thumb" src={entry.preview} alt="" />
              ) : (
                <span className="prompt__doc" aria-hidden>
                  <span className="prompt__doc-glyph">▤</span>
                  <span className="prompt__doc-ext">{attachmentLabel(entry.file.name)}</span>
                </span>
              )}
              <span className="prompt__badge">{attachmentBadge(entry.state)}</span>
              <button
                type="button"
                className="prompt__untile"
                aria-label={`remove ${entry.file.name}`}
                onClick={() => removeAttachment(entry)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {note !== "" && (
        <div className="prompt__problem prompt__note" role="status">
          <span className="prompt__note-text">{note}</span>
          {failed.length > 0 && (
            <button type="button" className="prompt__note-act" onClick={retryFailed}>
              retry
            </button>
          )}
          <button
            type="button"
            className="prompt__note-act"
            onClick={() => {
              if (failed.length > 0) {
                for (const entry of failed) {
                  removeAttachment(entry);
                }
                return;
              }
              setRejected([]);
            }}
          >
            {failed.length > 0 ? "remove" : "dismiss"}
          </button>
        </div>
      )}
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
        onChange={(event) => {
          setValue(event.target.value);
          setCaret(event.target.selectionStart ?? event.target.value.length);
          setMenuClosed(false);
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
        onClick={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
        onKeyDown={onKeyDown}
        onPaste={(event) => {
          // An image on the clipboard arrives as a file with no name of its
          // own, so give it one that says what it is.
          const files = Array.from(event.clipboardData.files);
          if (files.length === 0) {
            return;
          }
          event.preventDefault();
          attach(
            files.map((file) =>
              file.name === ""
                ? new File([file], "pasted.png", { type: file.type })
                : file,
            ),
          );
        }}
      />
      <div className="prompt__actions">
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
              attach(event.target.files);
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
          onClick={() => fileRef.current?.click()}
        >
          ＋
        </button>
        {restored && value.trim() !== "" && (
          <span className="prompt__draft" title="draft kept for this pane">
            draft
          </span>
        )}
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
              {working && (
                <span>
                  <kbd>⇧esc</kbd> stop
                </span>
              )}
            </>
          )}
        </div>
        <button
          type="button"
          id="herdr-send"
          className={stopMode ? "prompt__send prompt__stop" : "prompt__send"}
          title={stopMode ? "interrupt the agent (ctrl+c)" : "send to the pane (enter)"}
          aria-label={stopMode ? "Interrupt the agent" : "Send to the pane"}
          disabled={stopMode ? stopping : busy || raw || value.trim() === ""}
          onClick={() => {
            if (stopMode) {
              void interrupt("ctrl+c");
              return;
            }
            void send(value);
          }}
        >
          <span className="prompt__send-word" aria-hidden>
            send
          </span>
          <span className="prompt__send-glyph" aria-hidden>
            {stopMode ? "■" : "↑"}
          </span>
        </button>
      </div>
    </div>
  );
}
