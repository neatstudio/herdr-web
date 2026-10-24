import test from "node:test";
import assert from "node:assert/strict";

import {
  ATTACH_IN_FLIGHT,
  MAX_ATTACH_BYTES,
  MAX_ATTACH_FILES,
  attachmentBadge,
  attachmentLabel,
  dropMention,
  formatBytes,
  isPreviewable,
  pickAttachments,
  rejectionNote,
} from "./attachments.ts";

function file(name: string, bytes = 4, type = "image/png"): File {
  return new File(["x".repeat(Math.min(bytes, 16))], name, { type });
}

/** A File whose reported size is what the picker must judge, not its content. */
function sized(name: string, bytes: number): File {
  const item = file(name);
  Object.defineProperty(item, "size", { value: bytes });
  return item;
}

test("a pick keeps its order and drops only what it cannot carry", () => {
  const small = sized("a.png", 10);
  const huge = sized("b.png", MAX_ATTACH_BYTES + 1);
  const last = sized("c.md", 10);
  const picked = pickAttachments([small, huge, last]);
  assert.deepEqual(picked.taken, [small, last]);
  assert.deepEqual(picked.rejected, [{ name: "b.png", reason: "too-large" }]);
});

test("a file exactly at the limit is still taken", () => {
  const picked = pickAttachments([sized("edge.png", MAX_ATTACH_BYTES)]);
  assert.equal(picked.taken.length, 1);
  assert.equal(picked.rejected.length, 0);
});

test("a pick past the drop size takes the first files and says so", () => {
  const files = Array.from({ length: MAX_ATTACH_FILES + 2 }, (_, index) => sized(`${index}.png`, 10));
  const picked = pickAttachments(files);
  assert.equal(picked.taken.length, MAX_ATTACH_FILES);
  assert.equal(picked.taken[0]?.name, "0.png");
  assert.deepEqual(picked.rejected, [
    { name: `${MAX_ATTACH_FILES}.png`, reason: "over-limit" },
    { name: `${MAX_ATTACH_FILES + 1}.png`, reason: "over-limit" },
  ]);
});

test("nothing refused is nothing to say", () => {
  assert.equal(rejectionNote([]), "");
});

test("a pick refused for both reasons says both", () => {
  const note = rejectionNote([
    { name: "a.png", reason: "too-large" },
    { name: "b.png", reason: "over-limit" },
    { name: "c.png", reason: "too-large" },
  ]);
  assert.equal(note, "only the first 100 files were taken · 2 files are larger than 32 MB");
});

test("one large file is singular", () => {
  assert.equal(rejectionNote([{ name: "a.png", reason: "too-large" }]), "1 file is larger than 32 MB");
});

test("only images a browser can draw get a thumbnail", () => {
  assert.equal(isPreviewable("image/png"), true);
  assert.equal(isPreviewable("IMAGE/JPEG"), true);
  assert.equal(isPreviewable("image/svg+xml"), true);
  assert.equal(isPreviewable("application/pdf"), false);
  assert.equal(isPreviewable("text/plain"), false);
});

test("a tile says what is happening to it", () => {
  assert.equal(attachmentBadge("uploading"), "Uploading");
  assert.equal(attachmentBadge("ready"), "Attached");
  assert.equal(attachmentBadge("error"), "Failed");
});

test("a document tile shows a short extension", () => {
  assert.equal(attachmentLabel("shot.png"), "PNG");
  assert.equal(attachmentLabel("archive.tar.gz"), "GZ");
  assert.equal(attachmentLabel("notes"), "file");
  assert.equal(attachmentLabel(".gitignore"), "file");
  assert.equal(attachmentLabel("a.verylong"), "file");
});

test("a tile has room for a size", () => {
  assert.equal(formatBytes(12), "12 B");
  assert.equal(formatBytes(2048), "2 KB");
  assert.equal(formatBytes(1.5 * 1024 * 1024), "1.5 MB");
  assert.equal(formatBytes(12 * 1024 * 1024), "12 MB");
});

test("three uploads may run at once", () => {
  assert.equal(ATTACH_IN_FLIGHT, 3);
});

test("dismissing a tile takes its mention back out of the sentence", () => {
  assert.equal(dropMention("hi @/tmp/a.png x", "@/tmp/a.png"), "hi x");
  assert.equal(dropMention("@/tmp/a.png ", "@/tmp/a.png"), "");
  assert.equal(dropMention("@/tmp/a.png hi", "@/tmp/a.png"), "hi");
  assert.equal(dropMention("@/tmp/a.png", "@/tmp/a.png"), "");
});

test("only the mention that tile put there is removed", () => {
  assert.equal(dropMention("@/tmp/a.png and @/tmp/a.png ", "@/tmp/a.png"), "and @/tmp/a.png ");
});

test("a quoted mention comes out whole", () => {
  assert.equal(dropMention('look "a b.png" now', '"a b.png"'), "look now");
});

test("a mention that is not in the box changes nothing", () => {
  assert.equal(dropMention("hello", "@/tmp/a.png"), "hello");
  assert.equal(dropMention("hello", ""), "hello");
});
