/**
 * A roll lets a merge-queue gate under way finish in the checks' drain
 * (#6611), as it lets a check finish: its verdict is judged, not cut off,
 * so the queue keeps it for the forge that carries on. While it runs, the
 * lane hands the same run to anyone who asks to adopt its commit.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { gateCandidate } from "../src/checks/landing.ts";
import { startChecks, type ChecksHandle } from "../src/checks/service.ts";
import { getPull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { repoDir } from "../src/git/repos.ts";
import { peerRuns } from "../src/runs/peer.ts";

describe("a gate under way when the forge rolls", () => {
  let dataDir: string;
  let app: App;
  let checks: ChecksHandle;
  let repo: Repo;
  let alice: User;
  const cells = process.env["FORGE_CELLS"];

  beforeAll(async () => {
    process.env["FORGE_CELLS"] = "off";
    dataDir = await mkdtemp(join(tmpdir(), "forge-gate-drain-"));
    app = createApp({ dataDir, port: 0 });
    checks = startChecks(app, { forgeUrl: "http://127.0.0.1:1", concurrency: 1, drainMs: 60_000 });
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const made = await createRepo(app, alice, { name: "drain", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [
        {
          path: "forge.json",
          content: JSON.stringify({
            check: { run: "true", fast: "true", full: "sleep 1; echo test/slow.test.ts:; exit 1" },
          }),
        },
      ],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const branched = await commitToBranch(app, alice, repo, {
      branch: "feature",
      message: "Touch b",
      files: [{ path: "b.txt", content: "b\n" }],
    });
    if (!branched.ok) throw new Error(JSON.stringify(branched.error));
  });

  afterAll(async () => {
    await checks.stop({ drain: false });
    app.close();
    if (cells === undefined) delete process.env["FORGE_CELLS"];
    else process.env["FORGE_CELLS"] = cells;
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the drain waits for it, its red is judged, and the lane hands its run to an adopter", async () => {
    const opened = await openPull(app, alice, repo, { title: "Feature", baseBranch: "main", headBranch: "feature" });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = getPull(app.db, repo.id, opened.value.number)!;
    const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
    expect(checks.adopt?.(pull.headOid)).toBeUndefined();
    const gating = gateCandidate(app, repo, pull, dir, pull.headOid);
    let adopted = checks.adopt?.(pull.headOid);
    for (let i = 0; i < 400 && adopted === undefined; i++) {
      await Bun.sleep(5);
      adopted = checks.adopt?.(pull.headOid);
    }
    expect(adopted).toBeDefined();
    await checks.stop({ drain: true });
    const verdict = await gating;
    expect(verdict.lands).toBe(false);
    expect("reopen" in verdict && verdict.reopen).toBe(true);
    expect((await adopted!).interrupted).toBeUndefined();
    expect(checks.adopt?.(pull.headOid)).toBeUndefined();
  }, 60_000);
});

describe("the drain is seconds, not minutes (#7799)", () => {
  test("a gate still running at the drain's end is handed back queued within it, and no run is left for a peer to wait on", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-gate-short-"));
    const cells = process.env["FORGE_CELLS"];
    process.env["FORGE_CELLS"] = "off";
    const app = createApp({ dataDir, port: 0 });
    const checks = startChecks(app, { forgeUrl: "http://127.0.0.1:1", concurrency: 1, drainMs: 1_000 });
    try {
      const a = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username: "alice",
        email: "alice@forge.local",
        password: "a-good-passphrase",
        adminIfFirst: true,
      });
      if (!a.ok) throw new Error(a.error);
      const made = await createRepo(app, a.value, { name: "short", visibility: "public" });
      if (!made.ok) throw new Error(String(made.error));
      const repo = made.value;
      const seeded = await commitToBranch(app, a.value, repo, {
        message: "Start",
        files: [{ path: "forge.json", content: JSON.stringify({ check: { run: "true", fast: "true", full: "sleep 30" } }) }],
      });
      if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
      const branched = await commitToBranch(app, a.value, repo, {
        branch: "feature",
        message: "Touch b",
        files: [{ path: "b.txt", content: "b\n" }],
      });
      if (!branched.ok) throw new Error(JSON.stringify(branched.error));
      const opened = await openPull(app, a.value, repo, { title: "Feature", baseBranch: "main", headBranch: "feature" });
      if (!opened.ok) throw new Error(String(opened.error));
      const pull = getPull(app.db, repo.id, opened.value.number)!;
      const gating = gateCandidate(app, repo, pull, repoDir(app.reposRoot, repo.ownerName, repo.name), pull.headOid);
      let adopted = checks.adopt?.(pull.headOid);
      for (let i = 0; i < 400 && adopted === undefined; i++) {
        await Bun.sleep(5);
        adopted = checks.adopt?.(pull.headOid);
      }
      expect(adopted).toBeDefined();
      const started = Date.now();
      await checks.stop({ drain: true });
      expect(Date.now() - started).toBeLessThan(15_000);
      const verdict = await gating;
      expect(verdict.lands).toBe(false);
      expect("interrupted" in verdict).toBe(true);
      expect((await adopted!).interrupted).toBe(true);
      expect(peerRuns(app.db)).toBe(0);
    } finally {
      app.close();
      if (cells === undefined) delete process.env["FORGE_CELLS"];
      else process.env["FORGE_CELLS"] = cells;
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 60_000);
});
