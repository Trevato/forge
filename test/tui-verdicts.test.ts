/**
 * The mark each row of the terminal's pull list wears for where it stands with
 * its reviewers (`src/tui/screens/verdicts.ts`): approved, changes asked,
 * nobody yet — and a page of them costs one query.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import type { Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { submitReview } from "../src/core/reviews.ts";
import type { User } from "../src/core/users.ts";
import { repoDir } from "../src/git/repos.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { issuesScreen } from "../src/tui/screens/issues.ts";
import { local } from "../src/tui/screens/where.ts";
import { VERDICT_MARKS } from "../src/tui/screens/common.ts";
import { verdictsForPulls } from "../src/tui/screens/verdicts.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { statements } from "./helpers/statements.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dataDir: string;
let forge: Forge;
let alice: User;
let repo: Repo;

async function pull(name: string): Promise<Pull> {
  const branch = await commitToBranch(forge, alice, repo, {
    branch: `feature/${name}`,
    base: "main",
    message: `Change ${name}`,
    files: [{ path: `${name}.ts`, content: `export const f = "${name}";\n` }],
  });
  if (!branch.ok) throw new Error(JSON.stringify(branch.error));
  const opened = await openPull(forge, alice, repo, {
    title: `Pull ${name}`,
    body: "",
    baseBranch: "main",
    headBranch: `feature/${name}`,
  });
  if (!opened.ok) throw new Error(String(opened.error));
  return opened.value;
}

const review = (p: Pull, state: "approved" | "changes_requested") => {
  const r = submitReview(forge.db, {
    issueId: p.id,
    authorId: alice.id,
    state,
    commitOid: p.headOid,
  });
  if (!r.ok) throw new Error(r.error);
};

const dir = () => repoDir(forge.reposRoot, "alice", "marks");

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-tui-verdicts-"));
  forge = createApp({ dataDir, port: 0 });
  const a = await seedAdmin(forge, {
    username: "alice",
    email: "alice@forge.test",
    password: "a-long-passphrase",
  });
  if (!a.ok) throw new Error("signup failed");
  alice = a.value;
  const r = await createRepo(forge, alice, { name: "marks", visibility: "public" });
  if (!r.ok) throw new Error("repo creation failed");
  repo = r.value;
  await commitToBranch(forge, alice, repo, {
    message: "seed",
    files: [{ path: "README.md", content: "# Marks\n" }],
  });
});

afterAll(async () => {
  forge.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("each row of the pull list wears the mark of where it stands", async () => {
  const good = await pull("good");
  const blocked = await pull("blocked");
  const unseen = await pull("unseen");
  review(good, "approved");
  review(blocked, "changes_requested");

  const terminal = headlessTerminal(120, 40);
  const { app, session } = createForgeApp(
    forge,
    { sshUsername: "alice", remoteAddress: "127.0.0.1", user: alice },
    { terminal, exitHooks: false },
  );
  app.start();
  await settleApp(app);
  app.push(issuesScreen(session, app.ctx, local(session, repo), "pull"));
  await settleApp(app);
  const lines = app.screen.toText().split("\n");
  const rowOf = (p: Pull) => {
    const line = lines.find((l) => l.includes(p.title));
    if (line === undefined) throw new Error(`no row for ${p.title}\n${lines.join("\n")}`);
    return line;
  };
  expect(rowOf(good)).toMatch(new RegExp(`${VERDICT_MARKS.approved}\\s+#${good.number}\\b`));
  expect(rowOf(blocked)).toMatch(new RegExp(`${VERDICT_MARKS.changes_requested}\\s+#${blocked.number}\\b`));
  expect(rowOf(unseen)).toMatch(new RegExp(`${VERDICT_MARKS.none}\\s+#${unseen.number}\\b`));
  app.stop();
});

test("an approval given before a later push no longer counts for the new head", async () => {
  const moving = await pull("moving");
  review(moving, "approved");
  const before = await verdictsForPulls(forge.db, dir(), repo.id, [moving.number]);
  expect(before.get(moving.number)).toBe("approved");

  const pushed = await commitToBranch(forge, alice, repo, {
    branch: "feature/moving",
    message: "Change moving again",
    files: [{ path: "moving.ts", content: 'export const f = "again";\n' }],
  });
  if (!pushed.ok) throw new Error(JSON.stringify(pushed.error));
  const after = await verdictsForPulls(forge.db, dir(), repo.id, [moving.number]);
  expect(after.get(moving.number)).toBe("none");
});

test("the marks for a page of 30 pulls come from one query", async () => {
  const numbers: number[] = [];
  for (let i = 0; i < 30; i++) {
    const p = await pull(`page${i}`);
    if (i % 3 === 0) review(p, "approved");
    else if (i % 3 === 1) review(p, "changes_requested");
    numbers.push(p.number);
  }
  let marks = new Map<number, string>();
  const cost = await statements(forge.db, async () => {
    marks = await verdictsForPulls(forge.db, dir(), repo.id, numbers);
  });
  expect(cost).toBe(1);
  expect(marks.get(numbers[0]!)).toBe("approved");
  expect(marks.get(numbers[1]!)).toBe("changes_requested");
  // Nobody reviewed it, so there is no row to report: absence reads as "none".
  expect(marks.get(numbers[2]!) ?? "none").toBe("none");
}, 60_000);
