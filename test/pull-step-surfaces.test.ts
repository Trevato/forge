/** The feed, the pulls list and /review each say which of check, review, land, live a pull is at (#7783); /review's is in review-page.test.ts. */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { readFeedPage } from "../src/feed/feed.ts";
import { stepOfStored } from "../src/flow/path.ts";
import type { Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASSWORD = "a-long-step-passphrase";

let dataDir = "";
let app: App;
let servers: Servers;
let alice: User;
let cookie = "";
let repo: Repo;
let pull: Pull;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-step-surfaces-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const a = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: PASSWORD,
    adminIfFirst: true,
  });
  if (!a.ok) throw new Error(a.error);
  alice = a.value;
  const res = await fetch(`${servers.url}/signin`, {
    method: "POST",
    body: new URLSearchParams({ username: "alice", password: PASSWORD }),
    redirect: "manual",
  });
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  await createAgent(app, alice, { username: "bot" });
  const made = await createRepo(app, alice, { name: "site", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  repo = made.value;
  await commitToBranch(app, alice, repo, { message: "seed", files: [{ path: "README.md", content: "# site\n" }] });
  addToCrew(app, alice, repo, "bot");
  await commitToBranch(app, alice, repo, {
    branch: "bot/1",
    base: "main",
    message: "Tidy",
    files: [{ path: "F.md", content: "1\n" }],
  });
  const opened = await openPull(app, getUserByName(app.db, "bot")!, repo, {
    title: "Tidy the footer",
    body: "",
    baseBranch: "main",
    headBranch: "bot/1",
  });
  if (!opened.ok) throw new Error(String(opened.error));
  pull = opened.value;
}, 30_000);

afterAll(async () => {
  await servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const squash = (s: string): string => s.replace(/\s+/g, " ");
const get = async (path: string): Promise<string> =>
  squash(await (await fetch(`${servers.url}${path}`, { headers: { cookie } })).text());

/** The step word linked to /pipeline, then the sentence from `stepOfStored`. */
function expected(): string {
  const step = stepOfStored(app.db, repo, pull)!;
  expect(step.step).toBe("review");
  return `data-step="review"><a href="/pipeline" title="${step.why}">Review</a> · ${step.why}`;
}

test("the feed's post for a pull says its step, linked to /pipeline", async () => {
  const item = readFeedPage(app.db, alice).items.find((i) => i.link === `/alice/site/pulls/${pull.number}`);
  expect(item?.step?.step).toBe("review");
  expect(await get("/feed")).toContain(expected());
});

test("the repository's pulls list leaves the step to the pull (#10415)", async () => {
  expect(await get("/alice/site/pulls")).not.toContain(expected());
  expect(await get(`/alice/site/pulls/${pull.number}`)).toContain('data-path="review"');
});

const openMore = async (r: Repo, by: User, name: string): Promise<Pull> => {
  await commitToBranch(app, alice, r, {
    branch: `more/${name}`,
    base: "main",
    message: name,
    files: [{ path: `${name}.md`, content: `${name}\n` }],
  });
  const opened = await openPull(app, by, r, { title: `Pull ${name}`, body: "", baseBranch: "main", headBranch: `more/${name}` });
  if (!opened.ok) throw new Error(String(opened.error));
  return opened.value;
};

test("a long list is scannable rows with no step beside them, and stays quick", async () => {
  for (let i = 0; i < 24; i++) await openMore(repo, alice, `long${i}`);
  const started = performance.now();
  const html = await get("/alice/site/pulls");
  const took = performance.now() - started;
  // The calm pass (#10415): a row is a title, a state word and a time; the step is on the pull.
  expect(html.match(/class="row-title"/g)?.length).toBeGreaterThanOrEqual(25);
  expect(html).not.toContain('data-step=');
  expect(took).toBeLessThan(500);
});

test("a pull closed without landing has no step, on the feed or the list", async () => {
  const gone = await openMore(repo, alice, "gone");
  app.db.query("UPDATE issue SET state = 'closed' WHERE id = ?1").run(gone.id);
  const item = readFeedPage(app.db, alice, { limit: 60 }).items.find((i) => i.link === `/alice/site/pulls/${gone.number}`);
  expect(item?.step).toBeUndefined();
  expect(await get(`/alice/site/pulls?state=closed`)).not.toContain('data-step=');
});

test("a post about a pull in a private repository carries a step for its readers only", async () => {
  const bob = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "bob",
    email: "bob@forge.local",
    password: PASSWORD,
  });
  if (!bob.ok) throw new Error(bob.error);
  const secret = await createRepo(app, alice, { name: "vault", visibility: "private" });
  if (!secret.ok) throw new Error(String(secret.error));
  await commitToBranch(app, alice, secret.value, { message: "seed", files: [{ path: "README.md", content: "# v\n" }] });
  const hidden = await openMore(secret.value, alice, "hidden");
  const link = `/alice/vault/pulls/${hidden.number}`;
  expect(readFeedPage(app.db, alice, { limit: 60 }).items.find((i) => i.link === link)?.step?.step).toBe("review");
  expect(readFeedPage(app.db, bob.value, { limit: 60 }).items.some((i) => i.link === link)).toBe(false);
});
