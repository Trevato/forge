/**
 * A stranger's pull says what happens next in the home page's language
 * (#10004): a plain headed section with its sentences, no card box. Only a
 * person who can write the repository is offered "Approve this guest".
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo, forkRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { markVerified } from "../src/core/verify.ts";
import { strangerNext } from "../src/crew/stranger.ts";
import { forgeHttp, type ForgeHttp } from "../src/http/server.ts";
import { approveGuest } from "../src/origins/guest.ts";
import { setLimit } from "../src/settings/limits.ts";
import { GUEST_WAITS } from "../src/web/pages/pull-guest.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const url = "http://forge.test";
let dataDir = "";
let app: App;
let http: ForgeHttp;
let owner: User;
let author: User;
let lib: Repo;
let fork: Repo;
let n = 0;

async function person(username: string, first = false): Promise<User> {
  const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@test.dev`, password: "correct-horse-battery", adminIfFirst: first });
  if (!made.ok) throw new Error(made.error);
  markVerified(app.db, made.value.id, new Date().toISOString());
  app.db.query("UPDATE user SET created_at = ?1 WHERE id = ?2").run("2026-01-01T00:00:00.000Z", made.value.id);
  return getUserByName(app.db, username)!;
}

/** A new pull by the stranger from their fork of `lib`. */
async function strangerPull(): Promise<Pull> {
  const branch = `change${++n}`;
  const committed = await commitToBranch(app, author, fork, { branch, base: "main", message: "Change", files: [{ path: `src/${branch}.ts`, content: "export {};\n" }] });
  if (!committed.ok) throw new Error(JSON.stringify(committed.error));
  const opened = await openPull(app, author, lib, { title: "A change", body: "", baseBranch: "main", headBranch: branch, headRepo: fork });
  if (!opened.ok) throw new Error(String(opened.error));
  return getPull(app.db, lib.id, opened.value.number)!;
}

/** The notice's section on `user`'s view of `pull`: from its `<section` to its `</section>`. */
async function section(user: User, pull: Pull, heading: string): Promise<string> {
  const res = await http.handle(
    new Request(`${url}/${lib.ownerName}/${lib.name}/pulls/${pull.number}`, {
      headers: { cookie: `forge_session=${createSession(app.db, user.id).token}` },
    }),
  );
  const page = await res.text();
  const at = page.indexOf(`<h2>${heading}</h2>`);
  expect(at).toBeGreaterThan(0);
  return page.slice(page.lastIndexOf("<section", at), page.indexOf("</section>", at));
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-pull-guest-lang-"));
  app = createApp({ dataDir, port: 0, host: "forge.test" });
  http = forgeHttp(app);
  owner = await person("olive", true);
  for (const [key, value] of [
    ["signup.per_source", 1000],
    ["guest.forks_per_day", 1000],
    ["guest.forks_forge_per_day", 1000],
    ["guest.pulls_per_day", 1000],
  ] as const)
    setLimit(app.db, key, value, "setup");
  const made = await createRepo(app, owner, { name: "lib", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  const seeded = await commitToBranch(app, owner, made.value, { message: "Start", files: [{ path: "README.md", content: "hi\n" }] });
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  lib = getRepoById(app.db, made.value.id)!;
  author = await person("stranger");
  const forked = await forkRepo(app, author, lib);
  if (!forked.ok) throw new Error(String(forked.error));
  fork = forked.value;
}, 60_000);

afterAll(async () => {
  http.close();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a waiting guest's pull is a plain section; only the writer is offered Approve", async () => {
  const pull = await strangerPull();
  const sentence = strangerNext(lib, []);
  for (const user of [owner, author]) {
    const block = await section(user, pull, "A guest");
    expect(block).toContain('class="settings-block');
    expect(block).not.toContain('class="card');
    expect(block).toContain(GUEST_WAITS.slice(0, 40));
    expect(block).toContain(sentence.slice(0, 40));
  }
  const writer = await section(owner, pull, "A guest");
  expect(writer).toContain("Approve this guest");
  expect(writer).toContain(`action="/olive/lib/pulls/${pull.number}/approve-guest"`);
  expect(writer).toMatch(/<form class="mt" method="post"/);
  expect(await section(author, pull, "A guest")).not.toContain("Approve this guest");
}, 30_000);

test("an approved stranger's pull says what happens next under its heading, no card, no Approve", async () => {
  const pull = await strangerPull();
  expect(approveGuest(app.db, lib, pull, owner).ok).toBe(true);
  const sentence = strangerNext(lib, []);
  for (const user of [owner, author]) {
    const block = await section(user, pull, "What happens next");
    expect(block).toContain('class="settings-block');
    expect(block).not.toContain('class="card');
    expect(block).toContain(sentence.slice(0, 40));
    expect(block).not.toContain("Approve this guest");
  }
}, 30_000);
