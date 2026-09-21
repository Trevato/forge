/**
 * Is this tool on this machine?
 *
 * A few test files drive a real binary the forge itself never needs —
 * OpenSSH's `ssh` and `ssh-keygen`, to prove our SSH server interoperates
 * with the client people actually use. A machine without them cannot run
 * those tests, and a test that cannot run should say so and skip: failing
 * is a lie about the code, and skipping quietly is a lie about the run.
 *
 * So `missing` is a condition for `describe.skipIf`/`test.skipIf`, and it
 * prints the reason once per tool. Never skip unconditionally: on a machine
 * that has the tool, every one of these tests still runs.
 */

import { existsSync } from "node:fs";

/** A bare name is looked up on PATH; an absolute path is looked at. */
function here(tool: string): boolean {
  return tool.startsWith("/") ? existsSync(tool) : Bun.which(tool) !== null;
}

const announced = new Set<string>();

/**
 * True when any of `tools` is absent — and says which, on stdout, so the
 * skip is visible in the log and nobody reads it as a pass.
 */
export function missing(...tools: string[]): boolean {
  const absent = tools.filter((tool) => !here(tool));
  for (const tool of absent) {
    if (announced.has(tool)) continue;
    announced.add(tool);
    console.log(
      `SKIPPING: ${tool} is not installed here, so the tests that drive it cannot run on this machine`,
    );
  }
  return absent.length > 0;
}
