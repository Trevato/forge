/**
 * Home is the living pipeline (#8015): the box, the figures, the pipeline in
 * four words, what is being built and what just shipped (each row a link),
 * your apps; the feed is its own page. Rows are read for the viewer.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createIssue } from "../src/core/issues.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import type { PipelineStage } from "../src/flow/pipeline.ts";
import { nowOf } from "../src/flow/moving.ts";


import { promote } from "./helpers/members.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { dashboardScreen } from "../src/tui/screens/dashboard.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let alice: User;
let bob: User;
let aliceCookie: string;
let root: User;
let openRepoId: string;
let secretRepoId: string;

const get = (path: string, cookie?: string) => fetch(`${servers.url}${path}`, { headers: cookie ? { cookie } : {}, redirect: "manual" });
const home = async (cookie?: string) => (await get("/", cookie)).text();

/** The terminal's home, as the viewer's session draws it. */
async function terminalHome(user: User): Promise<string> {
  const { app: tui, session } = createForgeApp(
    app,
    { sshUsername: user.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user },
    { terminal: headlessTerminal(200, 40), exitHooks: false },
  );
  tui.start();
  tui.ctx.push(dashboardScreen(session, tui.ctx));
  await settleApp(tui);
  const text = tui.screen.toText();
  tui.stop?.();
  return text;
}

function building(repoId: string, title: string) {
  const made = createIssue(app.db, { repoId, authorId: alice.id, title, kind: "issue" });
  if (!made.ok) throw new Error(made.error);
  app.db
    .query("INSERT INTO run (id, repo_id, kind, issue_id, commit_oid, state, actor_id, started_at) VALUES (?, ?, 'agent', ?, 'c', 'running', ?, ?)")
    .run(`zzzz-${crypto.randomUUID()}`, repoId, made.value.id, alice.id, new Date().toISOString());
  return made.value;
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-home-living-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const mk = async (username: string, first = false) => {
    const r = await createUser(app.db, { origin: "seed", trusted: true, username, allowReserved: true, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first });
    if (!r.ok) throw new Error(r.error);
    promote(app.db, r.value);
    return r.value;
  };
  root = await mk("root", true);
  alice = await mk("alice");
  bob = await mk("bob");
  aliceCookie = `forge_session=${createSession(app.db, alice.id).token}`;
  const open = await createRepo(app, alice, { name: "open", visibility: "public" });
  const secret = await createRepo(app, alice, { name: "secret", visibility: "private" });
  if (!open.ok || !secret.ok) throw new Error("repos");
  openRepoId = open.value.id;
  secretRepoId = secret.value.id;
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("home", () => {

  test("the terminal home carries the same lines: Now for a site admin, being built and just shipped as the viewer reads them", async () => {
    building(openRepoId, "Terminal build");
    building(secretRepoId, "Terminal secret");
    const mine = await terminalHome(alice);
    expect(mine).toContain("Being built");
    expect(mine).toContain("Just shipped");
    expect(mine).toContain("Terminal build");
    expect(mine).not.toContain("Now  check");
    const theirs = await terminalHome(bob);
    expect(theirs).toContain("Being built");
    expect(theirs).not.toContain("Terminal secret");
    expect(await terminalHome(root)).toMatch(/Now {2}check \d+ › review \d+ › land \d+ › \d+ live/);
  });

  test("a stranger gets the door, not the box", async () => {
    const page = await home();
    expect(page).not.toContain('id="tell-box"');
    expect(page).not.toContain("Being built");
  });
});

describe("the pipeline in four words", () => {
  const stage = (key: PipelineStage["key"], waiting: number, active: number) => ({ key, waiting, active }) as PipelineStage;
  test("each word is the sum of the boards' stages it names", () => {
    const now = nowOf([stage("check-queue", 4, 0), stage("checking", 0, 6), stage("review", 1, 0), stage("approved", 3, 0), stage("live", 0, 0), stage("ready", 9, 9)]);
    expect(now).toEqual({ check: 10, review: 1, land: 3, live: 0 });
  });
});

describe("the feed page", () => {
  test("holds the composer and the timeline; a stranger is sent to sign in", async () => {
    const page = await (await get("/feed", aliceCookie)).text();
    expect(page).toContain('id="composer"');
    expect(page).toContain('id="live-feed"');
    expect(page).not.toContain("Being built");
    const stranger = await get("/feed");
    expect(stranger.status).not.toBe(200);
  });
});

describe("home, calm pass (#10298)", () => {
});
