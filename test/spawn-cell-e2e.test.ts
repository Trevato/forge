/**
 * A real spawn, end to end (#7959): a child forge in a real cell, from an
 * app, then `<app>--<child>--<parent>` through the real server answers with
 * the app's own body. `spawn-cell-app-hosts.test.ts` fakes the cell; this
 * does not. It runs where bwrap and socat are (as `spawn-cell.test.ts`'s
 * real child does) and says it skipped where they are not.
 */
import { test } from "bun:test";
import { join } from "node:path";
import { portInsteadOfSocket } from "../src/git/hook-address.ts";
import { missing } from "./helpers/tools.ts";
import { failedWith } from "./helpers/machine-note.ts";
import { resultLine } from "./helpers/result-line.ts";

const cellTools = process.platform === "linux" && !portInsteadOfSocket() && !missing("bwrap", "socat");

test.skipIf(!cellTools)("a child forge spawned into a cell serves its app at <app>--<child>--<parent>", async () => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "FORGE_CELLS") env[k] = v;
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "helpers", "real-spawn-e2e.ts")], { env, stdout: "pipe", stderr: "pipe", timeout: 290_000 });
  const [out, errText] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const line = resultLine(out);
  let seen: Record<string, unknown>;
  try {
    seen = JSON.parse(line) as Record<string, unknown>;
  } catch {
    throw new Error(failedWith("the spawn run printed no result", out.slice(-800), errText));
  }
  if (typeof seen["skipped"] === "string") {
    console.log(`SKIPPING: this host refuses a cell inside the test (${seen["skipped"]}), so no child was spawned into one`);
    return;
  }
  // The child's own reason (its parent's "did not answer" line) and the
  // machine's disk and load are in the message, not a bare mismatch.
  const ok = seen["placement"] === "cell" && seen["status"] === 200 && seen["app"] === "bakery" && seen["body"] === "bakery says hi";
  if (!ok) throw new Error(failedWith("the child forge's app did not answer through the cell", { seen, out: out.slice(-1500) }, errText));
}, 310_000);
