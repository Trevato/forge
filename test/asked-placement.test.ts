/** On /asked each thought says where it went (#7509): the issue, a note, or not yet, and what it repeats. */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createIssue } from "../src/core/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { placementsOf, savePlacement, type Placed } from "../src/core/placements.ts";
import { linkThoughts } from "../src/core/thought_links.ts";
import { serve } from "../src/http/server.ts";
import { createUser, type User } from "../src/core/users.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";

quietLogs();

let dir = "";
let app: App;
let alice: User;
let bob: User;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "asked-placement-"));
  app = createApp({ dataDir: dir, port: 0 });
  const mk = async (username: string, first = false) => {
    const u = await createUser(app.db, {
      origin: "seed", trusted: true, username, email: `${username}@forge.local`,
      password: "a-good-passphrase", adminIfFirst: first,
    });
    if (!u.ok) throw new Error(u.error);
    promote(app.db, u.value);
    return u.value;
  };
  bob = await mk("bob", true); // the forge's admin, first
  alice = await mk("alice");
});
afterAll(async () => {
  app.db.close();
  await rm(dir, { recursive: true, force: true });
});

const think = (id: string, who: User, text: string, minutesAgo: number) =>
  app.db
    .query("INSERT INTO thought (id, author, text, source, received_at) VALUES (?1, ?2, ?3, 'composer', ?4)")
    .run(id, who.id, text, new Date(Date.now() - minutesAgo * 60_000).toISOString());
const place = (thoughtId: string, placed: Placed[], reply = { text: "ok", asked: false }) =>
  savePlacement(app.db, {
    thoughtId, kind: placed.length > 0 ? "work" : "decision", placed, reply: reply.text, asked: reply.asked,
    decidedBy: "rule", placedAt: new Date().toISOString(),
  });

async function askedAs(user: string): Promise<string> {
  const servers = await serve(app);
  try {
    const signin = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username: user, password: "a-good-passphrase" }),
      redirect: "manual",
    });
    const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
    const res = await fetch(`${servers.url}/asked`, { headers: { cookie } });
    expect(res.status).toBe(200);
    return (await res.text()).replace(/\s+/g, " ");
  } finally {
    servers.stop();
  }
}

test("a placed thought links its issue, a repeat says what it repeats, a note and a waiting one say so", async () => {
  const made = await createRepo(app, alice, { name: "gauges" });
  if (!made.ok) throw new Error(String(made.error));
  const issue = openIssue(app, alice, made.value, { title: "Queue <depth> gauge" });
  if (!issue.ok) throw new Error(String(issue.error));
  const n = issue.value.number;

  think("t-first", alice, "build a gauge for queue depth on the board please", 30);
  think("t-again", alice, "a queue depth gauge, again", 20);
  think("t-note", alice, "we prefer plain words", 10);
  think("t-wait", alice, "and a dark theme", 5);
  place("t-first", [{ action: "opened", repo: "alice/gauges", number: n }]);
  place("t-again", []);
  linkThoughts(app.db, "t-again", "t-first", "repeats");
  place("t-note", []);

  const page = await askedAs("alice");
  expect(page).toContain(`→ <a href="/alice/gauges/issues/${n}">alice/gauges#${n} Queue &lt;depth&gt; gauge</a>`);
  expect(page).toContain("repeats “build a gauge for queue depth on the board please”");
  expect(page).toContain("kept as a note");
  expect(page).toContain("not placed yet");

  // Only the author's own thoughts carry this.
  const other = await askedAs("bob");
  expect(other).not.toContain("alice/gauges#");
  expect(other).not.toContain("kept as a note");
});

test("a question back stays visible, a proposed pull links to /pulls, an unreadable repository names nothing", async () => {
  const vault = await createRepo(app, bob, { name: "vault", visibility: "private" });
  if (!vault.ok) throw new Error(String(vault.error));
  const sealed = openIssue(app, bob, vault.value, { title: "Bob's sealed plan" });
  if (!sealed.ok) throw new Error(String(sealed.error));
  const repo = await createRepo(app, alice, { name: "visions" });
  if (!repo.ok) throw new Error(String(repo.error));
  const pull = createIssue(app.db, { repoId: repo.value.id, authorId: alice.id, kind: "pull", title: "A vision for gauges" });
  if (!pull.ok) throw new Error(String(pull.error));
  const p = pull.value.number;

  think("t-question", alice, "the thing from before", 4);
  think("t-vision", alice, "gauges everywhere", 3);
  think("t-hidden", alice, "the vault, too", 2);
  place("t-question", [], { text: "Which thing do you mean — the gauge or the theme?", asked: true });
  place("t-vision", [{ action: "proposed", repo: "alice/visions", number: p, pull: p }]);
  place("t-hidden", [{ action: "opened", repo: "bob/vault", number: sealed.value.number }]);

  const page = await askedAs("alice");
  expect(page).toContain("Which thing do you mean — the gauge or the theme?");
  expect(page).toContain(`→ proposed <a href="/alice/visions/pulls/${p}">alice/visions#${p} A vision for gauges</a>`);
  expect(page).toContain("→ in a repository you cannot read");
  expect(page).not.toContain("bob/vault");
  expect(page).not.toContain("sealed plan");
});

test("the page's placements are read in one batch", () => {
  const got = placementsOf(app.db, ["t-first", "t-note", "t-wait", "t-first"]);
  expect([...got.keys()].sort()).toEqual(["t-first", "t-note"]);
  expect(got.get("t-first")!.placed[0]!.repo).toBe("alice/gauges");
});
