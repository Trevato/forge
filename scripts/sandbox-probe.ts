/**
 * What a builder's shell can listen on, said in three lines. Each line binds
 * a server the way the tests that boot the forge do — a unix socket in a
 * fresh directory under the temp directory (`test/checks.test.ts`), one
 * under the working directory, and a loopback port — then connects to it
 * and reads the answer back.
 *
 *   bun scripts/sandbox-probe.ts     # exits 1 when any of them is refused
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Verdict = { name: string; ok: boolean; detail: string };

async function answer(
  listen: { unix: string } | { port: 0; hostname: "127.0.0.1" },
): Promise<string> {
  const server = Bun.serve({ ...listen, fetch: () => new Response("ok") });
  try {
    const response =
      "unix" in listen
        ? await fetch("http://probe/", { unix: listen.unix })
        : await fetch(`http://127.0.0.1:${server.port}/`);
    return await response.text();
  } finally {
    server.stop(true);
  }
}

async function unixUnder(name: string, base: string): Promise<Verdict> {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(base, "forge-probe-"));
    const text = await answer({ unix: join(dir, "probe.sock") });
    return { name, ok: text === "ok", detail: dir };
  } catch (error) {
    return { name, ok: false, detail: String(error) };
  } finally {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
}

export async function probe(): Promise<Verdict[]> {
  const verdicts = [
    await unixUnder("unix socket under $TMPDIR", tmpdir()),
    await unixUnder("unix socket under the clone", process.cwd()),
  ];
  try {
    const text = await answer({ port: 0, hostname: "127.0.0.1" });
    verdicts.push({ name: "loopback port", ok: text === "ok", detail: "127.0.0.1" });
  } catch (error) {
    verdicts.push({ name: "loopback port", ok: false, detail: String(error) });
  }
  return verdicts;
}

if (import.meta.main) {
  const verdicts = await probe();
  for (const v of verdicts)
    console.log(`${v.ok ? "ok     " : "refused"}  ${v.name}  (${v.detail})`);
  process.exit(verdicts.every((v) => v.ok) ? 0 : 1);
}
