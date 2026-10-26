/**
 * Build the SyntaxMap a diff view needs: for each file, highlight the full old
 * and new blobs (not the diff fragments — highlighting whole files is what
 * keeps multi-line strings and comments correct across hunk boundaries) and
 * key the tokens by path. The diff viewer then maps tokens onto rows by line
 * number. Blobs are immutable by oid, so this is safe to cache upstream.
 */

import type { Diff } from "../git/diff.ts";
import { blobForRender } from "../git/read.ts";
import {
  INITIAL_SCAN,
  detectLanguage,
  highlightLines,
  scanOneLine,
  type ScanState,
  type Token,
} from "./highlight.ts";
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

/**
 * The SyntaxMap for just the lines a diff draws: each hunk's old side
 * (context and deletions) and new side (context and additions) is tokenised
 * from the diff itself, in order, and placed at its line numbers in a sparse
 * array. No blob is read and nothing outside a hunk is scanned, so the cost
 * follows the size of the change rather than of the files.
 *
 * The trade: a string or comment opened above a hunk starts the hunk in the
 * plain state, so its first lines may colour differently from a whole-file
 * pass. `diffSyntax` keeps that exactness for the pull page.
 */
export function hunkSyntax(diff: Diff): SyntaxMap {
  const map: SyntaxMap = new Map();
  for (const file of diff.files.slice(0, MAX_DIFF_FILES)) {
    if (file.binary || stubFor(file) !== null) continue;
    const entry: FileTokens = {};
    const oldLang = file.oldPath ? detectLanguage(file.oldPath) : null;
    const newLang = file.newPath ? detectLanguage(file.newPath) : null;
    for (const hunk of file.hunks) {
      let oldState = INITIAL_SCAN;
      let newState = INITIAL_SCAN;
      for (const line of hunk.lines) {
        let oldTokens: Token[] | undefined;
        let newTokens: Token[] | undefined;
        // A context line both sides scan from the plain state, in one
        // language, tokenises the same on both: scan it once.
        const shared =
          line.kind === "context" &&
          oldLang === newLang &&
          isPlain(oldState) &&
          isPlain(newState);
        if (line.oldNumber !== null && oldLang) {
          const scanned = scanOneLine(line.content, oldLang, oldState);
          oldTokens = scanned.tokens;
          oldState = scanned.state;
          if (shared) newTokens = oldTokens;
        }
        if (line.newNumber !== null && newLang) {
          if (newTokens) {
            newState = oldState;
          } else {
            const scanned = scanOneLine(line.content, newLang, newState);
            newTokens = scanned.tokens;
            newState = scanned.state;
          }
        }
        if (oldTokens) (entry.old ??= [])[line.oldNumber! - 1] = oldTokens;
        if (newTokens) (entry.new ??= [])[line.newNumber! - 1] = newTokens;
      }
    }
    map.set(file.path, entry);
  }
  return map;
}

function isPlain(s: ScanState): boolean {
  return (
    !s.block && !s.str && !s.heredoc && !s.embed && !s.scalar && !s.tag && s.depth === 0
  );
}
