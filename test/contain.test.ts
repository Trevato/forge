/**
 * Repository code runs in a cell (`apps/contain.ts`): an app, its preview
 * and a check, on a fresh account's repository, each try to read the forge's
 * data, the forge's environment and another tenant's app, and to reach a
 * host nobody declared — and each is refused, while the forge itself still
 * answers. Over a memory, CPU or disk limit a step is stopped, and the
 * reason is the step's error.
 *
 * The cell needs bubblewrap and user namespaces; where the host has none
 * (macOS), the end-to-end half skips and says so.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { enableApp } from "../src/actions/apps.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { cellsAvailable, WATCH, type CellSpec } from "../src/apps/contain.ts";
import { envDir } from "../src/apps/data.ts";
import { hostAllowed, isPublicAddress } from "../src/apps/egress.ts";
import { parseCheck, parseManifest } from "../src/apps/manifest.ts";
import { childEnv, runStep } from "../src/apps/process.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { startChecks, type ChecksHandle } from "../src/checks/service.ts";
import { listRuns, type Run } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import type { AppRecord } from "../src/core/apps.ts";
import type { Repo } from "../src/core/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { readRunLog } from "../src/runs/log.ts";
import { missing } from "./helpers/tools.ts";

describe("egress: what a cell may reach", () => {
  test("a declared name matches exactly, or below a *. wildcard", () => {
    expect(hostAllowed(["api.example.com"], "api.example.com")).toBe(true);
    expect(hostAllowed(["api.example.com"], "API.example.com.")).toBe(true);
    expect(hostAllowed(["api.example.com"], "example.com")).toBe(false);
    expect(hostAllowed(["api.example.com"], "evilapi.example.com")).toBe(false);
    expect(hostAllowed(["*.example.com"], "a.b.example.com")).toBe(true);
    expect(hostAllowed(["*.example.com"], "example.com")).toBe(false);
    expect(hostAllowed(["*.example.com"], "badexample.com")).toBe(false);
    expect(hostAllowed([], "registry.npmjs.org")).toBe(false);
  });

  test("private, loopback, link-local and cluster addresses are never public", () => {
    for (const ip of [
      "127.0.0.1",
      "10.42.0.13",
      "10.43.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.1.1",
      "100.100.161.11",
      "0.0.0.0",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "::ffff:169.254.169.254",
    ])
      expect(isPublicAddress(ip)).toBe(false);
    for (const ip of ["104.16.1.1", "8.8.8.8", "2606:4700::1111"])
      expect(isPublicAddress(ip)).toBe(true);
  });

  test("forge.json declares egress once, for the app and the check, and limits per section", () => {
    const json = JSON.stringify({
      egress: ["api.example.com", "*.cdn.example.com"],
      app: { run: "bun server.ts", limits: { memory: 768, cpus: 1.5 } },
      check: { run: "bun test", limits: { disk: 2048 } },
    });
    const app = parseManifest(json, undefined);
    const check = parseCheck(json, undefined);
    expect(app.ok && app.value.egress).toEqual([
      "api.example.com",
      "*.cdn.example.com",
    ]);
    expect(app.ok && app.value.limits).toEqual({ memoryMiB: 768, cpus: 1.5 });
    expect(check.ok && check.value?.egress).toEqual([
      "api.example.com",
      "*.cdn.example.com",
    ]);
    expect(check.ok && check.value?.limits).toEqual({ diskMiB: 2048 });
  });

  test("a wrong egress or limit is a manifest error, never a guess", () => {
    for (const bad of [
      { egress: "api.example.com" },
      { egress: ["http://api.example.com"] },
      { egress: ["api.example.com/path"] },
      { egress: ["api example.com"] },
      { egress: Array.from({ length: 33 }, (_, i) => `h${i}.example.com`) },
    ]) {
      const result = parseManifest(
        JSON.stringify({ ...bad, app: { run: "x" } }),
        undefined,
      );
      expect(result.ok).toBe(false);
    }
    for (const limits of [
      { memory: 1 },
      { cpus: 0 },
      { disk: "1G" },
      { swap: 1 },
      [],
    ]) {
      const result = parseCheck(
        JSON.stringify({ check: { run: "x", limits } }),
        undefined,
      );
      expect(result.ok).toBe(false);
    }
  });
});

const noCells = missing("bwrap", "socat") || process.platform !== "linux";

/** What the probe tries, from inside a deploy or a check. */
function probeSource(targets: {
  dataDir: string;
  otherAppDir: string;
  canary: string;
  listenerPort: number;
}): string {
  return `
import { readdirSync, readFileSync } from "node:fs";
const T = ${JSON.stringify(targets)};
const reached = (detail) => "reached: " + String(detail).slice(0, 80);
async function attempt(fn) {
  try {
    const found = await fn();
    return found === false ? "refused" : reached(found);
  } catch {
    return "refused";
  }
}
const answered = async (url, init) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
  await res.body?.cancel();
  return res.ok ? res.status : false;
};
async function probe() {
  return {
    forgeDb: await attempt(() => readFileSync(T.dataDir + "/forge.db").length),
    secretKey: await attempt(() => readFileSync(T.dataDir + "/secret.key").length),
    forgeData: await attempt(() => {
      const names = readdirSync(T.dataDir);
      return names.some((n) => n === "forge.db" || n === "secret.key" || n === "repos") && names.join(",");
    }),
    otherApp: await attempt(() => readdirSync(T.otherAppDir).join(",")),
    environment: await attempt(() => {
      if (Object.values(process.env).some((v) => v?.includes(T.canary))) return "own env";
      for (const pid of readdirSync("/proc")) {
        if (!/^\\d+$/.test(pid)) continue;
        try {
          if (readFileSync("/proc/" + pid + "/environ", "latin1").includes(T.canary)) return "pid " + pid;
        } catch {}
      }
      return false;
    }),
    undeclaredHost: await attempt(() => answered("http://example.com/")),
    cluster: await attempt(() => answered("http://127.0.0.1:" + T.listenerPort + "/")),
    declaredButPrivate: await attempt(() =>
      answered("http://localhost:" + T.listenerPort + "/", { proxy: process.env.HTTP_PROXY ?? undefined }),
    ),
    forge: await attempt(() => answered(process.env.FORGE_URL + "/healthz")),
  };
}
if (process.argv[2] === "check") {
  console.log("PROBE " + JSON.stringify(await probe()));
} else {
  Bun.serve({
    port: Number(process.env.PORT),
    hostname: "127.0.0.1",
    fetch: async (req) =>
      new URL(req.url).pathname === "/probe" ? Response.json(await probe()) : new Response("ok"),
  });
}
`;
}

