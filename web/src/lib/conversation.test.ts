import assert from "node:assert/strict";
import test from "node:test";

import { deriveConversation } from "./conversation.ts";

/* ------------------------------------------------------------------ ansi */

const ESC = "\u001b[";
const RESET = `${ESC}0m`;

/** A pane line filled with the user-turn background. */
function band(text: string): string {
  return `${ESC}48;2;15;18;22m${text}${RESET}`;
}

/** Ordinary agent ink: the default foreground, no attributes. */
function ink(text: string): string {
  return `${ESC}38;2;232;236;244m${text}${RESET}`;
}

/** Reasoning: small, italic, grey. */
function dim(text: string): string {
  return `${ESC}38;2;156;163;176m${ESC}3m${text}${RESET}`;
}

/** A box, every row on the same background fill. */
function box(rows: readonly string[]): string {
  return rows.map((row) => band(row.padEnd(64))).join("\n");
}

function snapshot(lines: readonly string[]): string {
  return `${lines.join("\r\n")}\r\n`;
}

/* ------------------------------------------------------------------ cases */

test("an empty snapshot has no transcript", () => {
  assert.deepEqual(deriveConversation(""), { turns: [], lines: 0 });
});

test("one exchange folds reasoning, work and a recap into one turn", () => {
  const text = snapshot([
    band(" 帮我看一下这个 bug"),
    ink("我会先看一下代码。"),
    dim("先找入口，再核对接线。"),
    dim("看看 server/bridge.go。"),
    box([
      "+--- ~ Edit: go server/bridge.go [+2/-1] ---+",
      "| 12 -  old line",
      "| 12 +  new line",
      "+------------------------------------------+",
    ]),
    ink("改好了，可以重试。"),
    dim("※ recap: 修好了 bridge 的接线"),
  ]);
  const conversation = deriveConversation(text);
  assert.equal(conversation.lines, 10);
  assert.equal(conversation.turns.length, 1);
  const turn = conversation.turns[0];
  assert.equal(turn.user, "帮我看一下这个 bug");
  assert.deepEqual(turn.thoughts, ["先找入口，再核对接线。\n看看 server/bridge.go。"]);
  assert.deepEqual(turn.work, [
    {
      kind: "edit",
      title: "Edit server/bridge.go",
      detail: ["12 -  old line", "12 +  new line"],
    },
  ]);
  assert.equal(turn.answer, "我会先看一下代码。\n改好了，可以重试。");
  assert.equal(turn.recap, "修好了 bridge 的接线");
});

test("each user band opens a new turn", () => {
  const text = snapshot([
    band(" first"),
    ink("one"),
    band(" second"),
    ink("two"),
  ]);
  const conversation = deriveConversation(text);
  assert.equal(conversation.turns.length, 2);
  assert.equal(conversation.turns[0].user, "first");
  assert.equal(conversation.turns[0].answer, "one");
  assert.equal(conversation.turns[1].user, "second");
  assert.equal(conversation.turns[1].answer, "two");
  assert.deepEqual(
    conversation.turns.map((turn) => turn.id),
    ["turn-0", "turn-1"],
  );
});

test("scrolled-in noise before the first user band has no user of its own", () => {
  const text = snapshot([ink("Earlier output."), band(" next question"), ink("answer")]);
  const conversation = deriveConversation(text);
  assert.equal(conversation.turns.length, 2);
  assert.equal(conversation.turns[0].user, null);
  assert.equal(conversation.turns[0].answer, "Earlier output.");
  assert.equal(conversation.turns[1].user, "next question");
});

test("status bars, wall clocks and box controls never become prose", () => {
  const text = snapshot([
    band(" run the tests"),
    ink("[Wall: 0.14s | Timeout: 60s]"),
    ink("| 2m > [max] DeepSeek V4.1 Flash > ~/server/herdr-web > $2.62 >"),
    ink("╰──────────────────────────────────────────────"),
    ink("  … (15 earlier lines, showing 10 of 25) [Ctrl+O: Expand]"),
    ink("answer prose"),
  ]);
  const conversation = deriveConversation(text);
  assert.equal(conversation.turns.length, 1);
  assert.equal(conversation.turns[0].answer, "answer prose");
});

test("glyph and bracket rows classify by what the agent did", () => {
  const text = snapshot([
    band(" run the tests"),
    " [*] Read server/bridge.go:60-150",
    " [x] Write server/jobs.go",
    " [!!] Diagnostics (1 error)",
    "  Esc Reading Server struct",
    " [*] Updated todo list (4 items)",
  ]);
  const conversation = deriveConversation(text);
  assert.deepEqual(
    conversation.turns[0].work.map((row) => [row.kind, row.title]),
    [
      ["read", "Read server/bridge.go:60-150"],
      ["edit", "Write server/jobs.go"],
      ["other", "Diagnostics (1 error) · failed"],
      ["other", "Reading Server struct"],
      ["other", "Updated todo list (4 items)"],
    ],
  );
});

