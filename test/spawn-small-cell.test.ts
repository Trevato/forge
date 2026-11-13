/**
 * Recovery of a Small child in a real cell (#11981, part of #11975). It proves
 * three things and no more: the child's cell holds the Small limits (2048 MiB,
 * 1 core), its app is served through the parent, and a child stopped as the
 * host stops one over its memory limit comes back by itself with no request,
 * from boot to recovery, answered 429 "the forge is full". The stop is
 * simulated (a recorded stop and the process tree killed), not a real memory
 * breach, and the app is a committed one-file app: building a first app,
 * passing its tests and landing a second change are not covered here.
 *
 * Runs where bwrap and socat are, else skips. Expected runtime: about a
 * minute (spawn and boot, a restart after a 1 s backoff); the 3 minute
 * ceiling is the worst case.
 */
import { test } from "bun:test";
import { join } from "node:path";
import { portInsteadOfSocket } from "../src/git/hook-address.ts";
import { missing } from "./helpers/tools.ts";
import { failedWith } from "./helpers/machine-note.ts";
import { resultLine } from "./helpers/result-line.ts";

const cellTools = process.platform === "linux" && !portInsteadOfSocket() && !missing("bwrap", "socat");

test.skipIf(!cellTools)("a Small child in a real cell holds its limits and, once stopped, comes back with no 429", async () => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "FORGE_CELLS") env[k] = v;
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "helpers", "real-spawn-e2e.ts"), "recover"], { env, stdout: "pipe", stderr: "pipe", timeout: 230_000 });
  const [out, errText] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  let seen: Record<string, unknown>;
  try {
    seen = JSON.parse(resultLine(out)) as Record<string, unknown>;
  } catch {
    throw new Error(failedWith("the recovery run printed no result", out.slice(-800), errText));
  }
  if (typeof seen["skipped"] === "string") {
    console.log(`SKIPPING: this host refuses a cell inside the test (${seen["skipped"]})`);
    return;
  }
  const limits = seen["limits"] as { memoryMiB?: number; cpus?: number } | null;
  if (seen["placement"] !== "cell" || seen["status"] !== 200 || seen["body"] !== "bakery says hi") throw new Error(failedWith("the Small child's app did not answer through the cell", { seen }, errText));
  if (limits?.memoryMiB !== 2048 || limits.cpus !== 1) throw new Error(`the child did not hold the Small limits: ${JSON.stringify(limits)}`);
  if ((seen["statuses"] as number[]).includes(429)) throw new Error(failedWith("a child was answered 429, the sentence for a full host", { seen }, errText));
  if (seen["after"] !== 200) throw new Error(failedWith("the stopped child did not come back", { seen }, errText));
}, 240_000);