/** Everything refused, and the forge — the one declared way out — answering. */
function expectContained(results: Record<string, string>): void {
  const { forge, ...rest } = results;
  for (const [name, outcome] of Object.entries(rest))
    expect(`${name}: ${outcome}`).toBe(`${name}: refused`);
  expect(forge).toStartWith("reached");
}

describe.skipIf(noCells)(
  "cells: repository code cannot take over the forge",
  () => {
    const DOMAIN = "cells.test";
    const CANARY = `forge-canary-${crypto.randomUUID()}`;
    let dataDir: string;
    let app: App;
    let servers: Servers;
    let runtime: AppsRuntime;
    let checks: ChecksHandle;
    let alice: User;
    let mallory: User;
    let listener: ReturnType<typeof Bun.serve>;
    let other: AppRecord;
    let repo: Repo;
    let record: AppRecord;

    async function settled(
      kind: "deploy" | "check",
      where: (run: Run) => boolean,
      timeoutMs = 90_000,
    ): Promise<Run> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const run = listRuns(app.db, repo.id, { kind, limit: 50 }).find(where);
        if (
          run &&
          (run.state === "ok" ||
            run.state === "failed" ||
            run.state === "cancelled")
        )
          return run;
        await Bun.sleep(100);
      }
      throw new Error(`${kind} did not settle in time`);
    }

    const viaHost = async (url: string, path: string): Promise<Response> =>
      fetch(`${servers.url}${path}`, { headers: { host: new URL(url).host } });

    beforeAll(async () => {
      // The forge's own environment carries this; no cell may ever see it.
      process.env["FORGE_TEST_CANARY"] = CANARY;
      dataDir = await mkdtemp(join(tmpdir(), "forge-cells-"));
      app = createApp({ dataDir, port: 0 });
      servers = await serve(app);
      runtime = new AppsRuntime(app, {
        domain: DOMAIN,
        scheme: "http",
        publicPort: servers.port,
        forgeUrl: servers.url,
        concurrency: 2,
      });
      await runtime.start();
      checks = startChecks(app, { forgeUrl: servers.url, concurrency: 1 });
      // A stand-in for the cluster API or another pod: reachable from the forge.
      listener = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: () => new Response("inside"),
      });

      const a = await createUser(app.db, {
        username: "alice",
        email: "alice@forge.local",
        password: "a-good-passphrase",
        adminIfFirst: true,
      });
      if (!a.ok) throw new Error(a.error);
      alice = a.value;
      const m = await createUser(app.db, {
        username: "mallory",
        email: "mallory@forge.local",
        password: "a-good-passphrase",
      });
      if (!m.ok) throw new Error(m.error);
      mallory = m.value;

      // Another tenant's app, running, with data of its own.
      const theirs = await createRepo(app, alice, {
        name: "ledger",
        visibility: "private",
      });
      if (!theirs.ok) throw new Error(String(theirs.error));
      const seeded = await commitToBranch(app, alice, theirs.value, {
        message: "Start",
        files: [
          {
            path: "package.json",
            content:
              '{"name":"ledger","scripts":{"start":"bun run server.ts"}}\n',
          },
          {
            path: "server.ts",
            content:
              "await Bun.write(process.env.FORGE_APP_DATA + '/books.txt', 'private');\nBun.serve({ port: Number(process.env.PORT), hostname: '127.0.0.1', fetch: () => new Response('ok') });\n",
          },
        ],
      });
      if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
      const enabled = enableApp(app, alice, theirs.value, { slug: "ledger" });
      if (!enabled.ok) throw new Error(String(enabled.error));
      other = enabled.value;
    }, 60_000);

    afterAll(async () => {
      delete process.env["FORGE_TEST_CANARY"];
      await checks?.stop();
      await runtime?.stop();
      listener?.stop(true);
      servers?.stop();
      app?.close();
      await rm(dataDir, { recursive: true, force: true });
    });

    test("this host can hold a cell", async () => {
      expect(await cellsAvailable()).toEqual({ ok: true });
    });

    test("an app, its preview and its check, on a fresh account, are each refused everything but the forge", async () => {
      const made = await createRepo(app, mallory, {
        name: "probe",
        visibility: "public",
      });
      if (!made.ok) throw new Error(String(made.error));
      repo = made.value;
      const source = probeSource({
        dataDir,
        otherAppDir: envDir(dataDir, other.id, "production"),
        canary: CANARY,
        listenerPort: listener.port ?? 0,
      });
      const forgeJson = JSON.stringify({
        // Declared, but it is this machine: still refused.
        egress: ["localhost"],
        app: { run: "bun probe.ts serve", health: "/" },
        check: { run: "bun probe.ts check", timeout: 120 },
      });
      const committed = await commitToBranch(app, mallory, repo, {
        message: "A probe",
        files: [
          { path: "forge.json", content: forgeJson },
          { path: "probe.ts", content: source },
        ],
      });
      if (!committed.ok) throw new Error(JSON.stringify(committed.error));
      const enabled = enableApp(app, mallory, repo, { slug: "probe" });
      if (!enabled.ok) throw new Error(String(enabled.error));
      record = enabled.value;

      // The other tenant is up and has written its data: there is something to steal.
      await Bun.sleep(100);
      const deadline = Date.now() + 60_000;
      while (
        !existsSync(
          join(envDir(dataDir, other.id, "production"), "data", "books.txt"),
        ) &&
        Date.now() < deadline
      )
        await Bun.sleep(100);
      expect(existsSync(join(dataDir, "forge.db"))).toBe(true);
      expect(existsSync(join(dataDir, "secret.key"))).toBe(true);

      const production = await settled(
        "deploy",
        (r) =>
          r.env === "production" && r.commitOid === committed.value.commitOid,
      );
      expect(production.state).toBe("ok");
      expect(production.sandboxEnforced).toBe(true);
      const fromApp = await viaHost(
        runtime.urlFor(record, "production"),
        "/probe",
      );
      expectContained((await fromApp.json()) as Record<string, string>);

      const check = await settled(
        "check",
        (r) => r.commitOid === committed.value.commitOid,
      );
      expect(check.state).toBe("ok");
      expect(check.sandboxEnforced).toBe(true);
      const line = readRunLog(dataDir, check.id).lines.find((l) =>
        l.startsWith("PROBE "),
      );
      expect(line).toBeDefined();
      expectContained(JSON.parse(line!.slice(6)) as Record<string, string>);

      const branched = await commitToBranch(app, mallory, repo, {
        branch: "change",
        message: "A change",
        files: [{ path: "NOTES.md", content: "a change\n" }],
      });
      if (!branched.ok) throw new Error(JSON.stringify(branched.error));
      const opened = await openPull(app, mallory, repo, {
        title: "Change",
        baseBranch: "main",
        headBranch: "change",
      });
      if (!opened.ok) throw new Error(String(opened.error));
      const env = `pull-${opened.value.number}` as const;
      const preview = await settled("deploy", (r) => r.env === env);
      expect(preview.state).toBe("ok");
      const fromPreview = await viaHost(runtime.urlFor(record, env), "/probe");
      expectContained((await fromPreview.json()) as Record<string, string>);
    }, 240_000);
  },
);

