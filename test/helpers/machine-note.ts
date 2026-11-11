/**
 * What the machine was like when a heavy test failed: the free share of the
 * disk its temp directory is on and the load against the cores. A cell test
 * that times out under load or a full disk says so in its message, not as a
 * bare timeout (#10541).
 */
import { statfsSync } from "node:fs";
import { availableParallelism, loadavg, tmpdir } from "node:os";

export function machineNote(dir: string = tmpdir()): string {
  let disk = "disk unknown";
  try {
    const s = statfsSync(dir);
    disk = `disk ${Math.round((s.bavail / s.blocks) * 100)}% free under ${dir}`;
  } catch {
    // a temp directory that is gone has no figure
  }
  const [one] = loadavg();
  return `${disk}; load ${(one ?? 0).toFixed(1)} on ${availableParallelism()} cores`;
}

/** The test's whole evidence in one message: what the run printed, its stderr's tail, and the machine. */
export function failedWith(what: string, seen: unknown, errText: string): string {
  return `${what}: ${JSON.stringify(seen)}\n${machineNote()}\nstderr tail: ${errText.slice(-1500)}`;
}
