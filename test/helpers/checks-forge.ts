/**
 * A forge with its checks service running, for the tests of a repository's
 * own check (`test/checks*.test.ts`): alice (admin) and bob (a member, a
 * reader of alice's repository) and alice's public `lib`, one check slot.
 * `lib`'s main starts with `OK.md` and no forge.json: no check is asked for
 * it, and a check that passes by `test -f OK.md` (`held`'s default) passes.
 *
 * `checksForge` registers the beforeAll that boots it and the afterAll that
 * stops it; the fields are set once beforeAll has run. `checks` is the live
 * service and may be replaced by a test that stops and starts it again.
 */

import { afterAll, beforeAll } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../../src/app.ts";
import { commitToBranch, createRepo } from "../../src/actions/repos.ts";
import { startChecks, type ChecksHandle } from "../../src/checks/service.ts";
import { listRuns, type Run } from "../../src/core/runs.ts";
import type { Pull } from "../../src/core/pulls.ts";
import { createUser, type User } from "../../src/core/users.ts";
import type { Repo } from "../../src/core/repos.ts";
import { serve, type Servers } from "../../src/http/server.ts";
import { listEvents } from "../../src/core/events.ts";
import { promote } from "./members.ts";
import "./roomy-disk.ts";

/** A forge.json declaring `run` as the check, with no install step. */
export const checkJson = (run: string, extra = ""): string =>
  `{"check": {"run": ${JSON.stringify(run)}, "install": ""${extra}}}\n`;

export type ChecksForge = {
  dataDir: string;
  app: App;
  servers: Servers;
  checks: ChecksHandle;
  alice: User;
  bob: User;
  repo: Repo;
  /** Waits for the first check `where` names to end ok or failed. */
  settled(where: (run: Run) => boolean, timeoutMs?: number): Promise<Run>;
  /** Waits until `done` holds, polling the database; a check's own pace, not a timer's. */
  until(done: () => boolean, what: string): Promise<void>;
  /**
   * A check command that holds its slot until the test lets it go
   * (`release`), then runs `then`: the test is the clock, so no wait is
   * guessed at. Never released, it runs until it is cut off.
   */
  held(name: string, then?: string): string;
  release(name: string): void;
  /** Waits until a fork pull's new head is announced on the bus as `pull.pushed`. */
  headAnnounced(pull: Pull, headOid: string): Promise<void>;
  checksOf(commitOid: string): Run[];
  /** Commits `command` as main's check and waits for its run to be running; its id. */
  slowCheck(command: string, message: string): Promise<string>;
};

export function checksForge(prefix = "forge-checks-"): ChecksForge {
  const f = {} as ChecksForge;

  f.settled = async (where, timeoutMs = 4_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = listRuns(f.app.db, f.repo.id, { kind: "check", limit: 50 }).find(where);
      if (run && (run.state === "ok" || run.state === "failed")) return run;
      await Bun.sleep(10);
    }
    throw new Error("check did not settle");
  };

  f.until = async (done, what) => {
    const deadline = Date.now() + 4_000;
    while (!done()) {
      if (Date.now() > deadline) throw new Error(`never came: ${what}`);
      await Bun.sleep(10);
    }
  };

  f.held = (name, then = "test -f OK.md") =>
    `while [ ! -f '${f.dataDir}/go-${name}' ]; do sleep 0.01; done; ${then}`;
  f.release = (name) => writeFileSync(join(f.dataDir, `go-${name}`), "");

  f.headAnnounced = (pull, headOid) =>
    f.until(
      () =>
        listEvents(f.app.db, { repoId: f.repo.id, kind: "pull.pushed" }).some(
          (e) => e.payload["number"] === pull.number && e.payload["headOid"] === headOid,
        ),
      "the pull's new head announced",
    );

  f.checksOf = (commitOid) =>
    listRuns(f.app.db, f.repo.id, { kind: "check", limit: 50 }).filter(
      (r) => r.commitOid === commitOid,
    );

  f.slowCheck = async (command, message) => {
    const made = await commitToBranch(f.app, f.alice, f.repo, {
      message,
      files: [{ path: "forge.json", content: checkJson(command) }],
    });
    if (!made.ok) throw new Error(JSON.stringify(made.error));
    const oid = made.value.commitOid;
    await f.until(() => f.checksOf(oid)[0]?.state === "running", `${message} running`);
    return f.checksOf(oid)[0]!.id;
  };

  beforeAll(async () => {
    f.dataDir = await mkdtemp(join(tmpdir(), prefix));
    f.app = createApp({ dataDir: f.dataDir, port: 0 });
    f.servers = await serve(f.app);
    f.checks = startChecks(f.app, { forgeUrl: f.servers.url, concurrency: 1 });
    const a = await createUser(f.app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    f.alice = a.value;
    const b = await createUser(f.app.db, {
      origin: "seed",
      trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    f.bob = b.value;
    promote(f.app.db, f.bob);
    const made = await createRepo(f.app, f.alice, { name: "lib", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    f.repo = made.value;
    const seeded = await commitToBranch(f.app, f.alice, f.repo, {
      message: "Seed OK.md",
      files: [{ path: "OK.md", content: "ok\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  });

  afterAll(async () => {
    await f.checks.stop();
    f.servers.stop();
    f.app.close();
    await rm(f.dataDir, { recursive: true, force: true });
  });

  return f;
}
