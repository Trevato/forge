/**
 * Whether the loopback-only look test runs, skips or fails (#10680). Outside
 * the forge's check a missing prerequisite (Chromium, `unshare`, a network
 * namespace) is a skip that says why; inside it — the check sets
 * `FORGE_CHECK` to its run id — the same gap is a failure that names it, so a
 * green check always means a picture was taken.
 */
import { findChromium } from "../src/looks/capture.ts";

export type Verdict =
  | { kind: "run" }
  | { kind: "skip"; line: string }
  | { kind: "fail"; line: string };

/** Plain data in, plain data out: what is missing, if anything, and where we are. */
export function verdict(missing: string | undefined, env: Record<string, string | undefined>): Verdict {
  if (missing === undefined) return { kind: "run" };
  const inCheck = (env["FORGE_CHECK"] ?? "") !== "";
  return inCheck
    ? { kind: "fail", line: `loopback-only look: failed in the check, ${missing}` }
    : { kind: "skip", line: `loopback-only look: skipped, ${missing}` };
}

/** What this machine lacks to take the look, or undefined when it has it all. */
export function missingPrerequisite(): string | undefined {
  if (process.platform !== "linux") return "not linux";
  if (Bun.which("unshare") === null) return "unshare is not installed";
  if (findChromium() === undefined) return "no Chromium found";
  const probe = Bun.spawnSync(["unshare", "-rn", "true"], {
    stdout: "ignore",
    stderr: "pipe",
  });
  if (probe.exitCode !== 0)
    return `cannot make a network namespace: ${probe.stderr.toString().trim().slice(0, 200)}`;
  return undefined;
}
