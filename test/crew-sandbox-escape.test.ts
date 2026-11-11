/**
 * Read attempts from a crew run's real sandbox (bwrap, as Claude Code's
 * runtime makes it from the settings the crew hands it), each a test that
 * fails if the attempt works. The pod runs with `procMount: Unmasked`, so
 * /proc is whole: another process's root and environment are paths to try,
 * beside the plain ones.
 *
 * The attempts: a denied data file (`forge.db`) and another crew's file, each
 * by its path and through `/proc/self/root`, `/proc/1/root` and
 * `/proc/<pid>/root` of a process outside the sandbox; and a secret held in
 * the environment of a process outside the sandbox, looked for in every
 * `/proc/<pid>/environ` the shell can list (with `/proc/1/environ` named).
 * Two controls keep a probe that never ran from passing as "all refused": the
 * shell reads the canary from its own worktree, and reads its own environ.
 *
 * Write attempts go the same routes to the data dir and another crew's dir;
 * each is judged from outside the sandbox (the file must not exist after),
 * not by what the shell says. The control writes into its own worktree.
 *
 * Network attempts are at a server outside the sandbox on a port that is not
 * on the egress allowlist, by `127.0.0.1` and by the name `localhost`, each
 * directly as raw TCP, so no proxy setting can carry it (the sandbox has a
 * network of its own; its control is a listener the shell starts itself) and
 * through the sandbox's proxy. The control reaches the forge's host:port,
 * which is allowed, through the proxy.
 *
 * The through-proxy requests are raw requests to the proxy, not `fetch`: srt
 * puts 127.0.0.1 and localhost in NO_PROXY, which a client honours by going
 * direct (#10602). `srt` is launched without proxy variables (`withoutParentProxy`): it would
 * chain through them, and the check host's egress proxy refuses loopback.
 *
 * Like crew-sandbox-real.test.ts this needs a sandbox of its own, so inside a
 * crew run or a container that refuses user namespaces it is skipped, naming
 * itself and the reason on the console; the forge's check runs it. Where a
 * sandbox can be made, a missing `rg` or `srt` fails the file, not skips it.
 * The `rg` is the pinned `@vscode/ripgrep` binary, handed to `srt` as its
 * `ripgrep.command`: the check host has no ripgrep on its PATH.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  console.warn(`skipped: test/crew-sandbox-escape.test.ts: ${nestedReason}`);
else if (!existsSync(rgPath) || !existsSync(srt))
  throw new Error(
    "a sandbox can be made here but its runtime is missing (srt or @vscode/ripgrep's rg): run bun install",
  );

const CANARY = "the-canary-must-not-be-read";
const ENV_CANARY = "forge-redteam-environ-canary";

/** The files outside the worktree, by what they stand for. */
const FILES = {
  "a denied data file": "forge.db",
  "another crew's file": "crew/mason/01repo/3/notes.txt",
} as const;
/** The routes to each file; `<pid>` is a process outside the sandbox. */
const ROUTES = ["by its path", "/proc/self/root", "/proc/1/root", "/proc/<pid>/root"] as const;
type Route = (typeof ROUTES)[number];
/** The directories outside the worktree a write is tried in. */
const DIRS = {
  "the data dir": ".",
  "another crew's dir": "crew/mason/01repo/3",
} as const;
const WRITTEN = "escape-written.txt";
/** Hosts off the allowlist that name the outside server. */
const OFF_LIST = ["127.0.0.1", "localhost"] as const;

function routed(route: Route, path: string, pid: number): string {
  if (route === "by its path") return path;
  return `${route.replace("<pid>", String(pid))}${path}`;
}

interface Report {
  /** `label|route` → whether the canary came back. */
  reads: Record<string, boolean>;
  ownRead: boolean;
  ownEnviron: boolean;
  pidsListed: number;
  initEnviron: boolean;
  environLeaks: string[];
  /** `host|direct` (raw TCP) or `host|proxy` → what came back, or "refused: <error>". */
  net: Record<string, string>;
  /** The raw response from a listener inside the shell's own namespace. */
  ownDirect: string;
  /** `label|route` → "ok", or the error code the write was refused with. */
  writes: Record<string, string>;
  forgeViaProxy: string;
  ownWrite: string;
}

let dataDir: string;
let report: Report;
let holder: ReturnType<typeof Bun.spawn>;
let work: string;
let writes: Record<string, string>;
let forge: ReturnType<typeof Bun.serve>;
let outside: ReturnType<typeof Bun.serve>;

/**
 * Runs the probe once, at load: whether the sandbox's proxy answers at all
 * decides, before any test is declared, whether the attempts through it run.
 */