describe.skipIf(noCells)("cells: limits stop a step, and say which", () => {
  let dir: string;
  let hidden: string;
  const saved = { ...WATCH };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-cell-limits-"));
    hidden = await mkdtemp(join(tmpdir(), "forge-cell-hidden-"));
    WATCH.tickMs = 200;
    WATCH.cpuWindowMs = 3_000;
    WATCH.diskEveryTicks = 1;
  });

  afterAll(async () => {
    Object.assign(WATCH, saved);
    await rm(dir, { recursive: true, force: true });
    await rm(hidden, { recursive: true, force: true });
  });

  const cell = (limits: Partial<CellSpec["limits"]>): CellSpec => ({
    dir,
    writable: [],
    home: join(dir, ".home"),
    hide: [hidden],
    egress: [],
    reach: [],
    limits: { memoryMiB: 2048, cpus: 4, diskMiB: 4096, ...limits },
  });

  const step = (command: string, spec: CellSpec) =>
    runStep("check", command, {
      cwd: dir,
      env: childEnv({}),
      log: () => {},
      signal: new AbortController().signal,
      timeoutMs: 60_000,
      cell: spec,
    });

  test("over its memory limit", async () => {
    const result = await step(
      `bun -e "const a = []; for (;;) { a.push(new Uint8Array(16 << 20).fill(1)); await Bun.sleep(10); }"`,
      cell({ memoryMiB: 128 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toMatch(
        /^check stopped: it used \d+ MiB of memory, over its 128 MiB limit$/,
      );
  }, 30_000);

  test("over its CPU limit", async () => {
    const result = await step(`bun -e "for (;;) {}"`, cell({ cpus: 0.25 }));
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toMatch(
        /^check stopped: it used [\d.]+ cores for \d+s, over its limit of 0\.25$/,
      );
  }, 30_000);

  test("over its disk limit", async () => {
    const result = await step(
      "head -c 200000000 /dev/zero > big; sleep 30",
      cell({ diskMiB: 64 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toMatch(
        /^check stopped: it wrote \d+ MiB to disk, over its 64 MiB limit$/,
      );
  }, 30_000);

  test("within its limits, a step runs and writes only where it may", async () => {
    await Bun.write(join(hidden, "secret"), "forge data");
    const result = await step(
      `echo ok > here.txt && test ! -e ${hidden}/secret && ! touch ${hidden}/x 2>/dev/null && ! touch /etc/forge-x 2>/dev/null`,
      cell({}),
    );
    expect(result).toEqual({ ok: true, value: undefined });
    expect(existsSync(join(dir, "here.txt"))).toBe(true);
    expect(existsSync(join(hidden, "x"))).toBe(false);
  }, 30_000);
});
