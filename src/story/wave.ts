/**
 * A wave is a file: `waves/<version>.md`. Front matter (version, date,
 * headline), three to five highlights each with its why, then every merged
 * pull as a link. Pure: text in, plain data out, and back. No I/O here.
 *
 *   ---
 *   version: 0.7.81
 *   date: 2026-10-15
 *   headline: One line
 *   ---
 *
 *   ## Highlights
 *
 *   - **Title** — why it matters
 *
 *   ## Pulls
 *
 *   - [#12 Title](https://forge.example/trevato/forge/pulls/12)
 */

export interface Highlight {
  title: string;
  why: string;
}
export interface WavePull {
  title: string;
  url: string;
}
export interface Wave {
  version: string;
  date: string;
  headline: string;
  highlights: Highlight[];
  pulls: WavePull[];
}
export type WaveResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: Error };

export const MIN_HIGHLIGHTS = 3;
export const MAX_HIGHLIGHTS = 5;

/** The shape of a wave's version, and of its file name before `.md`. */
export const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SEP = " — ";

const fail = (path: string, why: string): { ok: false; error: Error } => ({
  ok: false,
  error: new Error(`${path}: ${why}`),
});

const realDate = (s: string): boolean => {
  const m = DATE.exec(s);
  if (!m) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

const oneLine = (s: unknown): s is string =>
  typeof s === "string" && s.trim() !== "" && !/[\r\n]/.test(s) && s === s.trim();

const safeUrl = (s: string): boolean => {
  try {
    const u = new URL(s);
    return (u.protocol === "https:" || u.protocol === "http:") && !/[()\s]/.test(s);
  } catch {
    return false;
  }
};

/** Check a wave's shape; the reason names `path`. */
export function checkWave(path: string, w: Wave): WaveResult<Wave> {
  if (!oneLine(w.version)) return fail(path, "missing version");
  if (!VERSION.test(w.version)) return fail(path, `bad version "${w.version}"`);
  if (!oneLine(w.date)) return fail(path, "missing date");
  if (!realDate(w.date)) return fail(path, `bad date "${w.date}", want YYYY-MM-DD`);
  if (!oneLine(w.headline)) return fail(path, "missing headline");
  const hs = w.highlights;
  if (!Array.isArray(hs) || hs.length === 0) return fail(path, "no highlights");
  if (hs.length < MIN_HIGHLIGHTS)
    return fail(path, `too few highlights: ${hs.length}, want ${MIN_HIGHLIGHTS} to ${MAX_HIGHLIGHTS}`);
  if (hs.length > MAX_HIGHLIGHTS)
    return fail(path, `too many highlights: ${hs.length}, want ${MIN_HIGHLIGHTS} to ${MAX_HIGHLIGHTS}`);
  for (const [i, h] of hs.entries()) {
    if (!oneLine(h?.title) || h.title.includes(SEP))
      return fail(path, `highlight ${i + 1} has no usable title`);
    if (!oneLine(h.why)) return fail(path, `highlight ${i + 1} has no why`);
  }
  if (!Array.isArray(w.pulls)) return fail(path, "no pulls list");
  for (const [i, p] of w.pulls.entries()) {
    if (!oneLine(p?.title) || /[\[\]]/.test(p.title))
      return fail(path, `pull ${i + 1} has no usable title`);
    if (typeof p.url !== "string" || !safeUrl(p.url))
      return fail(path, `pull ${i + 1} has a bad link`);
  }
  return { ok: true, value: w };
}

/** Parse the text of `path` into a wave, or say what is wrong with the file. */
export function parseWave(path: string, text: string): WaveResult<Wave> {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") return fail(path, "missing front matter");
  const end = lines.indexOf("---", 1);
  if (end < 0) return fail(path, "front matter is not closed");
  const front: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    if (line.trim() === "") continue;
    const m = /^(version|date|headline):[ \t]*(.*)$/.exec(line);
    if (!m) return fail(path, `unknown front matter line "${line}"`);
    front[m[1]!] = m[2]!.trim();
  }
  const highlights: Highlight[] = [];
  const pulls: WavePull[] = [];
  let section = "";
  for (const raw of lines.slice(end + 1)) {
    const line = raw.trimEnd();
    if (line === "") continue;
    if (line.startsWith("## ")) {
      section = line.slice(3).trim();
      if (section !== "Highlights" && section !== "Pulls")
        return fail(path, `unknown section "${section}"`);
      continue;
    }
    if (section === "Highlights") {
      const m = /^- \*\*(.+?)\*\* —(?: (.*))?$/.exec(line);
      if (!m) return fail(path, `bad highlight line "${line}"`);
      highlights.push({ title: m[1]!, why: (m[2] ?? "").trim() });
    } else if (section === "Pulls") {
      const m = /^- \[([^\]]+)\]\(([^()\s]+)\)$/.exec(line);
      if (!m) return fail(path, `bad pull line "${line}"`);
      pulls.push({ title: m[1]!, url: m[2]! });
    } else return fail(path, `text outside a section "${line}"`);
  }
  return checkWave(path, {
    version: front.version ?? "",
    date: front.date ?? "",
    headline: front.headline ?? "",
    highlights,
    pulls,
  });
}

/** The file name a wave lives at. */
export const wavePath = (version: string): string => `waves/${version}.md`;

/** Render a wave as the text of its file, or refuse a malformed one. */
export function writeWave(w: Wave): WaveResult<string> {
  const checked = checkWave(wavePath(String(w?.version ?? "")), w);
  if (!checked.ok) return checked;
  const out = [
    "---",
    `version: ${w.version}`,
    `date: ${w.date}`,
    `headline: ${w.headline}`,
    "---",
    "",
    "## Highlights",
    "",
    ...w.highlights.map((h) => `- **${h.title}**${SEP}${h.why}`),
    "",
    "## Pulls",
    "",
    ...w.pulls.map((p) => `- [${p.title}](${p.url})`),
    "",
  ];
  return { ok: true, value: out.join("\n") };
}