test("an untitled box is the command and its output", () => {
  const text = snapshot([
    band(" run the tests"),
    box([
      "+--------------------------------+",
      "| $ go test ./server            |",
      "| ok  server  0.4s               |",
      "+--------------------------------+",
    ]),
  ]);
  const conversation = deriveConversation(text);
  assert.deepEqual(conversation.turns[0].work, [
    { kind: "command", title: "go test ./server", detail: ["ok  server  0.4s"] },
  ]);
});

test("an ascii table in the answer stays prose, not a tool box", () => {
  const text = snapshot([
    band(" give me the table"),
    ink("Here it is:"),
    ink("+---+---+"),
    ink("| a | b |"),
    ink("+---+---+"),
  ]);
  const conversation = deriveConversation(text);
  assert.equal(conversation.turns[0].work.length, 0);
  assert.equal(
    conversation.turns[0].answer,
    "Here it is:\n+---+---+\n| a | b |\n+---+---+",
  );
});

test("a pane with no ansi at all still becomes a document", () => {
  const text = "Plain output from an agent that does not colour.\nSecond line.\n";
  const conversation = deriveConversation(text);
  assert.equal(conversation.lines, 2);
  assert.equal(conversation.turns.length, 1);
  assert.equal(conversation.turns[0].user, null);
  assert.equal(
    conversation.turns[0].answer,
    "Plain output from an agent that does not colour.\nSecond line.",
  );
});

test("a diff stat in a box title is not part of the title", () => {
  const text = snapshot([
    band(" edit it"),
    box([
      "+--- ~ Edit: md docs/specs/SPEC-06-urban-plan.md [+1] ---+",
      "| one line changed",
      "+--------------------------------------------------------+",
    ]),
  ]);
  const conversation = deriveConversation(text);
  assert.equal(conversation.turns[0].work[0].kind, "edit");
  assert.equal(conversation.turns[0].work[0].title, "Edit docs/specs/SPEC-06-urban-plan.md");
});

/* ------------------------------------------- a window cut in mid-box */

/**
 * The live defect, with the right-hand column padding trimmed to one space:
 * omp pane `w6:p3`, the first 127 rows of a 1000-row `pane.read` window. The
 * window opens in the middle of a `+f Write` box — its opener and title are
 * above the cut — then runs through prose and three ordinary `~ Edit` boxes.
 * Background-filled body rows used to become user turns; only the leading
 * border glyph separates them from a real band (both share one background
 * colour).
 */
