/**
 * A real spawn, end to end (#7959): a child forge in a real cell, from an
 * app, then `<app>--<child>--<parent>` through the real server answers with
 * the app's own body. `spawn-cell-app-hosts.test.ts` fakes the cell; this
 * does not. It runs where bwrap and socat are (as `spawn-cell.test.ts`'s
 * real child does) and says it skipped where they are not.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { portInsteadOfSocket } from "../src/git/hook-address.ts";
import { missing } from "./helpers/tools.ts";

const cellTools = process.platform === "linux" && !portInsteadOfSocket() && !missing("bwrap", "socat");

test.skipIf(!cellTools)("a child forge spawned into a cell serves its app at <app>--<child>--<parent>", async () => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "FORGE_CELLS") env[k] = v;
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "helpers", "real-spawn-e2e.ts")], { env, stdout: "pipe", stderr: "pipe" });
  const [out, errText] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const line = out.trim().split("\n").pop() ?? "";
  let seen: Record<string, unknown>;
  try {
    seen = JSON.parse(line) as Record<string, unknown>;
  } catch {
    throw new Error(`the spawn run printed no result: ${out.slice(-800)} ${errText.slice(-800)}`);
  }
  if (typeof seen["skipped"] === "string") {
    console.log(`SKIPPING: this host refuses a cell inside the test (${seen["skipped"]}), so no child was spawned into one`);
    return;
  }
  expect(seen["placement"]).toBe("cell");
  expect(seen).toMatchObject({ status: 200, app: "bakery", body: "bakery says hi" });
}, 200_000);
