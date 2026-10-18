/*
 * Agent status vocabulary. The daemon reports free-form status strings, so
 * they are mapped once, here, and the rest of the UI only ever sees a Tone.
 */

export type Tone = "blocked" | "working" | "done" | "idle";

/** Order groups appear in the ledger: what needs a human comes first. */
export const TONE_ORDER: Tone[] = ["blocked", "working", "idle", "done"];

export const TONE_LABEL: Record<Tone, string> = {
  blocked: "needs input",
  working: "working",
  idle: "idle",
  done: "finished",
};

/** One-glyph form for the horizontal ledger on narrow screens. */
export const TONE_CODE: Record<Tone, string> = {
  blocked: "!",
  working: "~",
  idle: "·",
  done: "✓",
};

export function toneOf(status: string | undefined | null): Tone {
  const value = (status ?? "").trim().toLowerCase();
  if (value === "blocked" || value === "needs input" || value === "waiting") {
    return "blocked";
  }
  if (value === "working" || value === "running" || value === "busy") {
    return "working";
  }
  if (value === "done" || value === "finished" || value === "complete") {
    return "done";
  }
  return "idle";
}

export type Grouped<T> = { tone: Tone; items: T[] };

/** Bucket items by tone, preserving TONE_ORDER and dropping empty groups. */
export function groupByTone<T>(items: T[], statusOf: (item: T) => string | undefined): Grouped<T>[] {
  const buckets = new Map<Tone, T[]>();
  for (const item of items) {
    const tone = toneOf(statusOf(item));
    const bucket = buckets.get(tone);
    if (bucket) {
      bucket.push(item);
    } else {
      buckets.set(tone, [item]);
    }
  }
  return TONE_ORDER.filter((tone) => (buckets.get(tone)?.length ?? 0) > 0).map((tone) => ({
    tone,
    items: buckets.get(tone) ?? [],
  }));
}

/** Split pane output into lines, dropping the trailing empty line. */
export function splitLines(text: string): string[] {
  if (text === "") {
    return [];
  }
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/** Last path segment, for compact socket and cwd readouts. */
export function tailPath(value: string, segments = 1): string {
  const parts = value.split("/").filter((part) => part !== "");
  if (parts.length === 0) {
    return value;
  }
  return parts.slice(Math.max(0, parts.length - segments)).join("/");
}