async function runEscape(): Promise<void> {
  dataDir = await mkdtemp(join(tmpdir(), "forge-escape-"));
  work = join(dataDir, "crew/scout/01repo/1");
  mkdirSync(work, { recursive: true });
  mkdirSync(join(dataDir, "crew/mason/01repo/3"), { recursive: true });
  for (const rel of Object.values(FILES)) writeFileSync(join(dataDir, rel), CANARY);
  writeFileSync(join(work, "own.txt"), CANARY);

  // A process outside the sandbox with a secret in its environment: with
  // /proc whole, the shell must still not read it, nor go through its root.
  holder = Bun.spawn(["sleep", "120"], {
    env: { ...process.env, FORGE_REDTEAM_SECRET: ENV_CANARY },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });

  const targets: Record<string, string> = {};
  for (const [label, rel] of Object.entries(FILES))
    for (const route of ROUTES)
      targets[`${label}|${route}`] = routed(route, join(dataDir, rel), holder.pid);

  writes = {};
  for (const [label, rel] of Object.entries(DIRS))
    for (const route of ROUTES)
      writes[`${label}|${route}`] = routed(
        route,
        join(dataDir, rel, `${route.replace(/\W+/g, "-")}-${WRITTEN}`),
        holder.pid,
      );

  forge = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("forge") });
  outside = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("outside") });

  writeFileSync(
    join(work, "probe.ts"),
    `
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
const CANARY = ${JSON.stringify(CANARY)};
const ENV = ${JSON.stringify(ENV_CANARY)};
const has = (path: string, needle: string) => {
  try { return readFileSync(path, "utf8").includes(needle); } catch { return false; }
};
// The network first, before the shell touches /proc.
// Through the proxy is a raw request to it too, in the absolute form a proxy
// takes, so no client's NO_PROXY handling (srt sets 127.0.0.1 and localhost
// in it) can send it direct instead: what comes back is the body, or the
// proxy's status line, or the refusal to connect.
const get = (url: string, proxy: string) =>
  new Promise<string>((resolve) => {
    const p = new URL(proxy);
    const target = new URL(url);
    const auth = p.username
      ? "proxy-authorization: Basic " +
        btoa(decodeURIComponent(p.username) + ":" + decodeURIComponent(p.password)) + "\\r\\n"
      : "";
    let bytes = "";
    const done = () => {
      const at = bytes.indexOf("\\r\\n\\r\\n");
      const status = bytes.split("\\r\\n")[0] ?? "";
      resolve(at >= 0 && / 2\\d\\d/.test(status) ? bytes.slice(at + 4) : "refused: " + (status || "no answer"));
    };
    Bun.connect({
      hostname: p.hostname,
      port: Number(p.port),
      socket: {
        open(socket) {
          socket.write("GET " + url + " HTTP/1.1\\r\\nhost: " + target.host + "\\r\\n" + auth + "connection: close\\r\\n\\r\\n");
        },
        data(_socket, chunk) { bytes += new TextDecoder().decode(chunk); },
        close() { done(); },
        error(_socket, e) { resolve("refused: " + String(e)); },
        connectError(_socket, e) { resolve("refused: connecting to the proxy: " + String(e)); },
      },
    }).catch((e: unknown) => resolve("refused: " + String(e)));
  });
// Direct is a raw TCP connection, so no proxy setting in the environment
// can carry it: what comes back is the server's bytes or the refusal.
const direct = (hostname: string, port: number) =>
  new Promise<string>((resolve) => {
    let bytes = "";
    const refused = (e: unknown) => resolve("refused: " + String(e));
    Bun.connect({
      hostname,
      port,
      socket: {
        open(socket) { socket.write("GET / HTTP/1.0\\r\\nhost: probe\\r\\n\\r\\n"); },
        data(_socket, chunk) { bytes += new TextDecoder().decode(chunk); },
        close() { resolve(bytes); },
        error(_socket, e) { refused(e); },
        connectError(_socket, e) { refused(e); },
      },
    }).catch(refused);
  });
// The direct control: a listener inside the shell's own network namespace.
const own = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("own") });
const ownDirect = await direct("127.0.0.1", own.port);
own.stop(true);
// The allowed control first: a refusal must not be what decides it.
const forgeViaProxy = process.env.HTTP_PROXY ? await get("http://127.0.0.1:${forge.port}/", process.env.HTTP_PROXY) : "no proxy in the shell";
const net: Record<string, string> = {};
for (const host of ${JSON.stringify(OFF_LIST)}) {
  const url = "http://" + host + ":" + ${outside.port} + "/";
  net[host + "|direct"] = await direct(host, ${outside.port});
  net[host + "|proxy"] = process.env.HTTP_PROXY ? await get(url, process.env.HTTP_PROXY) : "no proxy";
}
const reads: Record<string, boolean> = {};
for (const [key, path] of Object.entries(${JSON.stringify(targets)} as Record<string, string>))
  reads[key] = has(path, CANARY);
let pids: string[] = [];
try { pids = readdirSync("/proc").filter((n) => /^[0-9]+$/.test(n)); } catch {}
const environLeaks = pids.filter((pid) => has("/proc/" + pid + "/environ", ENV));
const writes: Record<string, string> = {};
for (const [key, path] of Object.entries(${JSON.stringify(writes)} as Record<string, string>)) {
  try { writeFileSync(path, CANARY); writes[key] = "ok"; }
  catch (e) { writes[key] = (e as { code?: string }).code ?? String(e); }
}
let ownWrite = "ok";
try { writeFileSync("own-written.txt", CANARY); } catch (e) { ownWrite = String(e); }
console.log(JSON.stringify({
  reads,
  ownRead: has("own.txt", CANARY),
  ownEnviron: has("/proc/self/environ", "PATH="),
  pidsListed: pids.length,
  initEnviron: has("/proc/1/environ", ENV),
  environLeaks,
  net,
  ownDirect,
  writes,
  forgeViaProxy,
  ownWrite,
}));
`,
  );

  const policy = sandboxPolicy({
    dataDir,
    agentName: "scout",
    urls: [`http://127.0.0.1:${forge.port}`],
    runId: "01m46abcdefghjkmnpqrstvwxy",
  });
  const real = claudeSettings(policy).sandbox as Record<string, any>;
  const settings = join(dataDir, "srt-settings.json");
  writeFileSync(settings, JSON.stringify(runtimeSettings(real, work)));
  const proc = Bun.spawn([srt, "--settings", settings, "-c", `'${process.execPath}' probe.ts`], {
    cwd: work,
    env: withoutParentProxy(process.env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`sandboxed shell exited ${code}: ${err}`);
  report = JSON.parse(out.trim().split("\n").pop() ?? "{}");
}

/** Why the probe did not run, when it did not: a named test fails with it. */
let probeError: string | undefined;
if (nestedReason === undefined)
  await runEscape().catch((e: unknown) => {
    probeError = e instanceof Error ? e.message : String(e);
  });

describe.skipIf(nestedReason !== undefined)(
  "read attempts from a real sandboxed shell, /proc unmasked",
  () => {
    test("the sandboxed probe ran", () => {
      expect(probeError).toBeUndefined();
    });

    afterAll(async () => {
      holder?.kill();
      forge?.stop(true);
      outside?.stop(true);
      if (dataDir !== undefined) await rm(dataDir, { recursive: true, force: true });
    });

    test("control: the shell reads its own worktree and its own environ", () => {
      expect(report.ownRead).toBe(true);
      expect(report.ownEnviron).toBe(true);
    });

    for (const label of Object.keys(FILES))
      for (const route of ROUTES)
        test(`reads nothing from ${label}, ${route}`, () => {
          expect(report.reads[`${label}|${route}`]).toBe(false);
        });

    test("reads no secret from /proc/1/environ", () => {
      expect(report.initEnviron).toBe(false);
    });

    test("reads no secret from any /proc/<pid>/environ of a process outside", () => {
      expect(report.environLeaks).toEqual([]);
    });

    test("control: the shell writes its own worktree", () => {
      expect(report.ownWrite).toBe("ok");
      expect(existsSync(join(work, "own-written.txt"))).toBe(true);
      expect(readFileSync(join(work, "own-written.txt"), "utf8")).toBe(CANARY);
    });

    test("control: the shell reaches the forge's host:port through the proxy", () => {
      expect(report.forgeViaProxy).toBe("forge");
    });

    for (const label of Object.keys(DIRS))
      for (const route of ROUTES)
        test(`writes nothing into ${label}, ${route}`, () => {
          // Judged from outside: the path resolved without /proc routes.
          const rel = DIRS[label as keyof typeof DIRS];
          const path = join(dataDir, rel, `${route.replace(/\W+/g, "-")}-${WRITTEN}`);
          // The probe tried it, and was refused with an error of its own.
          expect(report.writes[`${label}|${route}`]).toMatch(/^E[A-Z]+$/);
          expect(existsSync(path)).toBe(false);
        });

    test("control: the shell reaches a listener in its own network namespace, directly", () => {
      expect(report.ownDirect).toContain("\r\n\r\nown");
    });

    for (const host of OFF_LIST) {
      test(`cannot reach ${host}:<port off the allowlist>, directly`, () => {
        // Raw TCP from a shell whose direct control connects: refused, no bytes.
        expect(report.net[`${host}|direct`]).toStartWith("refused: ");
        expect(report.net[`${host}|direct`]).not.toContain("outside");
      });

      test(`cannot reach ${host}:<port off the allowlist>, through the proxy`, () => {
        expect(report.net[`${host}|proxy`]).not.toBe("outside");
        expect(report.net[`${host}|proxy`]).not.toBe("no proxy");
      });
    }
  },
);
