/**
 * Intra-line word diff: given a replaced line's old and new text, mark the
 * spans that actually changed so the viewer can underline them on top of the
 * add/delete background. A small token-level LCS — bounded so a pathological
 * minified line degrades to "whole line changed" instead of hanging.
 */

export interface Segment {
  readonly text: string;
  readonly changed: boolean;
}

export interface WordDiff {
  readonly old: Segment[];
  readonly new: Segment[];
}

// Beyond this token count the O(n·m) LCS is not worth it; mark the whole line.
export const MAX_TOKENS = 800;

function tokenize(line: string): string[] {
  return line.match(/\w+|\s+|[^\w\s]/g) ?? [];
}

/**
 * Diff two lines at word granularity. Returns per-side segments; a changed
 * segment on the old side is a deletion, on the new side an insertion.
 */
export function wordDiff(oldLine: string, newLine: string): WordDiff {
  if (oldLine === newLine) {
    return {
      old: [{ text: oldLine, changed: false }],
      new: [{ text: newLine, changed: false }],
    };
  }
  const a = tokenize(oldLine);
  const b = tokenize(newLine);
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) {
    return {
      old: [{ text: oldLine, changed: true }],
      new: [{ text: newLine, changed: true }],
    };
  }

  // Trim the common prefix and suffix first — most edits are local, and this
  // collapses the LCS table to the genuinely-differing middle.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const marks = lcsMarks(midA, midB);

  return {
    old: assemble(a, start, endA, marks.a),
    new: assemble(b, start, endB, marks.b),
  };
}

/** LCS over the differing middles; returns which middle tokens are changed. */
function lcsMarks(a: string[], b: string[]): { a: boolean[]; b: boolean[] } {
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () =>
    new Array(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] =
        a[i] === b[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const markA = new Array(n).fill(true);
  const markB = new Array(m).fill(true);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      markA[i] = false;
      markB[j] = false;
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      i++;
    } else {
      j++;
    }
  }
  return { a: markA, b: markB };
}

/** Rebuild a side's segments: unchanged prefix, marked middle, unchanged suffix,
 * coalescing runs of the same changed-ness into one segment. */
function assemble(
  tokens: string[],
  start: number,
  end: number,
  midMarks: boolean[],
): Segment[] {
  const marks = new Array(tokens.length).fill(false);
  for (let k = 0; k < midMarks.length; k++) marks[start + k] = midMarks[k];

  const segments: Segment[] = [];
  let buffer = "";
  let bufferChanged = false;
  const flush = () => {
    if (buffer !== "") segments.push({ text: buffer, changed: bufferChanged });
    buffer = "";
  };
  for (let k = 0; k < tokens.length; k++) {
    const changed = marks[k]!;
    if (buffer !== "" && changed !== bufferChanged) flush();
    bufferChanged = changed;
    buffer += tokens[k]!;
  }
  flush();
  return segments.length > 0 ? segments : [{ text: "", changed: false }];
}
