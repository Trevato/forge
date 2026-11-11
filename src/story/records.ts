/**
 * The forge's issue and pull numbers as a compact text: ranges and singletons
 * ("1-40 42 45-50"). One definition of the format, for the export script and
 * the tests that read it. Plain data in, plain data out.
 */

/** Sorted, de-duplicated numbers as ranges; singletons stay bare. */
export function compactRecords(numbers: Iterable<number>): string {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1]! === sorted[j]! + 1) j++;
    parts.push(j > i ? `${sorted[i]}-${sorted[j]}` : `${sorted[i]}`);
    i = j + 1;
  }
  return parts.join(" ");
}

/** The numbers a compact text names. Throws on anything that is not a range or number. */
export function parseRecords(text: string): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(/\s+/).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) throw new Error(`forge records: bad range "${part}"`);
    const lo = Number(m[1]);
    const hi = Number(m[2] ?? m[1]);
    if (hi < lo) throw new Error(`forge records: backwards range "${part}"`);
    for (let n = lo; n <= hi; n++) out.add(n);
  }
  return out;
}

/** Whether `n` is known: listed, or above the export's highest, which offline cannot be disproved. */
export function isKnownRecord(known: ReadonlySet<number>, max: number, n: number): boolean {
  return n > max || known.has(n);
}
