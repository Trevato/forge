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
 * naming itself and the reason on the console; the forge's check runs it.
 *
 * Outside localhost is checked twice: directly (the sandbox has a network of
 * its own, so it must fail) and through the sandbox's proxy, which is the
 * only way out. The policy allows loopback as the forge's `host:port` alone
 * (`sandboxPolicy`), so the proxy refuses every other port. Through the
 * proxy is a raw request to it, not `fetch`: srt puts 127.0.0.1 in NO_PROXY,
 * which a client honours by going direct. `srt` is launched without proxy
 * variables (`withoutParentProxy`), as the escape test is: it would chain
 * through them, and the check host's egress proxy refuses loopback (#10709).
 *
 * Where a sandbox can be made, the runtime must be there too: a missing
 * `srt` or pinned `rg` (`@vscode/ripgrep`; the check host has none on its
 * PATH) fails the test rather than skipping it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rgPath } from "@vscode/ripgrep";
import { claudeSettings } from "../src/crew/claude.ts";
import { sandboxAvailable, sandboxPolicy } from "../src/crew/sandbox.ts";
import { runtimeSettings, withoutParentProxy } from "./helpers/srt.ts";

const probe = await sandboxAvailable();
const srt = join(import.meta.dir, "../node_modules/.bin/srt");
const nestedReason = !probe.ok
  ? `no sandbox can be made here (nested in a crew sandbox or user namespaces refused): ${probe.reason}`
  : undefined;
if (nestedReason !== undefined)
  console.warn(`skipped: test/crew-sandbox-real.test.ts: ${nestedReason}`);
else if (!existsSync(rgPath) || !existsSync(srt))
  throw new Error(
    "a sandbox can be made here but its runtime is missing (srt or @vscode/ripgrep's rg): run bun install",
  );

const CANARY = "the-canary-must-not-be-read";

describe.skipIf(nestedReason !== undefined)("a real sandboxed shell", () => {
  let dataDir: string;
  let work: string;
  let outside: ReturnType<typeof Bun.serve>;
  let denied: string[];
  let forge: ReturnType<typeof Bun.serve>;
  let settings: string;
  let report: {
    own: string;
    outside: string;
    forge: string;
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

    forge = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("forge"),
    });
    outside = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("outside"),
    });

    const policy = sandboxPolicy({
      dataDir,
      agentName: "scout",
      urls: [`http://127.0.0.1:${forge.port}`],
      runId: "01m46abcdefghjkmnpqrstvwxy",
    });
    denied = policy.denyRead.filter((p) => existsSync(p));

    writeFileSync(
      join(work, "probe.ts"),
      `
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
const own = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("own") });
const direct = async (port: number) => {
  try { return await (await fetch("http://127.0.0.1:" + port + "/")).text(); }
  catch { return "refused"; }
};
// A raw request in the absolute form a proxy takes, so NO_PROXY cannot send
// it direct: the body on a 2xx, "refused" on any other answer or none.
const viaProxy = (port: number) =>
  new Promise<string>((resolve) => {
    const proxy = process.env.HTTP_PROXY;
    if (!proxy) return resolve("refused");
    const p = new URL(proxy);
    const auth = p.username
      ? "proxy-authorization: Basic " +
        btoa(decodeURIComponent(p.username) + ":" + decodeURIComponent(p.password)) + "\\r\\n"
      : "";
    let bytes = "";
    Bun.connect({
      hostname: p.hostname,
      port: Number(p.port),
      socket: {
        open(socket) {
          socket.write("GET http://127.0.0.1:" + port + "/ HTTP/1.1\\r\\nhost: 127.0.0.1:" + port + "\\r\\n" + auth + "connection: close\\r\\n\\r\\n");
        },
        data(_socket, chunk) { bytes += new TextDecoder().decode(chunk); },
        close() {
          const at = bytes.indexOf("\\r\\n\\r\\n");
          resolve(at >= 0 && / 2\\d\\d/.test(bytes.split("\\r\\n")[0] ?? "") ? bytes.slice(at + 4) : "refused");
        },
        error() { resolve("refused"); },
        connectError() { resolve("refused"); },
      },
    }).catch(() => resolve("refused"));
  });
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
  own: await direct(own.port),
  outside: await direct(${outside.port}),
  forge: await viaProxy(${forge.port}),
  viaProxy: await viaProxy(${outside.port}),
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
      {
        cwd: work,
        env: withoutParentProxy(process.env),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
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
    forge?.stop(true);
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

  test("reaches the forge's host:port through the proxy", () => {
    expect(report.forge).toBe("forge");
  });

  test("cannot reach a localhost port outside through the proxy", () => {
    expect(report.viaProxy).toBe("refused");
  });

  test("cannot read any denyRead path", () => {
    expect(report.leaks).toEqual([]);
  });
});

describe.skipIf(nestedReason !== undefined)("a real sandboxed shell's install cache", () => {
  let dataDir: string;
  let report: { wrote: boolean; read: string; other: string[] | "refused" };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-real-cache-"));
    const work = join(dataDir, "crew/scout/r1/1");
    mkdirSync(work, { recursive: true });
    mkdirSync(join(dataDir, "crew/.cache/r2/bun"), { recursive: true });
    writeFileSync(join(dataDir, "crew/.cache/r2/bun/pkg"), CANARY);
    const policy = sandboxPolicy({
      dataDir,
      agentName: "scout",
      urls: [],
      runId: "01m46abcdefghjkmnpqrstvwxy",
      repoId: "r1",
    });
    mkdirSync(policy.installCache!, { recursive: true });
    writeFileSync(
      join(work, "probe.ts"),
      `
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
const cache = ${JSON.stringify(policy.installCache)};
let wrote = false;
let read = "";
try { writeFileSync(cache + "/pkg", "cached"); wrote = true; read = readFileSync(cache + "/pkg", "utf8"); } catch {}
let other: string[] | "refused";
try { other = readdirSync(${JSON.stringify(join(dataDir, "crew/.cache/r2"))}); } catch { other = "refused"; }
console.log(JSON.stringify({ wrote, read, other }));
`,
    );
    const settings = join(dataDir, "srt-settings.json");
    const real = claudeSettings(policy).sandbox as Record<string, any>;
    writeFileSync(settings, JSON.stringify(runtimeSettings(real, work)));
    const proc = Bun.spawn(
      [srt, "--settings", settings, "-c", `'${process.execPath}' probe.ts`],
      {
        cwd: work,
        env: withoutParentProxy(process.env),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
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
    await rm(dataDir, { recursive: true, force: true });
  });

  test("writes and reads its own repository's cache", () => {
    expect(report.wrote).toBe(true);
    expect(report.read).toBe("cached");
  });

  test("cannot list another repository's cache", () => {
    expect(report.other).toBe("refused");
  });
});
