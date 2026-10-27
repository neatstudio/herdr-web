/*
 * Reading settings: the two things about the transcript that are a matter of
 * eyes rather than of layout — how large its text is and how long its measure
 * is. A phone at 14px/1.55 fits 21 Chinese characters in a line, which is
 * right for some people and too small for others; a 3000px monitor at 820px
 * gives a comfortable column for prose and a narrow one for a diff.
 *
 * Only the text moves. The chrome around it — 40px head rows, 26px work rows,
 * 44px targets — keeps its measured geometry, because those numbers are about
 * thumbs and fingers, not about reading. Neither does the composer's textarea:
 * it keeps its 16px floor so iOS does not zoom the field on focus.
 *
 * Applied as CSS custom properties on <html>, so the stylesheet keeps owning
 * geometry and this module owns only the choice. "default" writes nothing at
 * all — the stylesheet's own values are the default — which is what keeps every
 * pinned phone measurement (ask width 351, resting card, prose leading) valid
 * until the operator deliberately asks for something else.
 */

export type ReadSize = "small" | "default" | "large";
export type ReadMeasure = "narrow" | "default" | "wide";

export type Reading = {
  size: ReadSize;
  measure: ReadMeasure;
};

export const READING_KEY = "herdr-web-reading";

export const READING_DEFAULT: Reading = { size: "default", measure: "default" };

export const READ_SIZES: ReadSize[] = ["small", "default", "large"];
export const READ_MEASURES: ReadMeasure[] = ["narrow", "default", "wide"];

/*
 * The measured baselines these replace (phone / desktop):
 *   small   body 12.5px (from 14/15), meta 10px (10.5/11), code 10.5px
 *           (11.5/12) — five characters a line more than default at 390px.
 *   large   body 16.5px, meta 12px, code 13px — one step above the desktop
 *           document size, for a phone held further away.
 *   narrow  640px measure, and 40px of side inset on a phone lane (350px of
 *           text instead of 366) — fewer characters, more air per line.
 *   wide    1080px measure, 16px of side inset — for a terminal screenshot
 *           read next to the prose that explains it.
 */
const SIZE_VARS: Record<Exclude<ReadSize, "default">, Record<string, string>> = {
  small: {
    "--ui-body": "12.5px",
    "--ui-meta": "10px",
    "--ui-code": "10.5px",
    "--ui-leading": "1.5",
  },
  large: {
    "--ui-body": "16.5px",
    "--ui-meta": "12px",
    "--ui-code": "13px",
    "--ui-leading": "1.66",
  },
};

const MEASURE_VARS: Record<Exclude<ReadMeasure, "default">, Record<string, string>> = {
  narrow: { "--ui-lane": "min(100% - 40px, 640px)" },
  wide: { "--ui-lane": "min(100% - 16px, 1080px)" },
};

/** Every property a choice may write, so a switch back to default clears them. */
const READING_PROPS = [
  "--ui-body",
  "--ui-meta",
  "--ui-code",
  "--ui-leading",
  "--ui-lane",
];

export function isReadSize(value: unknown): value is ReadSize {
  return value === "small" || value === "default" || value === "large";
}

export function isReadMeasure(value: unknown): value is ReadMeasure {
  return value === "narrow" || value === "default" || value === "wide";
}

/** The default for an unknown or partial record: never throw, never guess. */
export function normaliseReading(value: unknown): Reading {
  if (typeof value !== "object" || value === null) {
    return { ...READING_DEFAULT };
  }
  const record = value as { size?: unknown; measure?: unknown };
  return {
    size: isReadSize(record.size) ? record.size : READING_DEFAULT.size,
    measure: isReadMeasure(record.measure) ? record.measure : READING_DEFAULT.measure,
  };
}

/*
 * Stored as two words rather than JSON: the one record this app keeps is a
 * theme string, and "small/narrow" survives a hand edit in the console the way
 * `herdr-web-theme=dark` does.
 */
export function formatReading(reading: Reading): string {
  return `${reading.size}/${reading.measure}`;
}

export function parseReading(value: unknown): Reading {
  if (typeof value !== "string") {
    return { ...READING_DEFAULT };
  }
  const [size, measure] = value.split("/");
  return normaliseReading({ size, measure });
}

export function readStoredReading(storage: Pick<Storage, "getItem"> | null): Reading {
  try {
    return parseReading(storage?.getItem(READING_KEY));
  } catch {
    return { ...READING_DEFAULT };
  }
}

export function storeReading(
  storage: Pick<Storage, "setItem"> | null,
  reading: Reading,
): void {
  try {
    storage?.setItem(READING_KEY, formatReading(reading));
  } catch {
    /* private mode: the choice just will not persist */
  }
}

export function isDefaultReading(reading: Reading): boolean {
  return reading.size === "default" && reading.measure === "default";
}

/** The custom properties a choice sets; empty for the default choice. */
export function readingVars(reading: Reading): Record<string, string> {
  const vars: Record<string, string> = {};
  if (reading.size !== "default") {
    Object.assign(vars, SIZE_VARS[reading.size]);
  }
  if (reading.measure !== "default") {
    Object.assign(vars, MEASURE_VARS[reading.measure]);
  }
  return vars;
}

/**
 * Write the choice onto the document. The data attributes are for the tests and
 * for anything that wants to key off the choice; the properties are the effect.
 */
export function applyReading(
  reading: Reading,
  root: HTMLElement | null | undefined = typeof document === "undefined"
    ? null
    : document.documentElement,
): void {
  if (root === null || root === undefined) {
    return;
  }
  const vars = readingVars(reading);
  for (const prop of READING_PROPS) {
    if (prop in vars) {
      root.style.setProperty(prop, vars[prop]);
    } else {
      root.style.removeProperty(prop);
    }
  }
  root.dataset.readSize = reading.size;
  root.dataset.readMeasure = reading.measure;
}
