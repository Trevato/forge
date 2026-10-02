/**
 * A model can echo a granted value into a file and commit it. Before the
 * forge commits or pushes for an agent, the clone is read for the values
 * the run held: files in the tree are scrubbed in place, and commits the
 * agent already made are searched, because history cannot be scrubbed
 * quietly — a branch that holds a value is not pushed.
 */

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runGit, runGitCapture } from "../git/env.ts";
import { formsOf, redactValues } from "../kernel/log.ts";

const MAX_FILE = 2 * 1024 * 1024;

/** Rewrite working-tree files that hold a value; returns their paths. */
export async function scrubTree(
  dir: string,
  values: readonly string[],
  env: Record<string, string>,
): Promise<string[]> {
  const forms = [...new Set(values.flatMap(formsOf))];
  if (forms.length === 0) return [];
  const listed = await runGit(
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: dir, env },
  );
  if (!listed.ok) return [];
  const touched: string[] = [];
  for (const rel of listed.value.split("\0")) {
    if (rel === "") continue;
    const path = join(dir, rel);
    try {
      const st = statSync(path);
      if (!st.isFile() || st.size > MAX_FILE) continue;
      const text = readFileSync(path, "utf8");
      const clean = redactValues(text, forms);
      if (clean === text) continue;
      writeFileSync(path, clean);
      touched.push(rel);
    } catch {
      // Unreadable or vanished: nothing to scrub.
    }
  }
  return touched;
}

/** Whether any commit in `range` carries a value in its patch or message. */
export async function historyHolds(
  dir: string,
  range: string,
  values: readonly string[],
  env: Record<string, string>,
): Promise<boolean> {
  const forms = [...new Set(values.flatMap(formsOf))];
  if (forms.length === 0) return false;
  const out = await runGitCapture(["log", "-p", "--no-color", range], {
    cwd: dir,
    env,
  });
  return forms.some((f) => out.stdout.includes(f));
}
