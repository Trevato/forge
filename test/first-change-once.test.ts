/**
 * The first-change rule applies once (#12048): after one crew pull of an app
 * has merged, the next green crew pull waits for the reviewer under the normal
 * rule. `nothingLandedYet` is read from merged pulls when the gate decides.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newApp } from "../src/actions/apps.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { submitReview } from "../src/core/reviews.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { landIfGreen, reviewed } from "../src/crew/autonomy.ts";
import { isFirstChange, nothingLandedYet } from "../src/crew/first_change.ts";
import { seatAs } from "./helpers/seat.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir = "";
let app: App;
let alice: User;
let mason: User;
let quill: User;
let repo: Repo;
const fresh = () => getRepoById(app.db, repo.id)!;

async function greenPull(name: string): Promise<Pull> {
  const branch = await commitToBranch(app, alice, repo, {
    branch: `feature/${name}`,
    base: "main",
    message: name,
    files: [{ path: `${name}.ts`, content: `export const n = "${name}";\n` }],
  });
  if (!branch.ok) throw new Error(JSON.stringify(branch.error));
  const opened = await openPull(app, alice, repo, { title: name, baseBranch: "main", headBranch: `feature/${name}` });
  if (!opened.ok) throw new Error(String(opened.error));
  app.db.query("UPDATE issue SET author_id = ?2 WHERE id = ?1").run(opened.value.id, mason.id);
  const pull = getPull(app.db, repo.id, opened.value.number)!;
  const check = createRun(app.db, { repoId: repo.id, kind: "check", issueId: pull.id, env: `pull-${pull.number}`, commitOid: pull.headOid, reason: "pull" });
  claimRun(app.db, check.id);
  finishRun(app.db, check.id, { state: "ok", summary: "check passed" });
  return pull;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-first-once-"));
  app = createApp({ dataDir: dir, port: 0 });
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!made.ok) throw new Error(made.error);
  alice = made.value;
  for (const name of ["mason", "quill"]) {
    const agent = await createAgent(app, alice, { username: name });
    if (!agent.ok) throw new Error(String(agent.error));
  }
  mason = getUserByName(app.db, "mason")!;
  quill = getUserByName(app.db, "quill")!;
  const created = await newApp(app, alice, { name: "hello", description: "A page that says hello", visibility: "private" });
  if (!created.ok) throw new Error(JSON.stringify(created.error));
  repo = created.value.repo;
  addToCrew(app, alice, repo, "mason");
  addToCrew(app, alice, repo, "quill");
  seatAs(app.db, repo.id, mason.id, "builder");
  seatAs(app.db, repo.id, quill.id, "reviewer");
  app.db.query("UPDATE repo SET autonomy = 'autonomous', autonomy_by = ?2 WHERE id = ?1").run(repo.id, alice.id);
});

afterAll(async () => {
  await app?.close?.();
  await rm(dir, { recursive: true, force: true });
});

test("after one merged crew pull, a second green crew pull waits for the reviewer", async () => {
  const first = await greenPull("first");
  expect(nothingLandedYet(app.db, repo.id)).toBe(true);
  expect(isFirstChange(app.db, fresh(), first)).toBe(true);
  expect(await landIfGreen(app, fresh(), first)).toBe(true);

  const second = await greenPull("second");
  expect(nothingLandedYet(app.db, repo.id)).toBe(false);
  expect(isFirstChange(app.db, fresh(), second)).toBe(false);
  expect(await reviewed(app, fresh(), second)).toBe("hold");
  expect(await landIfGreen(app, fresh(), second)).toBe(false);
  expect(getPull(app.db, repo.id, second.number)?.mergedAt).toBeNull();

  submitReview(app.db, { issueId: second.id, authorId: quill.id, state: "approved", commitOid: second.headOid, body: "Looks right." });
  expect(await landIfGreen(app, fresh(), second)).toBe(true);
});
