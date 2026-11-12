/**
 * A crew pull opened a moment ago (#8473), read once per repository and
 * matched in memory (#10445): the picker used to ask SQL once per ready
 * issue per builder.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createUser } from "../src/core/users.ts";
import { BUILD_SETTLE_MS, FRESH_PULLS_SQL, freshPullFor, freshPulls, pullFor } from "../src/crew/fresh_pull.ts";
import { quietWeek } from "./helpers/week-quiet.ts";

let dataDir: string;
let app: App;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-fresh-"));
  app = createApp({ dataDir, port: 0 });
  quietWeek(app.db);
});

afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a branch of a builder for the issue matches, a lookalike does not", () => {
  const fresh = [
    { number: 7, headBranch: "mason/12-fix-the-thing" },
    { number: 8, headBranch: "mason/120" },
    { number: 9, headBranch: "atlas/13" },
  ];
  expect(pullFor(fresh, 12, ["mason"])).toEqual({ number: 7 });
  expect(pullFor(fresh, 120, ["mason"])).toEqual({ number: 8 });
  expect(pullFor(fresh, 1, ["mason"])).toBeUndefined();
  expect(pullFor(fresh, 13, ["mason"])).toBeUndefined();
  expect(pullFor(fresh, 13, ["mason", "atlas"])).toEqual({ number: 9 });
  expect(pullFor(fresh, 12, [])).toBeUndefined();
  // As the old LIKE did: the `-…` form ignores ASCII case, the exact form does not.
  expect(pullFor([{ number: 4, headBranch: "Mason/12-Fix" }], 12, ["mason"])).toEqual({ number: 4 });
  expect(pullFor([{ number: 4, headBranch: "mason/12-fix" }], 12, ["MASON"])).toEqual({ number: 4 });
  expect(pullFor([{ number: 5, headBranch: "Mason/12" }], 12, ["mason"])).toBeUndefined();
  expect(pullFor([{ number: 6, headBranch: "mÅson/12-x" }], 12, ["måson"])).toBeUndefined();
  // A username with LIKE's wildcards is matched literally.
  expect(pullFor([{ number: 3, headBranch: "ma_on/12" }], 12, ["mason"])).toBeUndefined();
});

test("the repository's fresh pulls are read once, inside the window only, through issue_created", async () => {
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "mason",
    email: "mason@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  const made = await createRepo(app, u.value, { name: "engine", visibility: "private" });
  if (!made.ok) throw new Error(String(made.error));
  const repo = made.value;
  const seeded = await commitToBranch(app, u.value, repo, {
    message: "Start",
    files: [{ path: "README.md", content: "# engine\n" }],
  });
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  const branch = await commitToBranch(app, u.value, repo, {
    branch: "mason/4-start",
    base: "main",
    message: "Work",
    files: [{ path: "a.ts", content: "export const a = 1;\n" }],
  });
  if (!branch.ok) throw new Error(JSON.stringify(branch.error));
  const pull = await openPull(app, u.value, repo, {
    title: "Work",
    body: "Closes #4",
    baseBranch: "main",
    headBranch: "mason/4-start",
  });
  if (!pull.ok) throw new Error(String(pull.error));
  const number = pull.value.number;

  expect(freshPulls(app.db, repo.id)).toEqual([{ number, headBranch: "mason/4-start" }]);
  expect(freshPullFor(app.db, repo.id, 4, ["mason"])).toEqual({ number });
  expect(freshPulls(app.db, repo.id, Date.now() + BUILD_SETTLE_MS + 1000)).toEqual([]);
  expect(freshPulls(app.db, "no-such-repo")).toEqual([]);

  const plan = app.db
    .query<{ detail: string }, [string, string]>(`EXPLAIN QUERY PLAN ${FRESH_PULLS_SQL}`)
    .all(repo.id, "2000")
    .map((r) => r.detail)
    .join("\n");
  expect(plan).toContain("issue_created");
});
