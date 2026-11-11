import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProcess } from "../src/apps/process.ts";
import { isCompound, notFoundHint, shellCommand } from "../src/apps/run_command.ts";
import type { AppManifest } from "../src/apps/manifest.ts";

const manifest = (run: string): AppManifest =>
  ({ run, install: "", health: "/", ready: 8 }) as AppManifest;

const start = (dir: string, run: string, lines: string[] = []) =>
  startProcess({
    dir,
    dataDir: dir,
    manifest: manifest(run),
    env: "production",
    url: "http://app.test",
    commitOid: "0".repeat(40),
    forgeUrl: "http://forge.test",
    identityKey: "key",
    log: (l) => void lines.push(l),
    signal: new AbortController().signal,
  });

test("only a simple command is exec'ed", () => {
  // Invariant: operators are never prefixed with exec.
  for (const run of ["cd a && b", "a || b", "a; b", "a | b", "a\nb"]) {
    expect(isCompound(run)).toBe(true);
    expect(shellCommand(run)).toBe(run);
  }
  expect(shellCommand("bun server.ts")).toBe("exec bun server.ts");
});

test("exec: cd: not found names the fix", () => {
  expect(notFoundHint(["/bin/sh: 1: exec: cd: not found"])).toContain("cd sub && bun");
  expect(notFoundHint(["/bin/sh: 1: exec: nope: not found"])).toContain("not installed");
  expect(notFoundHint(["fine"])).toBeUndefined();
});

test("a compound run starts, answers, and is stopped with its whole tree", async () => {
  // Invariant: `cd sub && server` starts as written and stop() ends the server.
  const dir = await mkdtemp(join(tmpdir(), "forge-compound-"));
  try {
    await mkdir(join(dir, "sub"));
    await writeFile(
      join(dir, "sub", "server.ts"),
      "Bun.serve({port:Number(process.env.PORT),hostname:'127.0.0.1',fetch:()=>new Response('ok')})",
    );
    const started = await start(dir, "cd sub && bun server.ts");
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const { handle } = started.value;
    const res = await fetch(`http://127.0.0.1:${handle.port}/`);
    expect(await res.text()).toBe("ok");
    await handle.stop();
    await handle.exited;
    await expect(fetch(`http://127.0.0.1:${handle.port}/`)).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

test("a missing program's start failure names the fix", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-notfound-"));
  try {
    const started = await start(dir, "nonexistent-prog-xyz");
    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.error.message).toContain("not installed or not on PATH");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
