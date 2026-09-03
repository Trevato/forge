/**
 * Fuzzy matching for paths — fzf's FuzzyMatchV2 under `--scheme=path`, plus
 * VS Code's basename tiering.
 *
 * The palette's own scorer (`app/palette.ts`) is a greedy leftmost walk, which
 * is right for a list of forty command titles. A file finder is a different
 * problem: ten thousand paths, every one of them full of `/`, and the answer a
 * person expects for `srcmn` is `src/main.ts` — which greedy leftmost gets
 * wrong, because it commits to the `m` in `.../components/...` before it can
 * know a better `m` follows. So this one runs the real affine-gap DP.
 *
 * Three things make it fast enough to run on every keystroke:
 *
 * - **A bitmask prefilter.** Each candidate carries a 28-bit "characters
 *   present" mask; a candidate whose mask lacks a bit the query needs cannot
 *   contain the query as a subsequence, and one AND rejects it without
 *   touching a string. Over-approximating, which is all a prefilter needs.
 * - **A two-pointer subsequence check** on the survivors — exact, and still
 *   far cheaper than the DP.
 * - **The DP only on confirmed matches**, single-row, materialising the full
 *   matrix only for the handful of rows a person will actually look at (that
 *   is the only reason to keep one: recovering the match positions to bold).
 *
 * The constants are fzf's, read from `algo.go`, not invented here:
 * scoreMatch 16, gapStart -3, gapExtension -1, bonusBoundary 8,
 * bonusCamel123 7, bonusConsecutive 4, firstCharMultiplier 2, and — the part
 * that makes it path-shaped — `bonusBoundaryDelimiter` 9 for the character
 * after a `/`, with the start of the string treated as if it followed one.
 */

const SCORE_MATCH = 16;
const GAP_START = -3;
const GAP_EXT = -1;
const BONUS_BOUNDARY = 8;
const BONUS_NON_WORD = 8;
const BONUS_CAMEL = 7;
const BONUS_CONSECUTIVE = 4;
const FIRST_CHAR_MULT = 2;
/** Path scheme: a space is an ordinary boundary, a `/` is a strong one. */
const BONUS_BOUNDARY_WHITE = BONUS_BOUNDARY;
const BONUS_BOUNDARY_DELIM = BONUS_BOUNDARY + 1;

/**
 * VS Code's idea, kept as a tier rather than folded into the DP: *any*
 * basename match outranks *any* directory-only match, however good. Adding a
 * constant larger than any achievable path score is what enforces that, and
 * it is most of the perceived quality gap between a naive matcher and one
 * that feels right.
 */
const TIER_BASENAME = 1 << 16;

const NEG = -1 << 20;

const enum Cls {
  White = 0,
  NonWord = 1,
  Delimiter = 2,
  Lower = 3,
  Upper = 4,
  Letter = 5,
  Number = 6,
}

function classOf(ch: string): Cls {
  if (ch === " " || ch === "\t") return Cls.White;
  if (ch === "/") return Cls.Delimiter;
  const code = ch.charCodeAt(0);
  if (code >= 97 && code <= 122) return Cls.Lower;
  if (code >= 65 && code <= 90) return Cls.Upper;
  if (code >= 48 && code <= 57) return Cls.Number;
  if (code > 127) return Cls.Letter;
  return Cls.NonWord;
}

function bonusFor(prev: Cls, cur: Cls): number {
  if (cur > Cls.NonWord) {
    if (prev === Cls.White) return BONUS_BOUNDARY_WHITE;
    if (prev === Cls.Delimiter) return BONUS_BOUNDARY_DELIM;
    if (prev === Cls.NonWord) return BONUS_BOUNDARY;
  }
  if (
    (prev === Cls.Lower && cur === Cls.Upper) ||
    (prev !== Cls.Number && cur === Cls.Number)
  )
    return BONUS_CAMEL;
  if (cur === Cls.NonWord || cur === Cls.Delimiter) return BONUS_NON_WORD;
  if (cur === Cls.White) return BONUS_BOUNDARY_WHITE;
  return 0;
}

/** Bit 0-25 a-z, bit 26 any digit, bit 27 anything else. */
function maskOf(lower: string): number {
  let mask = 0;
  for (let i = 0; i < lower.length; i++) {
    const code = lower.charCodeAt(i);
    if (code >= 97 && code <= 122) mask |= 1 << (code - 97);
    else if (code >= 48 && code <= 57) mask |= 1 << 26;
    else mask |= 1 << 27;
  }
  return mask;
}

/** A candidate with everything precomputable already computed. */
export interface FuzzyItem {
  readonly text: string;
  readonly lower: string;
  readonly mask: number;
  /** Index of the first character of the basename. */
  readonly base: number;
}

export function indexOne(text: string): FuzzyItem {
  const lower = text.toLowerCase();
  return {
    text,
    lower,
    mask: maskOf(lower),
    base: text.lastIndexOf("/") + 1,
  };
}

export function indexPaths(paths: readonly string[]): FuzzyItem[] {
  return paths.map(indexOne);
}

export interface FuzzyHit {
  readonly item: FuzzyItem;
  readonly score: number;
  /** Matched character offsets into `item.text`, for bolding. */
  readonly indices: readonly number[];
}

