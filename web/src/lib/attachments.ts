/* --------------------------------------------------------- attachments */
/* A file leaves the composer as a path, not as a file: herdr can only send
   text, so an upload exists for the one thing the agent needs, which is the
   absolute path of a file it can open. Everything here is the arithmetic
   around that: how many files one pick may carry, how large one may be, what
   a tile says while the bytes are in flight, and how the path is taken back
   out of the box when its tile is dismissed.

   The numbers are Ovis's, because they are the ones a phone can survive: one
   request the server takes (32 MiB), one drag that stays a drag (100 files),
   and three uploads at a time so a slow file does not hold the whole pick. */

/** One request, which is also one file: the server refuses more (UploadLimit). */
export const MAX_ATTACH_BYTES = 32 * 1024 * 1024;

/** One pick or drop. Beyond this the excess is reported, not silently queued. */
export const MAX_ATTACH_FILES = 100;

/** Uploads that may run at once; the rest of a pick waits its turn. */
export const ATTACH_IN_FLIGHT = 3;

export type AttachmentState = "uploading" | "ready" | "error";

export type AttachmentRejection = { name: string; reason: "too-large" | "over-limit" };

export type AttachmentPicker = { taken: File[]; rejected: AttachmentRejection[] };

/**
 * Splits one pick into what is uploaded and what is refused, in the order the
 * operator picked it. A file is refused for its own size or because the pick
 * already filled the drop, and a refusal never stops the files behind it.
 */
export function pickAttachments(files: readonly File[]): AttachmentPicker {
  const taken: File[] = [];
  const rejected: AttachmentRejection[] = [];
  for (const file of files) {
    if (taken.length >= MAX_ATTACH_FILES) {
      rejected.push({ name: file.name, reason: "over-limit" });
      continue;
    }
    if (file.size > MAX_ATTACH_BYTES) {
      rejected.push({ name: file.name, reason: "too-large" });
      continue;
    }
    taken.push(file);
  }
  return { taken, rejected };
}

/** What the bar says about a pick it could not take whole. */
export function rejectionNote(rejected: readonly AttachmentRejection[]): string {
  if (rejected.length === 0) {
    return "";
  }
  const over = rejected.filter((entry) => entry.reason === "over-limit").length;
  const large = rejected.length - over;
  const parts: string[] = [];
  if (over > 0) {
    parts.push(`only the first ${MAX_ATTACH_FILES} files were taken`);
  }
  if (large > 0) {
    parts.push(`${large} ${large === 1 ? "file is" : "files are"} larger than 32 MB`);
  }
  return parts.join(" · ");
}

/** Types a browser can draw in a 68px square without a plugin. */
const PREVIEW_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"];

/** Whether a tile shows the image itself or a document chip. */
export function isPreviewable(type: string): boolean {
  return PREVIEW_TYPES.includes(type.toLowerCase());
}

/** The word under a tile. Short enough to sit in a 68px square at 11px. */
export function attachmentBadge(state: AttachmentState): string {
  return state === "uploading" ? "Uploading" : state === "ready" ? "Attached" : "Failed";
}

/** The extension a document tile shows, or FILE when there is nothing to show. */
export function attachmentLabel(name: string): string {
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1) : "";
  return extension === "" || extension.length > 4 ? "file" : extension.toUpperCase();
}

/** Bytes as the one number a tile has room for. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  const megabytes = bytes / (1024 * 1024);
  return `${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)} MB`;
}

/**
 * Takes one mention back out of the box, with the separator that was added
 * around it, so dismissing a tile leaves the sentence it was dropped into
 * exactly as it read before. Only the first occurrence goes: the same file
 * may have been mentioned twice, and the second mention is the operator's.
 */
export function dropMention(text: string, mention: string): string {
  if (mention === "") {
    return text;
  }
  const at = text.indexOf(mention);
  if (at < 0) {
    return text;
  }
  let end = at + mention.length;
  if (text[end] === " ") {
    end += 1;
  }
  const before = text.slice(0, at);
  const after = text.slice(end);
  if (before === "") {
    return after;
  }
  return before.endsWith(" ") && after.startsWith(" ") ? `${before}${after.slice(1)}` : `${before}${after}`;
}
