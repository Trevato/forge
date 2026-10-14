/**
 * The boundary, held by a real sandbox: a shell started under the settings
 * the crew hands Claude Code (`claudeSettings(sandboxPolicy(...))`) reaches
 * the server it started itself, reads nothing from any denyRead path, and
 * reaches a loopback port outside only as far as the policy's allowHosts say.
 * The settings go through Claude Code's own sandbox runtime
 * (`@anthropic-ai/sandbox-runtime`, the `srt` command), which reads this
 * shape, so dropping `filesystem.denyRead` or flipping `enabled` fails here.
 * A sandbox cannot be made inside a sandbox, so where one cannot be made (a
 * crew run, a container that refuses user namespaces) the test is skipped,
 * with the reason on the console.
 *
 * Outside localhost is checked twice: directly (the sandbox has a network of
 * its own, so it must fail) and through the sandbox's proxy, which is the
 * only way out. The proxy dials 127.0.0.1 for a shell because `allowHosts`
 * lists it; the test ties the result to that list rather than asserting a
 * refusal the policy does not make.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeSettings } from "../src/crew/claude.ts";
import { sandboxAvailable, sandboxPolicy } from "../src/crew/sandbox.ts";

const probe = await sandboxAvailable();
const srt = join(import.meta.dir, "../node_modules/.bin/srt");
const nestedReason = !probe.ok
  ? `no sandbox can be made here (nested in a crew sandbox or user namespaces refused): ${probe.reason}`
  : Bun.which("rg") === null
    ? "the sandbox runtime needs ripgrep (rg) and it is not installed"
    : !existsSync(srt)
      ? "the sandbox runtime is not installed (bun install)"
      : undefined;
if (nestedReason !== undefined) console.warn(`skipped: ${nestedReason}`);

const CANARY = "the-canary-must-not-be-read";

/** Claude Code's sandbox settings as the runtime reads them. */
function runtimeSettings(
  sandbox: Record<string, any>,
  workDir: string,
): Record<string, unknown> {
  return {
    network: { deniedDomains: [], ...sandbox.network },
    filesystem: {
      denyRead: [],
      denyWrite: [],
      ...sandbox.filesystem,
      allowWrite: [workDir],
    },
  };
}

describe.skipIf(nestedReason !== undefined)("a real sandboxed shell", () => {
  let dataDir: string;
  let work: string;
  let outside: ReturnType<typeof Bun.serve>;
  let denied: string[];
  let allowHosts: readonly string[];
  let settings: string;
  let report: {
    own: string;
    outside: string;
    viaProxy: string;
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
    allowHosts = policy.allowHosts;
    denied = policy.denyRead.filter((p) => existsSync(p));

    writeFileSync(
      join(work, "probe.ts"),
      `
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
const own = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("own") });
const get = async (port: number, proxy?: string) => {
  try { return await (await fetch("http://127.0.0.1:" + port + "/", { proxy })).text(); }
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
  viaProxy: await get(${outside.port}, process.env.HTTP_PROXY),
  leaks,
}));
own.stop(true);
`,
    );

    settings = join(dataDir, "srt-settings.json");
    const real = claudeSettings(policy).sandbox as Record<string, any>;
    expect(real.enabled).toBe(true);
    writeFileSync(settings, JSON.stringify(runtimeSettings(real, work)));
    const proc = Bun.spawn(
      [srt, "--settings", settings, "-c", `'${process.execPath}' probe.ts`],
      { cwd: work, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
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

  test("cannot reach a localhost port outside directly", () => {
    // The same request from here succeeds: it is the sandbox that refuses.
    expect(report.outside).toBe("refused");
  });

  test("reaches a localhost port outside through the proxy only as allowHosts says", () => {
    // allowHosts always lists 127.0.0.1 (the agent reaches the forge there),
    // so the proxy dials any loopback port; if that list is narrowed this
    // flips to "refused" and the test says so.
    const allowed = allowHosts.includes("127.0.0.1");
    expect(report.viaProxy).toBe(allowed ? "outside" : "refused");
  });

  test("cannot read any denyRead path", () => {
    expect(report.leaks).toEqual([]);
  });
});
