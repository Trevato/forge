/**
 * Build the SyntaxMap a diff view needs: for each file, highlight the full old
 * and new blobs (not the diff fragments — highlighting whole files is what
 * keeps multi-line strings and comments correct across hunk boundaries) and
 * key the tokens by path. The diff viewer then maps tokens onto rows by line
 * number. Blobs are immutable by oid, so this is safe to cache upstream.
 */

import type { Diff } from "../git/diff.ts";
import { blobForRender } from "../git/read.ts";
import { detectLanguage, highlightLines } from "./highlight.ts";
import {
  MAX_DIFF_FILES,
  stubFor,
  type FileTokens,
  type SyntaxMap,
} from "./diff-view.ts";

const CAP_BYTES = 1_000_000;

export async function diffSyntax(
  dir: string,
  diff: Diff,
  oldRev: string,
  newRev: string,
): Promise<SyntaxMap> {
  const map: SyntaxMap = new Map();
  // Only the files the viewer will actually render as a table are worth
  // highlighting — a stubbed file shows no hunks, so tokenising it would
  // burn the same cost the stub exists to avoid.
  for (const file of diff.files.slice(0, MAX_DIFF_FILES)) {
    if (file.binary || stubFor(file) !== null) continue;
    const entry: FileTokens = {};
    if (file.oldPath) {
      const blob = await blobForRender(dir, oldRev, file.oldPath, CAP_BYTES);
      if (blob.kind === "text") {
        entry.old = highlightLines(
          new TextDecoder().decode(blob.body),
          detectLanguage(file.oldPath),
        );
      }
    }
    if (file.newPath) {
      const blob = await blobForRender(dir, newRev, file.newPath, CAP_BYTES);
      if (blob.kind === "text") {
        entry.new = highlightLines(
          new TextDecoder().decode(blob.body),
          detectLanguage(file.newPath),
        );
      }
    }
    map.set(file.path, entry);
  }
  return map;
}
