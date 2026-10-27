/** docs/VISION.md as data: what the forge is for, the order of work, and how it is built. */

export interface Vision {
  readonly purpose: string | null;
  readonly order: readonly { n: number; name: string; text: string }[];
  readonly rules: readonly string[];
}

export const NO_VISION: Vision = { purpose: null, order: [], rules: [] };

const strip = (s: string): string => s.replace(/\*\*/g, "").trim();

/** Sections by their `##` heading; the lines before the first one are the preamble. */
function sections(md: string): { preamble: string[]; byTitle: Map<string, string[]> } {
  const preamble: string[] = [];
  const byTitle = new Map<string, string[]>();
  let current = preamble;
  for (const line of md.split("\n")) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      current = [];
      byTitle.set(h[1]!.toLowerCase(), current);
    } else current.push(line);
  }
  return { preamble, byTitle };
}

export function parseVision(md: string): Vision {
  const { preamble, byTitle } = sections(md);
  const purpose = preamble.filter((l) => !/^#\s/.test(l)).join("\n").trim();
  const order: { n: number; name: string; text: string }[] = [];
  for (const line of byTitle.get("order of work") ?? []) {
    const m = /^(\d+)\.\s+\*\*(.+?)\*\*\s*(.*)$/.exec(line);
    if (m) order.push({ n: Number(m[1]), name: m[2]!.replace(/\.$/, "").trim(), text: strip(m[3]!) });
  }
  const rules = (byTitle.get("how we build") ?? [])
    .map((l) => /^-\s+(.+)$/.exec(l)?.[1])
    .filter((r): r is string => r !== undefined)
    .map(strip);
  return { purpose: purpose || null, order, rules };
}

/** What a door says when the default branch has no docs/VISION.md: one line, never an empty screen. */
export const NO_VISION_LINE = "No docs/VISION.md on the default branch: nothing says what this repository is for yet.";
