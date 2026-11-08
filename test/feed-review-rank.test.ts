/** A changes-asked review post ranks above an approval of the same age (#6469). */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openPull, submitReview } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { affinityFor } from "../src/feed/affinity.ts";
import { candidatesFor } from "../src/feed/items.ts";
import { rank } from "../src/feed/rank.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir = "";
let app: App;
let alice: User;
let repo: Repo;
let n = 0;

const pull = async (title: string) => {
  n++;
  await commitToBranch(app, alice, repo, {
    branch: `bot/${n}`,
    base: "main",
    message: title,
    files: [{ path: `F${n}.md`, content: `${n}\n` }],
  });
  const opened = await openPull(app, getUserByName(app.db, "bot")!, repo, {
    title,
    body: "",
    baseBranch: "main",
    headBranch: `bot/${n}`,
  });
  if (!opened.ok) throw new Error(String(opened.error));
  return opened.value;
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-feed-review-rank-"));
  app = createApp({ dataDir, port: 0 });
  const a = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-long-review-rank-passphrase",
    adminIfFirst: true,
  });
  if (!a.ok) throw new Error(a.error);
  alice = a.value;
  await createAgent(app, alice, { username: "bot" });
  const made = await createRepo(app, alice, { name: "site", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  repo = made.value;
  await commitToBranch(app, alice, repo, {
    message: "seed",
    files: [{ path: "README.md", content: "# site\n" }],
  });
  addToCrew(app, alice, repo, "bot");
}, 30_000);

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

test("at the same instant, asking for changes ranks above approving, whichever came first", async () => {
  const ok = await pull("Tidy the footer");
  const bad = await pull("Widen the board");
  expect(
    (await submitReview(app, alice, repo, bad, { state: "changes_requested", body: "Keep the column." })).ok,
  ).toBe(true);
  expect((await submitReview(app, alice, repo, ok, { state: "approved" })).ok).toBe(true);
  // Same age: pin every review event to one instant.
  const at = new Date().toISOString();
  app.db.run("UPDATE event SET created_at = ?1 WHERE kind = 'pull.reviewed'", [at]);

  const now = Date.now();
  const items = rank(candidatesFor(app.db, alice, now), affinityFor(app.db, alice, now), now);
  const order = items
    .map((i) => i.what.split(" · ")[0]!)
    .filter((w) => w.startsWith("approved ") || w.startsWith("asked for changes"));
  expect(order).toEqual([
    "asked for changes on Widen the board: Keep the column.",
    "approved Tidy the footer",
  ]);
});