const CUT_BOX: readonly string[] = [
  "|+316│ →  → return \"local\" |",
  "|+317│ → } |",
  "|+318│ → return strings.TrimSpace(host) |",
  "|+319│} |",
  "|+320│ |",
  "|+321│// sharedTaskID ties a job to its shared-ledger task. A dispatched task already |",
  "|+322│// has an id; a directly started job gets one derived from its pane. |",
  "|+323│func sharedTaskID(request jobRequest, paneID string) string { |",
  "|+324│ → if id := strings.TrimSpace(request.TaskID); id != \"\" { |",
  "|+325│ →  → return id |",
  "|+326│ → } |",
  "|+327│ → return \"job-\" + paneID |",
  "|+328│} |",
  "|+329│ |",
  "|+330│// startSharedTask creates and claims the dev lease for a job. A failure here is |",
  "|+331│// logged rather than failing the start: the agent is already running, and the |",
  "|+332│// local ledger still records it; the board can catch up on the next attempt. |",
  "|+333│func (s *Server) startSharedTask(ctx context.Context, request jobRequest, taskID, label string) error { |",
  "|+334│ → if s.sharedLedger == nil || taskID == \"\" { |",
  "|+335│ →  → return nil |",
  "|+336│ → } |",
  "|+337│ → task, err := s.sharedLedger.Get(ctx, taskID) |",
  "|+338│ → if errors.Is(err, sharedledger.ErrNotFound) { |",
  "|+339│ →  → task, err = s.sharedLedger.Create(ctx, sharedledger.Task{ |",
  "|+340│ →  →  → ID: taskID, Title: label, Prompt: request.Prompt, Cwd: request.Cwd, |",
  "|+341│ →  →  → Branch: request.Branch, Kind: request.Kind, Weight: request.Weight, |",
  "|+342│ →  → }) |",
  "|+343│ →  → if err != nil { |",
  "|+344│ →  →  → return err |",
  "|+345│ →  → } |",
  "|+346│ → } else if err != nil { |",
  "|… (41 more lines) [Ctrl+O: Expand] |",
  "+-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------+",
];
const CUT_PROSE_A: readonly string[] = [
  "",
  " I see the startSharedTask has a typo: sharedledger.Task? I wrote sharedledger.Task? The content: task, err = s.sharedLedger.Create(ctx, sharedledger.Task{ — yes. The Task type is in sharedledger;",
  " fine.",
  " - The startSharedTask has sharedledger.Task; the user. The spec; the user. The user; the spec; the user. Stop.",
  " - The localNodeID; the user. The spec; the user. The user; the spec; the user. Stop.",
  " - The cancelSharedTask; the user. The spec; the user. The user; the spec; the user. Stop.",
  "",
  " Now modify the two branches. Use edit exact strings. The zerostack branch:...",
  " Change:...",
  " - The agent branch same.",
  " - The taskID variable; the user. The spec; the user. The user; the spec; the user. Stop.",
  "",
  " Edit both.",
  "",
];
const CUT_EDIT_A: readonly string[] = [
  "+--- ~ Edit: go server/jobs.go [+6/-2] -----------------------------------------------------------------------------------------------------------------------------------------------------------------+",
  "| 181│      if err := s.runInPane(ctx, paneID, command); err != nil { |",
  "| 182│         writeBadGateway(w, \"herdr_job_failed\", err) |",
  "| 183│         return |",
  "| 184│      } |",
  "|-185│ →  → s.ledger.started(created.Workspace.WorkspaceID, paneID, kind, label, strings.TrimSpace(request.TaskID)) |",
  "|   +│ →  → s.ledger.started(created.Workspace.WorkspaceID, paneID, kind, label, sharedTaskID(request, paneID)) |",
  "|+186│ →  → taskID := sharedTaskID(request, paneID) |",
  "|+187│ →  → if err := s.startSharedTask(ctx, request, taskID, label); err != nil { |",
  "|+188│ →  →  → fmt.Fprintf(os.Stderr, \"herdr-web: shared task %s: %v\\n\", taskID, err) |",
  "|+189│ →  → } |",
  "| 186│      writeJSON(w, http.StatusOK, jobStarted{ |",
  "| 187│         OK:          true, |",
  "| 189│         WorkspaceID: created.Workspace.WorkspaceID, |",
  "| 190│         PaneID:      paneID, |",
  "|-191│·········TaskID:      strings.TrimSpace(request.TaskID), |",
  "|+195│·········TaskID:      taskID, |",
  "| 192│         Branch:      strings.TrimSpace(request.Branch), |",
  "| 193│      }) |",
  "+-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------+",
];
const CUT_GAP: readonly string[] = [
  "",
];
const CUT_EDIT_B: readonly string[] = [
  "+--- ~ Edit: go server/jobs.go [+6/-2] -----------------------------------------------------------------------------------------------------------------------------------------------------------------+",
  "|  89│   if r.Method != http.MethodPost { |",
  "|… |",
  "| 213│   if err := s.client().Call(ctx, \"agent.prompt\", |",
  "| 214│      map[string]any{\"target\": paneID, \"text\": request.Prompt}, nil); err != nil { |",
  "|… |",
  "| 217│   } |",
  "| 218│ |",
  "|-219│ → s.ledger.started(created.Workspace.WorkspaceID, paneID, request.Kind, label, strings.TrimSpace(request.TaskID)) |",
  "|   +│ → s.ledger.started(created.Workspace.WorkspaceID, paneID, request.Kind, label, sharedTaskID(request, paneID)) |",
  "|+220│ → taskID := sharedTaskID(request, paneID) |",
  "|+221│ → if err := s.startSharedTask(ctx, request, taskID, label); err != nil { |",
  "|+222│ →  → fmt.Fprintf(os.Stderr, \"herdr-web: shared task %s: %v\\n\", taskID, err) |",
  "|+223│ → } |",
  "| 220│   writeJSON(w, http.StatusOK, jobStarted{ |",
  "| 221│      OK:          true, |",
  "| 223│      WorkspaceID: created.Workspace.WorkspaceID, |",
  "| 224│      PaneID:      paneID, |",
  "|-225│······TaskID:      strings.TrimSpace(request.TaskID), |",
  "|+229│······TaskID:      taskID, |",
  "| 226│      Branch:      strings.TrimSpace(request.Branch), |",
  "| 227│   }) |",
  "+-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------+",
];
const CUT_PROSE_B: readonly string[] = [
  "",
  " The zerostack branch has s.ledger.started(..., sharedTaskID(request, paneID)) then taskID := ...; fine. The user; the spec; the user. The user; the spec; the user. Stop.",
  "",
  " Now modify handleJobStatus:",
  " - After the status computed, before writeJSON:...",
  " - The event.WorkspaceID; the user. The spec; the user. The user; the spec; the user. Stop.",
  " - The s.ledger.stopped; the user. The spec; the user. The user; the spec; the user. Stop.",
  " - The attestSharedTask; the user. The spec; the user. The user; the spec; the user. Stop.",
  " - The taskID; the user. The spec; the user. The user; the spec; the user. Stop.",
  " - The status done/error; the user. The spec; the user. The user; the spec; the user. Stop.",
  "",
  " Edit. The user; the spec; the user. The user; the spec; the user. Stop.",
  "",
];
const CUT_EDIT_EDGE: readonly string[] = [
  "+--- ~ Edit: go server/jobs.go [+11] -------------------------------------------------------------------------------------------------------------------------------------------------------------------+",
  "| 501│   if commandJob { |",
  "|… |",
  "| 511│   } else if statusErr != nil && read.Text == \"\" { |",
  "|… |",
  "| 514│   } else if status == \"\" { |",
  "| 515│      status = \"unknown\" |",
  "| 516│   } |",
  "|+517│ → if isJob && (status == \"done\" || status == \"error\") { |",
  "|+518│ →  → taskID := event.TaskID |",
  "|+519│ →  → if taskID == \"\" { |",
  "|+520│ →  →  → taskID = sharedTaskID(jobRequest{}, paneID) |",
  "|+521│ →  → } |",
  "|+522│ →  → if err := s.attestSharedTask(ctx, taskID); err != nil { |",
  "|+523│ →  →  → fmt.Fprintf(os.Stderr, \"herdr-web: attest shared task %s: %v\\n\", taskID, err) |",
  "|+524│ →  → } |",
  "|+525│ →  → // Completion releases the execution slot; the workspace/result stays. |",
  "|+526│ →  → s.ledger.stopped(event.WorkspaceID) |",
  "|+527│ → } |",
  "| 517│   writeJSON(w, http.StatusOK, map[string]any{ |",
  "| 518│      \"ok\":     true, |",
  "|… |",
  "| 523│   }) |",
];

