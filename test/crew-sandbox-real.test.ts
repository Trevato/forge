/**
 * The boundary, held by a real sandbox: a shell started under the crew's
 * policy reaches the server it started itself, is refused a loopback port
 * outside, and reads nothing from any denyRead path. `crew-sandbox.test.ts`
 * tests the settings; this proves what they ask for. A sandbox cannot be
 * made inside a sandbox, so where one cannot be made (a crew run, a
 * container that refuses user namespaces) the test is skipped, with the
 * probe's reason named in the skip.
 *
 * Claude Code turns the policy into bubblewrap arguments itself and has no
 * entry point of its own for it; `bwrapArgs` is the same translation for the
 * three things the policy says: a network of its own (so the host's
 * loopback is not reachable), a read-only view of the machine, and each
 * denied path emptied (a directory replaced by an empty one, a file by
 * /dev/null).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxAvailable, sandboxPolicy } from "../src/crew/sandbox.ts";

const probe = await sandboxAvailable();
const nestedReason = probe.ok
  ? undefined
  : `no sandbox can be made here (nested in a crew sandbox or user namespaces refused): ${probe.reason}`;
if (nestedReason !== undefined) console.warn(`skipped: ${nestedReason}`);

const CANARY = "the-canary-must-not-be-read";

function bwrapArgs(denyRead: readonly string[], workDir: string): string[] {
  const args = [
    "--unshare-user",
    "--unshare-pid",
    "--unshare-net",
    "--die-with-parent",
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--bind",
    workDir,
    workDir,
  ];
  for (const path of denyRead) {
    if (!existsSync(path)) continue;
    if (statSync(path).isDirectory()) args.push("--tmpfs", path);
    else args.push("--ro-bind", "/dev/null", path);
  }
  return args;
}

describe.skipIf(nestedReason !== undefined)("a real sandboxed shell", () => {
  let dataDir: string;
  let work: string;
  let outside: ReturnType<typeof Bun.serve>;
  let denied: string[];
  let report: {
    own: string;
    outside: string;
    leaks: string[];
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-real-sandbox-"));
    work = join(dataDir, "crew/scout/01repo/1");
    for (const dir of ["repos/alice", "checks/01c", "crew/mason/01repo/3"])
      mkdirSync(join(dataDir, dir), { recursive: true });
    mkdirSync(work, { recursive: true });
    for (const file of [
      "forge.db",
      "secret.key",
      "repos/alice/HEAD",
      "checks/01c/a.ts",
      "crew/mason/01repo/3/notes.txt",
    ])
      writeFileSync(join(dataDir, file), CANARY);

    outside = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("outside"),
    });

    const policy = sandboxPolicy({
      dataDir,
      agentName: "scout",
      urls: [],
      runId: "01m46abcdefghjkmnpqrstvwxy",
    });
    denied = policy.denyRead.filter((p) => existsSync(p));

    writeFileSync(
      join(work, "probe.ts"),
      `
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
const own = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("own") });
const get = async (port: number) => {
  try { return await (await fetch("http://127.0.0.1:" + port + "/")).text(); }
  catch { return "refused"; }
};
const leaks: string[] = [];
const walk = (path: string) => {
  let stat;
  try { stat = statSync(path); } catch { return; }
  if (!stat.isDirectory()) {
    try { if (readFileSync(path, "utf8").includes(${JSON.stringify(CANARY)})) leaks.push(path); } catch {}
    return;
  }
  try { for (const name of readdirSync(path)) walk(path + "/" + name); } catch {}
};
for (const path of ${JSON.stringify(denied)}) walk(path);
console.log(JSON.stringify({
  own: await get(own.port),
  outside: await get(${outside.port}),
  leaks,
}));
own.stop(true);
`,
    );

    const proc = Bun.spawn(
      [
        "bwrap",
        ...bwrapArgs(policy.denyRead, work),
        "--chdir",
        work,
        "/bin/sh",
        "-c",
        `"$0" probe.ts`,
        process.execPath,
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) throw new Error(`sandboxed shell exited ${code}: ${err}`);
    report = JSON.parse(out.trim().split("\n").pop() ?? "{}");
  });
  afterAll(async () => {
    outside?.stop(true);
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the policy denies something real to try", () => {
    expect(denied.length).toBeGreaterThan(0);
    expect(denied).toContain(join(dataDir, "forge.db"));
    expect(denied).toContain(join(dataDir, "crew/mason"));
  });

  test("reaches the loopback server it started itself", () => {
    expect(report.own).toBe("own");
  });

  test("is refused a localhost port outside the sandbox", () => {
    // The same request from here succeeds: it is the sandbox that refuses.
    expect(report.outside).toBe("refused");
  });

  test("cannot read any denyRead path", () => {
    expect(report.leaks).toEqual([]);
  });
});

test("a nested run names why the real-sandbox test is skipped", () => {
  if (nestedReason === undefined) return;
  expect(nestedReason.length).toBeGreaterThan(20);
});