/** True when every character of `pattern` appears in order inside `lower`. */
function isSubsequence(lower: string, pattern: string, from = 0): boolean {
  let at = from;
  for (let i = 0; i < pattern.length; i++) {
    const found = lower.indexOf(pattern[i]!, at);
    if (found === -1) return false;
    at = found + 1;
  }
  return true;
}

/**
 * Score one candidate. `indices` is only reconstructed when asked for, which
 * is what keeps the hot path a single DP row rather than an n×m matrix.
 */
export function matchPath(
  item: FuzzyItem,
  pattern: string,
  wantIndices = false,
): FuzzyHit | null {
  if (pattern === "")
    return { item, score: 0, indices: [] as readonly number[] };
  if (!isSubsequence(item.lower, pattern)) return null;

  const n = item.text.length;
  const m = pattern.length;

  // Per-position bonus, computed once: the class of the character before
  // decides it, and the start of the string counts as following a `/`.
  const bonus = new Int16Array(n);
  let prev: Cls = Cls.Delimiter;
  for (let i = 0; i < n; i++) {
    const cur = classOf(item.text[i]!);
    bonus[i] = bonusFor(prev, cur);
    prev = cur;
  }

  let row = new Int32Array(n).fill(NEG);
  let consec = new Int32Array(n);
  let prevRow = new Int32Array(n).fill(NEG);
  let prevConsec = new Int32Array(n);
  const trail = wantIndices ? new Uint8Array(n * m) : null;

  for (let j = 0; j < m; j++) {
    const pc = pattern[j]!;
    row.fill(NEG);
    consec.fill(0);
    // `left` is the cell immediately to the left in this row, and whether it
    // was itself a gap — an affine gap costs GAP_START to open and GAP_EXT to
    // continue, which is the only reason the flag is carried.
    let left = NEG;
    let leftIsGap = false;
    let best = NEG;
    for (let i = 0; i < n; i++) {
      let matched = NEG;
      let run = 0;
      if (item.lower[i] === pc) {
        const diag = j === 0 ? 0 : i === 0 ? NEG : prevRow[i - 1]!;
        if (diag > NEG) {
          run = j === 0 ? 0 : i === 0 ? 0 : prevConsec[i - 1]!;
          let b = bonus[i]!;
          if (run > 0) {
            // fzf's rule: a consecutive run keeps the bonus of the run's
            // first character when that is the stronger claim.
            b = Math.max(b, BONUS_CONSECUTIVE, bonus[i - run]!);
          }
          matched = diag + SCORE_MATCH + (j === 0 ? b * FIRST_CHAR_MULT : b);
        }
      }
      const gap = left <= NEG ? NEG : left + (leftIsGap ? GAP_EXT : GAP_START);
      if (matched > NEG && matched >= gap) {
        row[i] = matched;
        consec[i] = run + 1;
        leftIsGap = false;
        if (trail) trail[j * n + i] = 1;
      } else if (gap > NEG) {
        row[i] = gap;
        leftIsGap = true;
      } else {
        leftIsGap = false;
      }
      left = row[i]!;
      if (left > best) best = left;
    }
    if (best <= NEG) return null;
    const swapRow = prevRow;
    prevRow = row;
    row = swapRow;
    const swapConsec = prevConsec;
    prevConsec = consec;
    consec = swapConsec;
  }

  let score = NEG;
  let end = -1;
  for (let i = 0; i < n; i++)
    if (prevRow[i]! > score) {
      score = prevRow[i]!;
      end = i;
    }
  if (score <= NEG) return null;

  // The basename tier. Checked as a plain subsequence rather than rescored:
  // the tier is an ordering statement, not a measurement.
  if (item.base < n && isSubsequence(item.lower, pattern, item.base))
    score += TIER_BASENAME;

  if (!trail || end < 0) return { item, score, indices: [] };

  // Backtrack: from the winning cell, walk left taking a match whenever the
  // trail says this row matched here, then step up a pattern row.
  const indices: number[] = [];
  let i = end;
  for (let j = m - 1; j >= 0 && i >= 0; ) {
    if (trail[j * n + i] === 1) {
      indices.push(i);
      j--;
      i--;
    } else i--;
  }
  indices.reverse();
  return { item, score, indices };
}

export interface FuzzyOptions {
  /** Results returned, best first. @default 200 */
  readonly limit?: number;
  /** Reconstruct match positions for the top results. @default true */
  readonly indices?: boolean;
}

/**
 * Rank a whole index against a query. Case-insensitive throughout: a lower
 * query is a smart-case "match anything", which is what a file finder wants.
 */
export function rankPaths(
  items: readonly FuzzyItem[],
  query: string,
  o: FuzzyOptions = {},
): FuzzyHit[] {
  const limit = o.limit ?? 200;
  const pattern = query.toLowerCase().replace(/\s+/g, "");
  if (pattern === "")
    return items
      .slice(0, limit)
      .map((item) => ({ item, score: 0, indices: [] }));

  const need = maskOf(pattern);
  const hits: FuzzyHit[] = [];
  for (const item of items) {
    if ((item.mask & need) !== need) continue;
    const hit = matchPath(item, pattern, o.indices !== false);
    if (hit !== null) hits.push(hit);
  }
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      a.item.text.length - b.item.text.length ||
      (a.item.text < b.item.text ? -1 : a.item.text > b.item.text ? 1 : 0),
  );
  return hits.slice(0, limit);
}
