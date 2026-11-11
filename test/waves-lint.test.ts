import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseWave } from "../src/story/wave.ts";

const root = join(import.meta.dir, "..");
const dir = join(root, "waves");

/**
 * The records a test can open offline: every `#N` in the git history's
 * subjects and bodies (pulls land as "(#N)" or "Merge pull request #N"). Issues
 * and pulls that never left a commit are not there, so these two real pulls,
 * found on the forge, are named by hand until the forge's records are readable
 * offline (see the follow-up issue).
 */
const NOT_IN_HISTORY = [6232, 6964];
function recordedNumbers(): Set<number> | null {
  const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "ignore" });
  if (git(["rev-parse", "--is-shallow-repository"]).stdout.toString().trim() !== "false") return null;
  const log = git(["log", "--format=%s%n%b"]);
  if (log.exitCode !== 0) return null;
  const out = new Set<number>(NOT_IN_HISTORY);
  for (const m of log.stdout.toString().matchAll(/#(\d+)/g)) out.add(Number(m[1]));
  return out;
}
const records = recordedNumbers();

/** Every problem with one wave's text, each naming `file`. Pure. */
function lintWave(file: string, text: string, known: ReadonlySet<number>): string[] {
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
      if (!known.has(Number(url))) bad(`#${url} is in no record of this repository`);
    }
  }
  for (const h of w.highlights)
    for (const m of h.why.matchAll(/#(\d+)/g))
      if (!listed.has(Number(m[1]))) bad(`highlight "${h.title}" cites #${m[1]}, which the Pulls list does not link`);
  return out;
}

test.skipIf(records === null)("every wave in waves/ is a title, a milestone, a summary and links that resolve", () => {
  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  expect(files.length).toBeGreaterThan(0);
  const problems = files.flatMap((f) => lintWave(f, readFileSync(join(dir, f), "utf8"), records!));
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
