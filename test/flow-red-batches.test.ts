/**
 * The red-batch rate (#6427): of the merge-queue batches judged in the last
 * 6 h, how many went red. The read is checked on seeded rows; that a red
 * batch's bisection is one batch, and a pull check none, is checked through
 * the real queue with a stand-in gate that goes red on any `red-*` file.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { provideChecksForTest, type ChecksHandle } from "../src/checks/service.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { sweepGreen } from "../src/crew/autonomy.ts";
import { keepBatch, readRedBatches } from "../src/flow/red_batches.ts";
import { repoDir } from "../src/git/repos.ts";

const NOW = new Date("2026-10-26T12:00:00.000Z");
const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

describe("the red-batch rate", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let gates = 0;

  const git = (repo: Repo, ...args: string[]) =>
    Bun.spawnSync(["git", ...args], { cwd: repoDir(app.reposRoot, repo.ownerName, repo.name) })
      .stdout.toString()
      .trim();

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-red-batches-"));
    app = createApp({ dataDir, port: 0 });
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
    provideChecksForTest(app, {
      gate: async (repo: Repo, _pull: Pull, commitOid: string) => {
        gates++;
        const files = git(repo, "ls-tree", "-r", "--name-only", commitOid).split("\n");
        const ok = !files.some((f) => f.startsWith("red-"));
        return ok
          ? { ok, error: "", lines: [] }
          : { ok, error: "red", lines: ["test/red.test.ts:", "(fail) goes red [1.00ms]"] };
      },
    } as unknown as ChecksHandle);
  });

  afterAll(async () => {
    await app.close?.();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function repoNamed(name: string, visibility: "public" | "private", autonomous = false): Promise<Repo> {
    const made = await createRepo(app, alice, { name, visibility });
    if (!made.ok) throw new Error(String(made.error));
    if (!autonomous) return made.value;
    const seeded = await commitToBranch(app, alice, made.value, {
      message: "Start",
      files: [
        { path: "README.md", content: `# ${name}\n` },
        { path: "forge.json", content: JSON.stringify({ check: { run: "true", fast: "true", full: "true" } }) },
      ],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    app.db
      .query("UPDATE repo SET autonomy = 'autonomous', autonomy_by = ?2 WHERE id = ?1")
      .run(made.value.id, alice.id);
    return getRepoById(app.db, made.value.id)!;
  }

  async function greenPull(repo: Repo, path: string): Promise<Pull> {
    const pushed = await commitToBranch(app, alice, repo, {
      branch: `feature/${path}`,
      base: "main",
      message: path,
      files: [{ path, content: `export const n = "${path}";\n` }],
    });
    if (!pushed.ok) throw new Error(JSON.stringify(pushed.error));
    const opened = await openPull(app, alice, repo, { title: path, baseBranch: "main", headBranch: `feature/${path}` });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = getPull(app.db, repo.id, opened.value.number)!;
    const check = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      issueId: pull.id,
      env: `pull-${pull.number}`,
      commitOid: pull.headOid,
      reason: "pull",
    });
    claimRun(app.db, check.id);
    finishRun(app.db, check.id, { state: "ok", summary: "check passed" });
    return pull;
  }

  const clear = () => app.db.query("DELETE FROM queue_batch").run();

  test("nothing finished: no rate, not a zero one", () => {
    clear();
    expect(readRedBatches(app.db, NOW)).toEqual({ finished: 0, red: 0, rate: null });
  });

  test("four batches with one red give 0.25; one older than 6 h is left out", async () => {
    clear();
    const repo = await repoNamed("seeded", "public");
    keepBatch(app.db, repo.id, false, ago(5.9));
    keepBatch(app.db, repo.id, true, ago(3));
    keepBatch(app.db, repo.id, false, ago(1));
    keepBatch(app.db, repo.id, false, ago(0));
    keepBatch(app.db, repo.id, true, ago(6.1)); // past the window
    expect(readRedBatches(app.db, NOW)).toEqual({ finished: 4, red: 1, rate: 0.25 });
  });

  test("an agent's reading counts public repositories alone", async () => {
    clear();
    const open = await repoNamed("open-q", "public");
    const shut = await repoNamed("shut-q", "private");
    keepBatch(app.db, open.id, false, ago(1));
    keepBatch(app.db, shut.id, true, ago(1));
    expect(readRedBatches(app.db, NOW)).toEqual({ finished: 2, red: 1, rate: 0.5 });
    expect(readRedBatches(app.db, NOW, true)).toEqual({ finished: 1, red: 0, rate: 0 });
  });

  test("a verdict past a week is let go as the next is kept", async () => {
    clear();
    const repo = await repoNamed("pruned", "public");
    keepBatch(app.db, repo.id, true, new Date(NOW.getTime() - 8 * 24 * 3_600_000));
    keepBatch(app.db, repo.id, false, NOW);
    expect(app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM queue_batch").get()?.n).toBe(1);
  });

  test("a red batch and its bisection are one red batch; a pull check is none", async () => {
    clear();
    const repo = await repoNamed("bisected", "public", true);
    for (const name of ["a.ts", "b.ts", "c.ts", "red-d.ts"]) await greenPull(repo, name);
    // The four pull checks above finished, and none is a batch.
    expect(readRedBatches(app.db).finished).toBe(0);
    gates = 0;
    expect(await sweepGreen(app, repo)).toBe(3);
    // The whole candidate went red and its search gated more: one batch all the same.
    expect(gates).toBeGreaterThan(1);
    expect(readRedBatches(app.db)).toEqual({ finished: 1, red: 1, rate: 1 });
  });
});
