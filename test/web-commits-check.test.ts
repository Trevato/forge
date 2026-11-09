/** The web commits page marks each commit's check beside it; a commit's own page says why. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { createRun, finishRun } from "../src/core/runs.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import type { CommitCheck } from "../src/checks/commit_check.ts";
import { checkSentence } from "../src/web/pages/commits.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { local } from "../src/tui/screens/where.ts";
import { Session } from "../src/tui/session.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir: string;
let app: App;
let servers: Servers;
let alice: User;
const oids: Record<string, string> = {};
const runs: Record<string, string> = {};
let ownerCookie = "";
let bobCookie = "";
const repos: Record<string, Repo> = {};

function check(r: Repo, oid: string, state: "ok" | "failed", summary: string): string {
  const run = createRun(app.db, { repoId: r.id, kind: "check", env: r.defaultBranch, commitOid: oid });
  app.db.query("UPDATE run SET state = 'running' WHERE id = ?1").run(run.id);
  finishRun(app.db, run.id, { state, summary });
  return run.id;
}

async function seed(name: string, visibility: "public" | "private") {
  const made = await createRepo(app, alice, { name, visibility });
  if (!made.ok) throw new Error("repo creation failed");
  const r = getRepo(app.db, "alice", name)!;
  repos[name] = r;
  for (const n of ["green", "red", "none"]) {
    const c = await commitToBranch(app, alice, r, {
      message: `${n} change`,
      files: [{ path: `${n}.txt`, content: `${n}\n` }],
    });
    if (!c.ok) throw new Error("commit failed");
    const s = new Session(app, { sshUsername: "t", remoteAddress: "127.0.0.1", user: alice });
    const log = await local(s, r).commits(r.defaultBranch);
    if (!log.ok) throw new Error("log failed");
    oids[`${name}/${n}`] = log.value.items[0]!.oid;
  }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-web-commits-check-"));
  app = createApp({ dataDir: dir, port: 0 });
  const a = await seedAdmin(app, { username: "alice", email: "alice@forge.test", password: "a-long-passphrase" });
  if (!a.ok) throw new Error("signup failed");
  alice = a.value;
  servers = await serve(app);
  await seed("pub", "public");
  runs.green = check(repos.pub!, oids["pub/green"]!, "ok", "");
  runs.red = check(repos.pub!, oids["pub/red"]!, "failed", "step typecheck failed");
  await seed("priv", "private");
  runs.priv = check(repos.priv!, oids["priv/red"]!, "failed", "step secret failed");
  const bob = await createUser(app.db, { username: "bob", email: "bob@forge.test", password: "a-long-passphrase", origin: "seed", trusted: true });
  if (!bob.ok) throw new Error("bob failed");
  ownerCookie = `forge_session=${createSession(app.db, alice.id).token}`;
  bobCookie = `forge_session=${createSession(app.db, bob.value.id).token}`;
}, 120_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

/**
 * Signed in as the owner unless `null` asks for a stranger: a stranger's deep
 * pages are budgeted per address (`http/crawl.ts`), a quarter of it while a
 * busy shard runs the loop late, and these tests are about markup, not that.
 */
const get = async (path: string, cookie: string | null = ownerCookie) =>
  (await fetch(`${servers.url}${path}`, { headers: cookie !== null ? { cookie } : {} })).text();

const rowOf = (page: string, subject: string): string =>
  (page.split("<li>").find((l) => l.includes(subject)) ?? "").split("</li>")[0]!;

test("the list shows green and red as plain badges, and nothing without a check", async () => {
  const page = await get("/alice/pub/commits");
  const green = rowOf(page, "green change");
  const red = rowOf(page, "red change");
  const none = rowOf(page, "none change");
  expect(green).toContain("Passed");
  expect(red).toContain("Failed");
  expect(green).not.toContain("/runs/");
  expect(red).not.toContain("/runs/");
  expect(none).not.toContain("/runs/");
  expect(none).not.toContain("badge");
});

test("a commit's page says the verdict and names the failing step", async () => {
  const red = await get(`/alice/pub/commit/${oids["pub/red"]}`);
  expect(red).toContain("The check failed");
  expect(red).toContain("first failing step typecheck failed");
  expect(red).toContain(`href="/alice/pub/runs/${runs.red}"`);
  const green = await get(`/alice/pub/commit/${oids["pub/green"]}`);
  expect(green).toContain("The check passed");
  const none = await get(`/alice/pub/commit/${oids["pub/none"]}`);
  expect(none).not.toContain("The check");
});

test("every row of the list is reachable by keyboard, checked or not", async () => {
  const page = await get("/alice/pub/commits");
  const rows = page.split("<li>").slice(1).map((l) => l.split("</li>")[0]!).filter((l) => l.includes('class="row"'));
  expect(rows.length).toBe(3);
  for (const row of rows) expect(row).toMatch(/data-nav\s+tabindex="-1"/);
});

test("a private repository's verdict is the owner's alone", async () => {
  const list = "/alice/priv/commits";
  const one = `/alice/priv/commit/${oids["priv/red"]}`;
  for (const cookie of [null, bobCookie]) {
    expect(await get(list, cookie)).not.toContain(`/runs/${runs.priv}`);
    const seen = await get(one, cookie);
    expect(seen).not.toContain(`/runs/${runs.priv}`);
    expect(seen).not.toContain("step secret failed");
  }
  const mine = await get(list, ownerCookie);
  expect(mine).toContain("Failed");
  expect(await get(one, ownerCookie)).toContain("first failing step secret failed");
});

const sentence = (over: Partial<CommitCheck>): string =>
  checkSentence({ base: "/alice/pub" } as never, {
    commit: "a".repeat(40),
    checkedCommit: "a".repeat(40),
    state: "ok",
    runId: "run1",
    summary: "",
    finishedAt: null,
    ...over,
  }).toString();

test("the sentence names whose check answered, a running check and a superseded one", () => {
  const via = sentence({ checkedCommit: "b".repeat(40) });
  expect(via).toContain("the check of bbbbbbb, which contains it");
  expect(via).toContain("Passed");
  const running = sentence({ state: "pending" });
  expect(running).toContain("The check is running");
  expect(running).toContain("Running");
  const gone = sentence({ state: "superseded", runId: null });
  expect(gone).toContain("superseded");
  expect(gone).not.toContain("/runs/");
});

test("the list has no card markup and each row has exactly one anchor and no avatar", async () => {
  const page = await get("/alice/pub/commits");
  expect(page).not.toContain('class="card');
  const rows = page.split("<li>").slice(1).map((l) => l.split("</li>")[0]!).filter((l) => l.includes('class="row"'));
  expect(rows.length).toBe(3);
  for (const row of rows) {
    expect(row.match(/<a[\s>]/g)?.length).toBe(1);
    expect(row).not.toContain("avatar");
    expect(row).not.toContain("row-lead");
  }
});

test("a commit's page has no card and its check line follows the subject for green, red and not-run", async () => {
  for (const [n, said] of [["green", "The check passed"], ["red", "The check failed"], ["none", ""]] as const) {
    const one = await get(`/alice/pub/commit/${oids[`pub/${n}`]}`);
    expect(one).not.toContain('class="card');
    const afterSubject = one.slice(one.indexOf(`${n} change</h2>`));
    if (said === "") expect(one).not.toContain("The check");
    else {
      const at = afterSubject.indexOf(said);
      expect(at).toBeGreaterThan(0);
      expect(at).toBeLessThan(afterSubject.indexOf("committed"));
    }
  }
});
