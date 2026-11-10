/**
 * Reading a day of landings as a story: titles without lane and test-file
 * jargon, and landings whose titles share a shape (the same words with one
 * slot changing) gathered into one line. Plain data in, plain data out.
 */

/** A pull's title as a reader wants it: no leading `small:` lane, no `test/…` or `src/…` path. */
export function plainTitle(title: string): string {
  let t = title.trim().replace(/^small\s*:\s*/i, "");
  // A path, with the ", with" / "and" / "in" that introduced it.
  t = t.replace(/(?:\s*,)?(?:\s+(?:with|and|in|using|via))?\s+`?(?:test|src)\/[^\s,;)`]*`?/gi, "");
  t = t.replace(/\s*[,;:]\s*$/, "").replace(/\s{2,}/g, " ").trim();
  if (t === "") return title.trim();
  // Only a plain word opens with a capital: "j/k" and "#42" are written as they are said.
  return /^\p{L}+(?:\s|$)/u.test(t) ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

/** A revert or a security fix is never folded into a line with others. */
export function standsAlone(title: string): boolean {
  return /\brevert(s|ed|ing)?\b|\bsecurity\b|\bCVE-\d|\bvulnerab|\bXSS\b|\bCSRF\b|\bSSRF\b|\binjection\b|\bexploit/i.test(title);
}

/** Longest run of words kept from the start and end; the words left between are the slot. */
const SLOT = 3;
const SHARED = 3;

function words(title: string): string[] {
  return plainTitle(title).split(/\s+/);
}

/** The words two titles share at both ends, or null when they are not the same shape. */
function shared(a: string[], b: string[]): { head: string[]; tail: string[] } | null {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const slotA = a.length - p - s;
  const slotB = b.length - p - s;
  if (slotA < 1 || slotB < 1 || slotA > SLOT || slotB > SLOT) return null;
  if (p + s < SHARED || p + s <= Math.max(slotA, slotB)) return null;
  return { head: a.slice(0, p), tail: a.slice(a.length - s) };
}

/** What gathering needs of a landing or of a pull in a release. */
export interface Titled {
  readonly title: string;
  readonly by?: string | undefined;
  readonly with?: readonly string[] | undefined;
}

export interface Gathered<T extends Titled = Titled> {
  /** The shared words with `…` for the slot, when more than one landing is gathered. */
  readonly shape: string;
  readonly landings: readonly T[];
  /** Who built them, said once: authors and credited models across the landings. */
  readonly by: readonly string[];
  readonly with: readonly string[];
}

const once = (xs: readonly (string | undefined)[]): string[] => [...new Set(xs.filter((x): x is string => x !== undefined))];

/**
 * One day's landings, in their order, as lines: each seed landing gathers the
 * later ones sharing its shape (two or more make a group, anchored where the
 * seed stood); reverts and security fixes stay single.
 */
export function gather<T extends Titled>(day: readonly T[]): Gathered<T>[] {
  const used = new Set<number>();
  // Each title read once: the pair loop below only compares the words.
  const said = day.map((l) => words(l.title));
  const alone = day.map((l) => standsAlone(l.title));
  const out: Gathered<T>[] = [];
  day.forEach((seed, i) => {
    if (used.has(i)) return;
    used.add(i);
    const members = [seed];
    let head: string[] | undefined;
    let tail: string[] = [];
    if (!alone[i]) {
      const sw = said[i]!;
      for (let j = i + 1; j < day.length; j++) {
        const other = day[j]!;
        if (used.has(j) || alone[j]) continue;
        const match = shared(sw, said[j]!);
        if (match === null) continue;
        // Later members must keep the same ends as the group so far.
        if (head !== undefined && (match.head.length < head.length || match.tail.length < tail.length)) continue;
        if (head === undefined || match.head.length < head.length || match.tail.length < tail.length) {
          head = match.head;
          tail = match.tail;
        }
        members.push(other);
        used.add(j);
      }
    }
    const shape = head === undefined ? plainTitle(seed.title) : [...head, "…", ...tail].join(" ");
    out.push({ shape, landings: members, by: once(members.map((m) => m.by)), with: once(members.flatMap((m) => m.with ?? [])) });
  });
  return out;
}
