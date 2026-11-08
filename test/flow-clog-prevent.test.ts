/**
 * The seeded clog (#6523, part of #5930): 51 pulls opened against 15 landed in
 * the last hour, and six open pulls on one file. The inflow governor lowers the
 * builder slots and says why; the hot-file hold keeps a fresh build off that
 * file while a build on another file may start. The flow is plain data and the
 * pulls' files are remembered, so no clock and no git.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import type { Issue } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { governedSlots } from "../src/crew/governor.ts";
import { heldNow } from "../src/crew/held.ts";
import { HOT_PULLS, rememberPullFiles } from "../src/crew/hot_files.ts";
import type { RepoFlow } from "../src/flow/repo_flow.ts";

let dataDir: string;
let app: App;
let alice: User;
let repo: Repo;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-clog-"));
  app = createApp({ dataDir, port: 0 });
  const a = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!a.ok) throw new Error(a.error);
  alice = a.value;
  const made = await createRepo(app, alice, { name: "engine" });
  if (!made.ok) throw new Error(String(made.error));
  repo = made.value;
});

afterAll(async () => {
  rememberPullFiles(repo.id, []);
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const open = (title: string): Issue => {
  const r = openIssue(app, alice, repo, { title, body: "" });
  if (!r.ok) throw new Error(String(r.error));
  return r.value;
};

test("a seeded clog lowers the slots and holds a fresh build on the hot file", () => {
  const clog: RepoFlow = { open: 8, moving: 8, opened1h: 51, landed1h: 15, opened6h: 120, landed6h: 40 };
  const ceiling = 7;
  const governed = governedSlots(clog, ceiling);
  expect(governed.slots).toBeLessThan(ceiling);
  expect(governed.slots).toBeGreaterThanOrEqual(1);
  expect(governed.why).toContain("51 opened");
  expect(governed.why).toContain("15 landed");

  rememberPullFiles(
    repo.id,
    Array.from({ length: HOT_PULLS + 1 }, (_, i) => ({ number: i + 1, files: ["src/hot.ts", `src/own${i}.ts`] })),
  );
  const hot = open("Add a flag to src/hot.ts");
  const cold = open("Tidy src/cold.ts");

  const held = heldNow(app, repo);
  expect(held.by.hot_file.map((i) => i.number)).toEqual([hot.number]);
  expect(held.startable.map((r) => r.issue.number)).toEqual([cold.number]);
});
