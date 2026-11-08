/**
 * A check's install (#5093): installs into one cache take turns, a transient
 * install failure is retried once, and failing the same way twice is the
 * machine's — queued again, never the pull's red.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import {
  checkInstallCache,
  cellInstall,
  copying,
  fillTimeoutMs,
  LOCK_STALE_MS,
  prefillInstallCache,
  INFRASTRUCTURE,
  installWithRetry,
  transientLine,
  withLock,
} from "../src/checks/install.ts";
import { boundFrom, evictInstallCache, evictSoon, lend } from "../src/checks/install_evict.ts";
import { startChecks, type ChecksHandle } from "../src/checks/service.ts";
import { INFRA_SUMMARY, listRuns, type Run } from "../src/core/runs.ts";
import { createUser } from "../src/core/users.ts";
import type { Repo } from "../src/core/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { readRunLog } from "../src/runs/log.ts";
import { err, ok, type Result } from "../src/kernel/result.ts";

const never = new AbortController().signal;

describe("transientLine", () => {
  test("names the three failures the machine causes, and nothing the code does", () => {
    expect(transientLine(['error: Fail extracting tarball for "@typescript/typescript-linux-x64"'])).toContain("Fail extracting");
    expect(transientLine(["npm ERR! code EINTEGRITY"])).toContain("EINTEGRITY");
    expect(transientLine(["error: ECONNRESET reading registry.npmjs.org"])).toContain("ECONNRESET");
    expect(transientLine(["error: No version matching \"9.9.9\" found", "exit 1"])).toBeUndefined();
  });
});

describe("installWithRetry", () => {
  const scripted = (outputs: (string | null)[]) => {
    let calls = 0;
    const attempt = async (log: (line: string) => void): Promise<Result<void, string>> => {
      const line = outputs[calls++] ?? null;
      if (line === null) return ok();
      log(line);
      return err(`install exited with code 1 — ${line}`);
    };
    return { attempt, calls: () => calls };
  };

  test("a transient failure is retried once and the retry's green is the answer", async () => {
    const s = scripted(['error: Fail extracting tarball for "x"', null]);
    const lines: string[] = [];
    const done = await installWithRetry(s.attempt, { log: (l) => lines.push(l), signal: never, retryMs: 1 });
    expect(done).toEqual({ ok: true });
    expect(s.calls()).toBe(2);
    expect(lines.some((l) => l.includes("retrying once"))).toBe(true);
  });

  test("the code's own failure is answered at once, and is not infrastructure", async () => {
    const s = scripted(['error: No version matching "9.9.9"']);
    const done = await installWithRetry(s.attempt, { log: () => {}, signal: never, retryMs: 1 });
    expect(s.calls()).toBe(1);
    expect(done.ok).toBe(false);
    if (!done.ok) expect(done.infrastructure).toBe(false);
  });

  test("failing transiently twice is infrastructure, tried exactly twice", async () => {
    const s = scripted(["EINTEGRITY", "ECONNRESET", null]);
    const done = await installWithRetry(s.attempt, { log: () => {}, signal: never, retryMs: 1 });
    expect(s.calls()).toBe(2);
    expect(done.ok).toBe(false);
    if (!done.ok) {
      expect(done.infrastructure).toBe(true);
      expect(done.error.startsWith(`${INFRASTRUCTURE}:`)).toBe(true);
    }
  });

  test("a cancel during the wait does not retry", async () => {
    const s = scripted(["ECONNRESET", null]);
    const abort = new AbortController();
    const pending = installWithRetry(s.attempt, { log: () => {}, signal: abort.signal, retryMs: 60_000 });
    abort.abort();
    const done = await pending;
    expect(s.calls()).toBe(1);
    expect(done.ok).toBe(false);
    if (!done.ok) expect(done.infrastructure).toBe(false);
  });
});

describe("withLock", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-install-lock-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("8 parallel installs on one cache, 20 rounds: none ever extracts beside another", async () => {
    // Each install "extracts" the same package: a directory that exists only
    // while one install is in it. `mkdir` fails when another is in there —
    // the collision bun reports as `Fail extracting tarball`.
    const cache = join(dir, "cache");
    mkdirSync(cache, { recursive: true });
    const install = async (): Promise<number> => {
      const proc = Bun.spawn(
        ["/bin/sh", "-c", 'mkdir "$1/pkg.extracting" && sleep 0.005 && rmdir "$1/pkg.extracting"', "sh", cache],
        { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
      );
      return proc.exited;
    };
    let failures = 0;
    for (let round = 0; round < 20; round++) {
      const codes = await Promise.all(
        Array.from({ length: 8 }, () => withLock(`${cache}.lock`, install, { signal: never })),
      );
      for (const code of codes) if (!code.ok || code.value !== 0) failures++;
    }
    expect(failures).toBe(0);
    expect(existsSync(`${cache}.lock`)).toBe(false);
  }, 60_000);

  test("a lock left by a holder that died is taken over", async () => {
    const lock = join(dir, "dead.lock");
    // A pid no process holds: the kernel's pid_max is far below it.
    writeFileSync(lock, `${2 ** 30} ${Date.now()}\n`);
    const held = await withLock(lock, async () => "ran", { signal: never });
    expect(held).toEqual({ ok: true, value: "ran" });
  });

  test("a live holder's lock is waited for, and a cancel ends the wait without running", async () => {
    const lock = join(dir, "live.lock");
    writeFileSync(lock, `${process.pid} ${Date.now()}\n`);
    const abort = new AbortController();
    let ran = false;
    const pending = withLock(lock, async () => {
      ran = true;
    }, { signal: abort.signal });
    await Bun.sleep(120);
    expect(ran).toBe(false);
    abort.abort();
    const held = await pending;
    expect(held.ok).toBe(false);
    expect(ran).toBe(false);
    expect(existsSync(lock)).toBe(true);
  });
});

describe("a check whose install fails on the machine", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let checks: ChecksHandle;
  let flaky: Repo;
  let broken: Repo;
  let lender: Repo;

  // Fails once with bun's own line, then installs: the marker lives in the
  // checkout, which the retry shares and the next check does not.
  const once =
    'test -f .tried && exit 0; touch .tried; echo \'error: Fail extracting tarball for "@typescript/typescript-linux-x64"\'; exit 1\n';
  const always = "echo 'error: Fail extracting tarball for \"x\"'; exit 1\n";
  const forgeJson = '{"check": {"run": "exit 0", "install": "sh install.sh"}}\n';

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-check-install-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    checks = startChecks(app, { forgeUrl: servers.url, concurrency: 2, installRetryMs: 10 });
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    const repoWith = async (name: string, script: string, more: { path: string; content: string }[] = []): Promise<Repo> => {
      const made = await createRepo(app, a.value, { name, visibility: "public" });
      if (!made.ok) throw new Error(String(made.error));
      const c = await commitToBranch(app, a.value, made.value, {
        message: "Declare a check",
        files: [
          { path: "forge.json", content: forgeJson },
          { path: "install.sh", content: script },
          ...more,
        ],
      });
      if (!c.ok) throw new Error(JSON.stringify(c.error));
      return made.value;
    };
    flaky = await repoWith("flaky", once);
    broken = await repoWith("broken", always);
    // Leaves a package the lockfile names, and one it does not, both untouched for years.
    const aged =
      'for p in a@1.0.0@@@1 gone@1.0.0@@@1; do mkdir -p "$BUN_INSTALL_CACHE_DIR/$p"; touch -d 2000-01-01 "$BUN_INSTALL_CACHE_DIR/$p"; done\n';
    lender = await repoWith("lender", aged, [{ path: "bun.lock", content: '{"packages": {"a": ["a@1.0.0"]}}\n' }]);
  });
  afterAll(async () => {
    await checks.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const settled = async (repo: Repo, done: (runs: Run[]) => boolean): Promise<Run[]> => {
    const deadline = Date.now() + 30_000;
    let runs: Run[] = [];
    while (Date.now() < deadline) {
      runs = listRuns(app.db, repo.id, { kind: "check", limit: 50 });
      if (done(runs)) break;
      await Bun.sleep(50);
    }
    return runs;
  };

  test("one transient failure is retried in the same check, which passes", async () => {
    const runs = await settled(flaky, (rs) => rs.some((r) => r.state === "ok" || r.state === "failed"));
    expect(runs.length).toBe(1);
    expect(runs[0]!.state).toBe("ok");
    // Uncontained, the repository's own cache is the one bun is pointed at.
    expect(existsSync(checkInstallCache(dataDir, flaky.id))).toBe(true);
    // Uncontained, no install line: its shared cache is not metered (#7546).
    expect(
      readRunLog(dataDir, runs[0]!.id).lines.some((l) => l.startsWith("install fetched")),
    ).toBe(false);
  });

  test("an uncontained install lends what its lockfile names, and the sweep takes the rest (#7574)", async () => {
    const runs = await settled(lender, (rs) => rs.some((r) => r.state === "ok" || r.state === "failed"));
    expect(runs[0]?.state).toBe("ok");
    const cache = checkInstallCache(dataDir, lender.id);
    const deadline = Date.now() + 3_000;
    while (existsSync(join(cache, "gone@1.0.0@@@1")) && Date.now() < deadline) await Bun.sleep(50);
    expect(existsSync(join(cache, "gone@1.0.0@@@1"))).toBe(false);
    expect(statSync(join(cache, "a@1.0.0@@@1")).mtimeMs).toBeGreaterThan(Date.now() - 86_400_000);
  });

  test("failing twice is infrastructure: queued again, not red; a second time it fails saying so", async () => {
    const runs = await settled(broken, (rs) => rs.some((r) => r.state === "failed"));
    const first = runs.find((r) => r.attempt === 0)!;
    const second = runs.find((r) => r.attempt === 1)!;
    expect(first.state).toBe("cancelled");
    expect(first.summary).toBe(INFRA_SUMMARY);
    expect(second.state).toBe("failed");
    expect(second.summary).toContain(`${INFRASTRUCTURE}:`);
    expect(runs.length).toBe(2);
  });
});

describe("prefillInstallCache (#7543)", () => {
  setDefaultTimeout(60_000);
  const scratch = async (): Promise<string> => mkdtemp(join(tmpdir(), "prefill-test-"));

  /** A registry on loopback serving one package, `fixture-pkg@1.0.0`; counts its requests. */
  const registry = async (): Promise<{ url: string; hits: string[]; stop: () => void; dir: string }> => {
    const dir = await scratch();
    mkdirSync(join(dir, "pkg", "package"), { recursive: true });
    writeFileSync(join(dir, "pkg", "package", "package.json"), JSON.stringify({ name: "fixture-pkg", version: "1.0.0" }));
    const made = Bun.spawnSync(["tar", "-czf", join(dir, "fixture.tgz"), "-C", join(dir, "pkg"), "package"]);
    if (made.exitCode !== 0) throw new Error("tar is needed for the fixture registry");
    const tarball = new Uint8Array(await Bun.file(join(dir, "fixture.tgz")).arrayBuffer());
    // As npm serves it: the fill trusts only a lockfile with sha512 integrities (`checks/fillable.ts`).
    const integrity = `sha512-${new Bun.CryptoHasher("sha512").update(tarball).digest("base64")}`;
    const hits: string[] = [];
    const server: ReturnType<typeof Bun.serve> = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req): Response {
        const path = new URL(req.url).pathname;
        hits.push(path);
        if (path === "/fixture-pkg/-/fixture-pkg-1.0.0.tgz") return new Response(tarball);
        if (path === "/fixture-pkg")
          return Response.json({
            name: "fixture-pkg",
            "dist-tags": { latest: "1.0.0" },
            versions: {
              "1.0.0": {
                name: "fixture-pkg",
                version: "1.0.0",
                dist: { tarball: `http://127.0.0.1:${server.port}/fixture-pkg/-/fixture-pkg-1.0.0.tgz`, integrity },
              },
            },
          });
        return new Response("not found", { status: 404 });
      },
    });
    return { url: `http://127.0.0.1:${server.port}/`, hits, stop: () => void server.stop(true), dir };
  };

  /** A checkout depending on the fixture, with the lockfile bun writes against it. */
  const checkout = async (reg: string, dir: string): Promise<string> => {
    const co = join(dir, "co");
    mkdirSync(co);
    writeFileSync(join(co, "package.json"), JSON.stringify({ name: "x", version: "1.0.0", dependencies: { "fixture-pkg": "1.0.0" } }));
    const env = { PATH: process.env["PATH"] ?? "", HOME: dir, BUN_CONFIG_REGISTRY: reg };
    // Async: the fixture registry answers from this process's event loop.
    const made = Bun.spawn(["bun", "install", "--lockfile-only"], {
      cwd: co,
      env: { ...env, BUN_INSTALL_CACHE_DIR: join(dir, "lock-cache") },
      stdout: "pipe",
      stderr: "pipe",
    });
    if ((await made.exited) !== 0) throw new Error(`fixture lockfile: ${await new Response(made.stderr).text()}`);
    return co;
  };

  const envFor = (dir: string, reg: string): Record<string, string> => ({
    PATH: process.env["PATH"] ?? "",
    HOME: dir,
    BUN_CONFIG_REGISTRY: reg,
  });

  test("copying asks every bun install in a contained command for the copyfile backend, once", () => {
    expect(copying("bun install --frozen-lockfile")).toBe("bun install --backend=copyfile --frozen-lockfile");
    expect(copying("cd x && bun install")).toBe("cd x && bun install --backend=copyfile");
    expect(copying("bun install --backend=hardlink")).toBe("bun install --backend=hardlink");
    expect(copying("npm ci")).toBe("npm ci");
  });

  test("a contained install reads the shared cache; an unfilled one keeps its own", () => {
    const filled = cellInstall("bun install", { A: "1" }, "/c/bun");
    expect(filled.command).toBe("bun install --backend=copyfile");
    expect(filled.env).toEqual({ A: "1", BUN_INSTALL_CACHE_DIR: "/c/bun" });
    expect(cellInstall("bun install", { A: "1" }, undefined)).toEqual({ command: "bun install", env: { A: "1" } });
  });

  test("a checkout with no lockfile fills nothing, says so, and is not a failure", async () => {
    const dir = await scratch();
    const lines: string[] = [];
    const filled = await prefillInstallCache({ cache: join(dir, "cache"), dir, env: {}, log: (l) => lines.push(l), signal: never });
    expect(filled).toEqual({ ok: true, value: false });
    expect(lines.join("\n")).toContain("no bun lockfile");
    await rm(dir, { recursive: true, force: true });
  });

  test("a fill needs only the pinned registry, and a warm cache needs none", async () => {
    const reg = await registry();
    try {
      const co = await checkout(reg.url, reg.dir);
      const cache = join(reg.dir, "cache");
      const first = await prefillInstallCache({ cache, dir: co, env: envFor(reg.dir, reg.url), log: () => {}, signal: never });
      expect(first).toEqual({ ok: true, value: true });
      expect(reg.hits).toContain("/fixture-pkg/-/fixture-pkg-1.0.0.tgz");
      reg.stop();
      const again = await prefillInstallCache({
        cache,
        dir: co,
        env: envFor(reg.dir, reg.url),
        log: () => {},
        signal: never,
      });
      expect(again).toEqual({ ok: true, value: true });
      expect(existsSync(`${cache}.lock`)).toBe(false);
    } finally {
      reg.stop();
      await rm(reg.dir, { recursive: true, force: true });
    }
  });

  test("eviction drops the entry not lent for days, keeps the lent one, and the next install is offline (#7574)", async () => {
    const reg = await registry();
    try {
      const co = await checkout(reg.url, reg.dir);
      const cache = join(reg.dir, "cache");
      const fill = () => prefillInstallCache({ cache, dir: co, env: envFor(reg.dir, reg.url), log: () => {}, signal: never });
      expect(await fill()).toEqual({ ok: true, value: true });
      const stale = join(cache, "old-pkg@2.0.0@@@1");
      mkdirSync(stale);
      writeFileSync(join(stale, "package.json"), "{}");
      const long = new Date(Date.now() - 90 * 86_400_000);
      utimesSync(stale, long, long);
      // The locked package is old too, until a fill lends it.
      const lent = readdirSync(cache).filter((n) => n.startsWith("fixture-pkg@1.0.0"));
      expect(lent.length).toBeGreaterThan(0);
      for (const n of lent) utimesSync(join(cache, n), long, long);
      expect(await fill()).toEqual({ ok: true, value: true });
      const removed = await evictInstallCache({ cache, bound: boundFrom({}), signal: never });
      expect(removed).toEqual(["old-pkg@2.0.0@@@1"]);
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(`${cache}.lock`)).toBe(false);
      reg.stop();
      expect(await fill()).toEqual({ ok: true, value: true });
    } finally {
      reg.stop();
      await rm(reg.dir, { recursive: true, force: true });
    }
  });

  test("past the size cap the oldest go first; the bound reads its env", async () => {
    const dir = await scratch();
    try {
      const cache = join(dir, "cache");
      const now = Date.now();
      for (const [i, name] of ["a@1@@@1", "b@1@@@1", "c@1@@@1"].entries()) {
        mkdirSync(join(cache, name), { recursive: true });
        writeFileSync(join(cache, name, "f"), "x".repeat(1000));
        const t = new Date(now - (3 - i) * 1000);
        utimesSync(join(cache, name), t, t);
      }
      const removed = await evictInstallCache({ cache, bound: { maxAgeDays: 30, maxBytes: 2500 }, signal: never, now });
      expect(removed).toEqual(["a@1@@@1"]);
      expect(boundFrom({ FORGE_CHECK_CACHE_DAYS: "2", FORGE_CHECK_CACHE_MB: "5" })).toEqual({ maxAgeDays: 2, maxBytes: 5 * 1024 ** 2 });
      expect(boundFrom({ FORGE_CHECK_CACHE_DAYS: "x", FORGE_CHECK_CACHE_MB: "-1" }).maxAgeDays).toBe(30);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a failing lend leaves the fill alone", async () => {
    const dir = await scratch();
    try {
      writeFileSync(join(dir, "bun.lock"), '"a@1.0.0"');
      // A cache that is a file: reading it throws ENOTDIR inside the lend.
      const cache = join(dir, "c");
      writeFileSync(cache, "");
      expect(() => lend(cache, dir)).not.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a sweep runs once an hour per cache, and a second while one runs collapses", async () => {
    const dir = await scratch();
    try {
      const cache = join(dir, "cache");
      const old = new Date(Date.now() - 40 * 86_400_000);
      const stale = (name: string): string => {
        mkdirSync(join(cache, name), { recursive: true });
        utimesSync(join(cache, name), old, old);
        return join(cache, name);
      };
      const a = stale("a@1@@@1");
      // Hold the cache's lock so the first sweep waits under it.
      const held = await withLock(
        `${cache}.lock`,
        async () => {
          const first = evictSoon(cache, {});
          const second = evictSoon(cache, {});
          // A second sweep would wait on this lock too; it must be over at once.
          const over = await Promise.race([second.then(() => true), Bun.sleep(200).then(() => false)]);
          expect(existsSync(a)).toBe(true);
          return { first, over };
        },
        { signal: never },
      );
      expect(held.ok && held.value.over).toBe(true);
      if (held.ok) await held.value.first;
      expect(existsSync(a)).toBe(false);
      const b = stale("b@1@@@1");
      await evictSoon(cache, {});
      expect(existsSync(b)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an aborted sweep does not suppress the next one", async () => {
    const dir = await scratch();
    try {
      const cache = join(dir, "cache");
      mkdirSync(join(cache, "a@1@@@1"), { recursive: true });
      writeFileSync(join(cache, "a@1@@@1", "f"), "x");
      const old = new Date(Date.now() - 40 * 86_400_000);
      utimesSync(join(cache, "a@1@@@1"), old, old);
      const gone = new AbortController();
      gone.abort();
      expect(await evictInstallCache({ cache, bound: boundFrom({}), signal: gone.signal })).toBeUndefined();
      expect(existsSync(join(cache, "a@1@@@1"))).toBe(true);
      await evictSoon(cache, {});
      expect(existsSync(join(cache, "a@1@@@1"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a fill's timeout is clamped under the lock's staleness", () => {
    expect(fillTimeoutMs(undefined)).toBe(LOCK_STALE_MS / 2);
    expect(fillTimeoutMs(LOCK_STALE_MS * 4)).toBe(LOCK_STALE_MS / 2);
    expect(fillTimeoutMs(1000)).toBe(1000);
  });

  test("bun installs from a filled cache that is read-only, copying, with no registry", async () => {
    const reg = await registry();
    try {
      const co = await checkout(reg.url, reg.dir);
      const cache = join(reg.dir, "cache");
      const filled = await prefillInstallCache({ cache, dir: co, env: envFor(reg.dir, reg.url), log: () => {}, signal: never });
      expect(filled).toEqual({ ok: true, value: true });
      reg.stop();
      Bun.spawnSync(["chmod", "-R", "a-w", cache]);
      const probe = join(cache, "probe");
      let writable = true;
      try {
        writeFileSync(probe, "x");
      } catch {
        writable = false;
      }
      // (root ignores modes; the install is then merely run, not proven read-only)
      if (process.getuid?.() !== 0) expect(writable).toBe(false);
      const proc = Bun.spawn(["bun", "install", "--frozen-lockfile", "--backend=copyfile"], {
        cwd: co,
        env: { ...envFor(reg.dir, "http://127.0.0.1:1/"), BUN_INSTALL_CACHE_DIR: cache },
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
      const code = await proc.exited;
      Bun.spawnSync(["chmod", "-R", "u+w", cache]);
      expect({ code, out }).toMatchObject({ code: 0 });
      expect(existsSync(join(co, "node_modules", "fixture-pkg", "package.json"))).toBe(true);
    } finally {
      reg.stop();
      await rm(reg.dir, { recursive: true, force: true });
    }
  });

  test("a package the registry will not serve fails on the fetch, not the lockfile, and frees the lock", async () => {
    const reg = await registry();
    try {
      const co = await checkout(reg.url, reg.dir);
      reg.stop();
      const lines: string[] = [];
      const cache = join(reg.dir, "empty-cache");
      const filled = await prefillInstallCache({ cache, dir: co, env: envFor(reg.dir, reg.url), log: (l) => lines.push(l), signal: never });
      expect(filled.ok).toBe(false);
      expect(lines.join("\n")).not.toMatch(/lockfile had changes|frozen/i);
      expect(reg.hits.filter((h) => h.endsWith(".tgz"))).toEqual([]); // the tarball was asked for and never served
      expect(existsSync(`${cache}.lock`)).toBe(false);
    } finally {
      await rm(reg.dir, { recursive: true, force: true });
    }
  });

  test("the pull's own bunfig.toml and .npmrc do not choose where the forge fetches", async () => {
    const reg = await registry();
    const decoy = await registry();
    try {
      const co = await checkout(reg.url, reg.dir);
      writeFileSync(join(co, "bunfig.toml"), `[install]\nregistry = "${decoy.url}"\n`);
      writeFileSync(join(co, ".npmrc"), `registry=${decoy.url}\n`);
      const filled = await prefillInstallCache({
        cache: join(reg.dir, "cache"),
        dir: co,
        env: envFor(reg.dir, reg.url),
        log: () => {},
        signal: never,
      });
      expect(filled).toEqual({ ok: true, value: true });
      expect(decoy.hits).toEqual([]);
      expect(reg.hits.length).toBeGreaterThan(0);
    } finally {
      reg.stop();
      decoy.stop();
      await rm(reg.dir, { recursive: true, force: true });
      await rm(decoy.dir, { recursive: true, force: true });
    }
  });

  test("a lockfile naming another host, or a git dependency, is not filled from", async () => {
    const reg = await registry();
    try {
      const co = await checkout(reg.url, reg.dir);
      const cache = join(reg.dir, "cache");
      const lock = join(co, "bun.lock");
      const good = readFileSync(lock, "utf8");
      for (const bad of [
        `${good}\n// ["x", "http://169.254.169.254/x.tgz"]`,
        `${good}\n// ["y", "y@github:someone/repo#abc"]`,
      ]) {
        writeFileSync(lock, bad);
        const lines: string[] = [];
        const filled = await prefillInstallCache({ cache, dir: co, env: envFor(reg.dir, reg.url), log: (l) => lines.push(l), signal: never });
        expect(filled).toEqual({ ok: true, value: false });
        expect(lines.join("\n")).toContain("cache not filled");
      }
      expect(reg.hits.filter((h) => h.endsWith(".tgz"))).toEqual([]);
      expect(existsSync(cache)).toBe(false);
    } finally {
      reg.stop();
      await rm(reg.dir, { recursive: true, force: true });
    }
  });
});
