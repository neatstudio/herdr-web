/*
 * The words the chat lens puts around a folded run of agent work.
 *
 * Everything here is pure: the summary vocabulary and the two duration
 * formats are the only prose the transcript generates itself, so tests can pin
 * both without a clock or a locale.
 */

/** The four kinds of work the transcript folds. */
export type WorkKind = "edit" | "read" | "command" | "other";

/** How many of each kind happened in one run of work. */
export type WorkCounts = Record<WorkKind, number>;

/** Counts are joined in the order a reader cares about. */
export const COUNT_ORDER: readonly WorkKind[] = ["edit", "read", "command", "other"];

/** Singular and plural noun per kind, in Ovis's vocabulary. */
const NOUNS: Record<WorkKind, readonly [string, string]> = {
  edit: ["edit", "edits"],
  read: ["file read", "file reads"],
  command: ["command", "commands"],
  other: ["action", "actions"],
};

/** A zeroed count record. */
export const EMPTY_COUNTS: WorkCounts = { edit: 0, read: 0, command: 0, other: 0 };

/** Tally rows by kind; the summary head is built from this. */
export function countWork(rows: readonly { kind: WorkKind }[]): WorkCounts {
  const counts: WorkCounts = { edit: 0, read: 0, command: 0, other: 0 };
  for (const row of rows) {
    counts[row.kind] += 1;
  }
  return counts;
}

/**
 * `1 edit`, `2 edits`, `1 file read`, `3 commands`. Zero, negative and
 * non-finite counts render as the empty string: the caller joins what exists.
 */
export function countLabel(kind: WorkKind, count: number): string {
  if (!Number.isFinite(count)) {
    return "";
  }
  const whole = Math.floor(count);
  if (whole <= 0) {
    return "";
  }
  const [one, many] = NOUNS[kind];
  return `${whole} ${whole === 1 ? one : many}`;
}

/** `2 edits · 3 file reads · 1 command`, non-zero kinds only, in COUNT_ORDER. */
export function summariseWork(counts: WorkCounts): string {
  const parts: string[] = [];
  for (const kind of COUNT_ORDER) {
    const label = countLabel(kind, counts[kind]);
    if (label !== "") {
      parts.push(label);
    }
  }
  return parts.join(" · ");
}

/** How many rows the counts describe. */
export function totalWork(counts: WorkCounts): number {
  let total = 0;
  for (const kind of COUNT_ORDER) {
    total += counts[kind];
  }
  return total;
}

/**
 * Short duration: `7s`, `2m 36s`, `1h 2m`, `14ms`. Fractions of a second are
 * rounded to milliseconds; everything below a second keeps the `ms` form so a
 * fast job never reads as `0s`.
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "0s";
  }
  if (seconds < 1) {
    return `${Math.max(1, Math.round(seconds * 1000))}ms`;
  }
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
  }
  return `${rest}s`;
}

/**
 * Parse a compact duration from agent output: `2m17s`, `1h 2m`, `14ms`, `3s`.
 * Returns seconds, or null when there is no duration in the text.
 */
export function parseDuration(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") {
    return null;
  }
  const millis = /^(\d+(?:\.\d+)?)\s*ms$/i.exec(trimmed);
  if (millis !== null) {
    return Number(millis[1]) / 1000;
  }
  const compact = /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?$/i.exec(trimmed);
  if (compact === null) {
    return null;
  }
  const [, hours, minutes, seconds] = compact;
  if (hours === undefined && minutes === undefined && seconds === undefined) {
    return null;
  }
  return Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0);
}
