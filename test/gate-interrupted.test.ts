/**
 * A gate on land cut off by the forge stopping is no verdict (#3155): the
 * checks service answers it `interrupted`, the gate on land says so, and
 * the merge queue hands no one back (test/merge-queue.test.ts) — so the
 * forge that boots next gates it again and lands it without a push.
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

describe("a gate on land cut off by the forge stopping", () => {
  let dataDir: string;
  let app: App;
  let checks: ChecksHandle;
  let repo: Repo;
  let alice: User;
  const cells = process.env["FORGE_CELLS"];

  beforeAll(async () => {
    process.env["FORGE_CELLS"] = "off";
    dataDir = await mkdtemp(join(tmpdir(), "forge-gate-cut-"));
    app = createApp({ dataDir, port: 0 });
    checks = startChecks(app, { forgeUrl: "http://127.0.0.1:1", concurrency: 1 });
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
    const made = await createRepo(app, alice, { name: "cut", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [
        {
          path: "forge.json",
          content: JSON.stringify({
            check: { run: "true", fast: "true", full: "echo test/slow.test.ts:; sleep 30; exit 1" },
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

  test("answers interrupted, not red; a gate asked of a stopping forge is not started", async () => {
    const opened = await openPull(app, alice, repo, {
      title: "Feature",
      baseBranch: "main",
      headBranch: "feature",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = getPull(app.db, repo.id, opened.value.number)!;
    const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
    const started = Date.now();
    const gating = gateCandidate(app, repo, pull, dir, pull.headOid);
    await Bun.sleep(500);
    await checks.stop({ drain: false });
    expect(await gating).toEqual({ lands: false, interrupted: true });
    expect(Date.now() - started).toBeLessThan(20_000);
    // The roll is under way: nothing new is gated, and nothing is red.
    expect(await gateCandidate(app, repo, pull, dir, pull.headOid)).toEqual({
      lands: false,
      interrupted: true,
    });
  }, 30_000);
});
