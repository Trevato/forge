/**
 * A deterministic stand-in for the model that builds on the template
 * (#11999). It speaks stream-json as Claude Code does, but what it does is
 * fixed: given a prompt carrying `READING-V1` it adds a `/reading` route and
 * a test of it to the app the template made; given `READING-V2` it changes
 * what that route says and its test. Then it runs the app's own `bun test`
 * in the clone, and only commits and pushes when that passes; a red test
 * ends the run as a failure, as a model that cannot make its tests pass
 * would. No network, no login, no cost, the same bytes every time.
 *
 * It is the model's place in `build-journey.test.ts`.
 */

import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** What `/reading` says after the first change and after the second. */
export const READING_V1 = "reading list: one book";
export const READING_V2 = "reading list: two books";

/** The route the first change inserts, before the template's health route. */
export const ANCHOR = "  // Up or not, for the forge and for anyone watching";

export const routeFor = (say: string): string =>
  `  { method: "GET", path: "/reading", handle: () => text(${JSON.stringify(say)}) },\n\n`;

export const testFor = (say: string): string => `import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "./server.ts";

const dataDir = mkdtempSync(join(tmpdir(), "reading-"));
const server = serve({ port: 0, dataDir, identityKey: "a-key-only-the-forge-holds" });
afterAll(() => {
  server.stop(true);
  rmSync(dataDir, { recursive: true, force: true });
});

test("/reading says the reading list", async () => {
  const res = await fetch(\`http://\${server.hostname}:\${server.port}/reading\`);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe(${JSON.stringify(say)});
});
`;

export interface BuildStandIn {
  /** The binary to hand `startCrew` (or `FORGE_CLAUDE`). */
  readonly fake: string;
}

/** Write the stand-in into `dir`: a shell script that reads the prompt and runs the builder. */
export function writeBuildStandIn(dir: string): BuildStandIn {
  const builder = join(import.meta.dir, "build-standin-builder.ts");
  const promptFile = join(dir, "build-standin.prompt");
  const fake = join(dir, "build-claude");
  writeFileSync(
    fake,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (build stand-in)"; exit 0; fi
IFS= read -r first; printf '%s\\n' "$first" > "${promptFile}"
echo '{"type":"system","subtype":"init","session_id":"build-1","model":"stand-in"}'
exec ${JSON.stringify(process.execPath)} "${builder}" "${promptFile}"
`,
  );
  chmodSync(fake, 0o755);
  return { fake };
}
