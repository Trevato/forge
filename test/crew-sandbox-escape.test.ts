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
 * Like crew-sandbox-real.test.ts this needs a sandbox of its own, so inside a
 * crew run or a container that refuses user namespaces it is skipped, naming
 * itself and the reason on the console; the forge's check runs it. Where a
 * sandbox can be made, a missing `rg` or `srt` fails the file, not skips it.
 * The `rg` is the pinned `@vscode/ripgrep` binary, handed to `srt` as its
 * `ripgrep.command`: the check host has no ripgrep on its PATH.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rgPath } from "@vscode/ripgrep";
import { claudeSettings } from "../src/crew/claude.ts";
import { sandboxAvailable, sandboxPolicy } from "../src/crew/sandbox.ts";

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
}

describe.skipIf(nestedReason !== undefined)(
  "read attempts from a real sandboxed shell, /proc unmasked",
  () => {
    let dataDir: string;
    let report: Report;
    let holder: ReturnType<typeof Bun.spawn>;

    beforeAll(async () => {
      dataDir = await mkdtemp(join(tmpdir(), "forge-escape-"));
      const work = join(dataDir, "crew/scout/01repo/1");
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

      writeFileSync(
        join(work, "probe.ts"),
        `
import { readFileSync, readdirSync } from "node:fs";
const CANARY = ${JSON.stringify(CANARY)};
const ENV = ${JSON.stringify(ENV_CANARY)};
const has = (path: string, needle: string) => {
  try { return readFileSync(path, "utf8").includes(needle); } catch { return false; }
};
const reads: Record<string, boolean> = {};
for (const [key, path] of Object.entries(${JSON.stringify(targets)} as Record<string, string>))
  reads[key] = has(path, CANARY);
let pids: string[] = [];
try { pids = readdirSync("/proc").filter((n) => /^[0-9]+$/.test(n)); } catch {}
const environLeaks = pids.filter((pid) => has("/proc/" + pid + "/environ", ENV));
console.log(JSON.stringify({
  reads,
  ownRead: has("own.txt", CANARY),
  ownEnviron: has("/proc/self/environ", "PATH="),
  pidsListed: pids.length,
  initEnviron: has("/proc/1/environ", ENV),
  environLeaks,
}));
`,
      );

      const policy = sandboxPolicy({
        dataDir,
        agentName: "scout",
        urls: [],
        runId: "01m46abcdefghjkmnpqrstvwxy",
      });
      const real = claudeSettings(policy).sandbox as Record<string, any>;
      const settings = join(dataDir, "srt-settings.json");
      writeFileSync(
        settings,
        JSON.stringify({
          ripgrep: { command: rgPath },
          network: { deniedDomains: [], ...real.network },
          filesystem: {
            denyRead: [],
            denyWrite: [],
            ...real.filesystem,
            allowWrite: [work, ...(real.filesystem?.allowWrite ?? [])],
          },
        }),
      );
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
    }, 60_000);

    afterAll(async () => {
      holder?.kill();
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
  },
);
