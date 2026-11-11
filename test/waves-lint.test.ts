import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isKnownRecord, parseRecords } from "../src/story/records.ts";
import { parseWave } from "../src/story/wave.ts";

const root = join(import.meta.dir, "..");
const dir = join(root, "waves");

/**
 * The records a test can open offline: every issue and pull number on the
 * forge, exported to test/fixtures/forge-records.txt (`bun scripts/export-records.ts`
 * refreshes it). A number above the export's highest cannot be disproved
 * offline, so it passes; only gaps below the highest are checkable.
 */
const records = parseRecords(readFileSync(join(root, "test/fixtures/forge-records.txt"), "utf8"));
const recordsMax = Math.max(...records);

/** Every problem with one wave's text, each naming `file`. Pure. */
function lintWave(file: string, text: string, known: ReadonlySet<number>, max = Math.max(...known)): string[] {
  const parsed = parseWave(file, text);
  if (!parsed.ok) return [parsed.error.message];
  const w = parsed.value;
  const out: string[] = [];
  const bad = (why: string) => out.push(`${file}: ${why}`);
  if (file !== `${w.version}.md`) bad(`milestone ${w.version} does not match the file name`);
  if (/\bTODO\b/.test(text)) bad("still has TODO placeholders");
  if (/[.!?]\s+\S/.test(w.headline)) bad("headline is more than one sentence");
  const listed = new Set<number>();
  for (const p of w.pulls) {
    const title = /^#(\d+) /.exec(p.title)?.[1];
    const url = /\/(?:pulls|issues)\/(\d+)$/.exec(p.url)?.[1];
    if (!url) bad(`link ${p.url} is not an issue or pull`);
    else if (title !== url) bad(`link text #${title ?? "?"} does not match ${p.url}`);
    else {
      listed.add(Number(url));
      if (!isKnownRecord(known, max, Number(url))) bad(`#${url} is in no record of this repository`);
    }
  }
  for (const h of w.highlights)
    for (const m of h.why.matchAll(/#(\d+)/g))
      if (!listed.has(Number(m[1]))) bad(`highlight "${h.title}" cites #${m[1]}, which the Pulls list does not link`);
  return out;
}

test("every wave in waves/ is a title, a milestone, a summary and links that resolve", () => {
  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  expect(files.length).toBeGreaterThan(0);
  const problems = files.flatMap((f) => lintWave(f, readFileSync(join(dir, f), "utf8"), records));
  expect(problems).toEqual([]);
});

const good = `---
version: 1.0.0
date: 2026-11-01
headline: One thing
---

## Highlights

- **A** — why (#1)
- **B** — why
- **C** — why

## Pulls

- [#1 T](https://f.example/o/r/pulls/1)
`;

const K = new Set([1, 2]);

test("lintWave names the file for each fault", () => {
  expect(lintWave("1.0.0.md", good, K)).toEqual([]);
  expect(lintWave("1.0.1.md", good, K)[0]).toContain("1.0.1.md: milestone 1.0.0");
  expect(lintWave("1.0.0.md", good.replace("headline: One thing\n", ""), K)[0]).toContain("1.0.0.md");
  expect(lintWave("1.0.0.md", good.replace("One thing", "One. Two"), K)[0]).toContain("one sentence");
  expect(lintWave("1.0.0.md", good.replace("(#1)", "(#9)"), K)[0]).toContain("cites #9");
  expect(lintWave("1.0.0.md", good.replace("/pulls/1", "/pulls/2"), K)[0]).toContain("does not match");
  expect(lintWave("1.0.0.md", good.replace("/pulls/1", "/x/1"), K)[0]).toContain("not an issue or pull");
});

test("a number above the export passes, a gap below it does not", () => {
  const withGap = new Set([1, 3]);
  expect(lintWave("1.0.0.md", good.replaceAll("#1", "#2").replace("/pulls/1", "/pulls/2"), withGap)[0]).toContain("in no record");
  expect(lintWave("1.0.0.md", good.replaceAll("#1", "#9").replace("/pulls/1", "/pulls/9"), withGap)).toEqual([]);
  expect(records.has(6232) && records.has(6964)).toBe(true);
  expect(recordsMax).toBeGreaterThan(11000);
});
