/**
 * No spawn keeps a pipe it never reads (#2149, oven-sh/bun#18265): piped
 * stdio nobody drains leaks native memory in a long-lived Bun server. Every
 * Bun.spawn / spawnSync in src/ either ignores its unused streams or is
 * listed here with the reason it reads each pipe to its end.
 *
 * @tree-scan: reads every file under src/.
 */

import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * file → the streams each piping spawn keeps (sorted), and why they are
 * drained. Re-piping a stream that was ignored changes a site's entry.
 */
const PIPING: Record<string, { sites: string[]; reason: string }> = {
  "src/apps/backup_door.ts": { sites: ["stdout+stderr"], reason: "both read to their end alongside the exit: stdout's last line is the proof, stderr the refusal" },
  "src/apps/contain.ts": { sites: ["stderr"], reason: "stderr awaited with the exit; stdout ignored" },
  "src/apps/process.ts": { sites: ["stdout+stderr", "stdout+stderr"], reason: "pump() reads stdout and stderr of the app until exit" },
  "src/spawn/cell.ts": { sites: ["stdout+stderr"], reason: "drain() reads the child forge's stdout and stderr to its log until exit" },
  "src/chaos/faults.ts": { sites: ["stdout"], reason: "stdout is read until the kill closes it, then cancelled; stderr is ignored" },
  "src/crew/claude.ts": { sites: ["stdout+stderr", "stdout"], reason: "session pumps stdout and stderr; --version awaits stdout, stderr ignored" },
  "src/crew/plan.ts": { sites: ["stdout"], reason: "stdout awaited with the exit; stderr ignored" },
  "src/crew/runner.ts": { sites: ["stdout"], reason: "lsof stdout awaited; stderr ignored" },
  "src/crew/sandbox.ts": { sites: ["stderr"], reason: "stderr awaited with the exit; stdout ignored" },
  "src/crew/workdir.ts": { sites: ["stderr"], reason: "stderr read to its end alongside the exit; stdout ignored" },
  "src/git/env.ts": { sites: ["stdout+stderr", "stdout+stderr"], reason: "stdout and stderr both read to the end, finally clears the timer" },
  "src/git/combined.ts": { sites: ["stdout"], reason: "spawnSync buffers rev-parse stdout; stderr ignored" },
  "src/git/local.ts": { sites: ["stdout+stderr", "stdout+stderr"], reason: "stdout and stderr both read to the end" },
  "src/git/read.ts": { sites: ["stdout", "stdout", "stdout"], reason: "cat-file stdout is read by the long-lived reader, by blobStream until its window ends or the reader hangs up, and by blobHead until its bytes are in (then killed); stderr ignored" },
  "src/git/smart-http.ts": { sites: ["stdout"], reason: "stdout is a pull-pipe FIFO (the response body, read on demand); stderr ignored" },
  "src/git/smart-ssh.ts": { sites: ["stdout+stderr"], reason: "pump() drains stdout (a pull-pipe FIFO) and stderr into the channel" },
  "src/kernel/data_home.ts": { sites: ["stdout"], reason: "spawnSync buffers stdout; stderr ignored" },
  "src/looks/capture.ts": { sites: ["stderr"], reason: "stderr read in a background loop; stdout ignored" },
  "src/release/devtools.ts": { sites: ["stderr"], reason: "stderr read for the DevTools address, then drained in a background loop; stdout ignored" },
  "src/release/launch.ts": { sites: ["stderr"], reason: "hear() reads stderr to its end for the release's life, passing every chunk through to ours and keeping the tail until ready; stdout inherited" },
  "src/release/boot.ts": { sites: ["stderr"], reason: "stderr read to its end in a background loop, awaited before the reason is read; stdout ignored" },
  "src/snapshot/boot.ts": { sites: ["stderr"], reason: "stderr read to its end in a background loop, awaited before the exit is read for a lost port; stdout ignored" },
  "src/release/checkout.ts": { sites: ["stdout+stderr"], reason: "stdout and stderr both read via Response.text()" },
  "src/checks/install.ts": { sites: ["stdout+stderr"], reason: "prefillInstallCache reads stdout and stderr to the end via Response.text() while the exit is awaited" },
  "src/cli/config.ts": { sites: ["stdout"], reason: "stdout awaited with the exit; stderr ignored" },
  "src/cli/folder-repo.ts": { sites: ["stdout"], reason: "stdout awaited with the exit; stderr ignored" },
};

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? files(join(dir, e.name))
      : e.name.endsWith(".ts")
        ? [join(dir, e.name)]
        : [],
  );
}

/** The text of a call's arguments, by paren matching that skips strings. */
function args(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++;
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return src.slice(open, i);
  }
  return src.slice(open);
}

/**
 * Which streams a call keeps piped. A stream not named is taken as piped:
 * stdout and spawnSync's both default to a pipe, and for stderr that is the
 * conservative reading (Bun's own default is "inherit") so that dropping the
 * explicit "ignore" is flagged rather than trusted.
 */
function pipes(call: string): string {
  if (/\bterminal\b/.test(call)) return "";
  return ["stdout", "stderr"]
    .filter((stream) => {
      const m = new RegExp(`\\b${stream}:\\s*"(\\w+)"`).exec(call);
      return m === null || m[1] === "pipe";
    })
    .join("+");
}

test("every spawn that pipes is listed with the reason it reads the pipe", () => {
  const found: Record<string, string[]> = {};
  for (const file of files("src")) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/\bBun\.spawn(?:Sync)?\(/g)) {
      const open = m.index! + m[0].length - 1;
      const kept = pipes(args(src, open));
      if (kept !== "") (found[file] ??= []).push(kept);
    }
  }
  for (const sites of Object.values(found)) sites.sort();
  const listed = Object.fromEntries(
    Object.entries(PIPING).map(([f, v]) => [f, [...v.sites].sort()]),
  );
  expect(found).toEqual(listed);
});
