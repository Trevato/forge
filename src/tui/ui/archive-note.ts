/**
 * What the terminal says for a .zip, .tar or .tar.gz: how many entries it
 * holds and how big they are unpacked, read through `listArchive` and gated
 * as the page is (the kind from name and bytes, no more than the archive
 * size cap). `undefined` for any file that is not a readable-sized archive.
 */

import { count, listArchive, overSize } from "../../web/render/archive.ts";
import { fileKind, HEAD_BYTES, RENDER_CAP } from "../../web/render/kinds.ts";

const NAME = { zip: "zip", tar: "tar", "tar.gz": "tar.gz" } as const;

export function archiveNote(
  path: string,
  body: Uint8Array,
  size: number,
  /** The terminal's own size formatter, so units read as elsewhere. */
  fmt: (bytes: number) => string,
): string | undefined {
  if (fileKind(path, body.subarray(0, HEAD_BYTES)) !== "archive") return undefined;
  if (size > RENDER_CAP.archive) return `${fmt(size)} — ${overSize(RENDER_CAP.archive)}`;
  const listed = listArchive(body);
  if ("error" in listed) return listed.error;
  const n = listed.count;
  return `${NAME[listed.format]}, ${count(n)} ${n === 1 ? "entry" : "entries"}, ${fmt(listed.bytes)} unpacked.`;
}
