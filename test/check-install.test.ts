/**
 * A check's install (#5093): installs into one cache take turns, a transient
 * install failure is retried once, and failing the same way twice is the
 * machine's — queued again, never the pull's red.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import {
  checkInstallCache,
  INFRASTRUCTURE,
  installWithRetry,
  transientLine,
  withLock,
} from "../src/checks/install.ts";
import { startChecks, type ChecksHandle } from "../src/checks/service.ts";
import { INFRA_SUMMARY, listRuns, type Run } from "../src/core/runs.ts";
import { createUser } from "../src/core/users.ts";
import type { Repo } from "../src/core/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
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
    const repoWith = async (name: string, script: string): Promise<Repo> => {
      const made = await createRepo(app, a.value, { name, visibility: "public" });
      if (!made.ok) throw new Error(String(made.error));
      const c = await commitToBranch(app, a.value, made.value, {
        message: "Declare a check",
        files: [
          { path: "forge.json", content: forgeJson },
          { path: "install.sh", content: script },
        ],
      });
      if (!c.ok) throw new Error(JSON.stringify(c.error));
      return made.value;
    };
    flaky = await repoWith("flaky", once);
    broken = await repoWith("broken", always);
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