function cutBoxSnapshot(): string {
  return snapshot([
    ...CUT_BOX.map(band),
    ...CUT_PROSE_A,
    ...CUT_EDIT_A.map(band),
    ...CUT_GAP,
    ...CUT_EDIT_B.map(band),
    ...CUT_PROSE_B,
    ...CUT_EDIT_EDGE.map(band),
  ]);
}


test("a box body cut off by the window top is work, not a user turn", () => {
  const conversation = deriveConversation(cutBoxSnapshot());
  assert.equal(conversation.turns.filter((turn) => turn.user !== null).length, 0);
  assert.equal(conversation.turns.length, 1);
  assert.equal(conversation.turns[0].user, null);
  const rows = conversation.turns[0].work;
  assert.ok(rows.length >= 3, `expected work rows, saw ${rows.length}`);
  assert.equal(rows[0].kind, "other");
  assert.equal(rows[0].title, "Earlier output");
  assert.equal(rows[0].detail.length, 31);
  assert.equal(rows[0].detail[0], '+316│ →  → return "local"');
  assert.ok(!conversation.turns[0].answer.includes("|+316│"));
});

test("rows of a box with no visible opener extend the previous work row", () => {
  const conversation = deriveConversation(
    snapshot([
      ink("✓ Read lines 1-9 in ./server/a.go"),
      band("|  1│ package a"),
      band("|  2│ func x() {}"),
    ]),
  );
  assert.equal(conversation.turns.length, 1);
  assert.equal(conversation.turns[0].user, null);
  assert.equal(conversation.turns[0].work.length, 1);
  assert.deepEqual(conversation.turns[0].work[0].detail, [" 1│ package a", " 2│ func x() {}"]);
});

test("a background-filled box rule is never a user turn", () => {
  const rule = `+${"-".repeat(40)}+`;
  const conversation = deriveConversation(snapshot([band(rule), band("| tail of a box")]));
  assert.equal(conversation.turns.length, 1);
  assert.equal(conversation.turns[0].user, null);
  assert.equal(conversation.turns[0].work[0].kind, "other");
  assert.equal(conversation.turns[0].work[0].title, "Earlier output");
});

test("a unicode border and a diff gutter are box body too", () => {
  const conversation = deriveConversation(
    snapshot([band("│ ╎ body"), band("|+12│ diff row"), band("| -3│ removed")]),
  );
  assert.equal(conversation.turns.filter((turn) => turn.user !== null).length, 0);
  assert.equal(conversation.turns[0].work[0].detail.length, 3);
});
