/**
 * Outsiders at the terminal's door: the About card says who may direct the
 * crew; `d` plans, asks, and only then calls `setCrewOutsiders`.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, forkRepo } from "../src/actions/repos.ts";
import { setRole } from "../src/actions/roles.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { DIRECTION_NOTE, OUTSIDERS_NOTE } from "../src/crew/direct.ts";
import { addTeamMember, createOrg, createTeam, listTeams, OWNERS_TEAM } from "../src/core/orgs.ts";
import { createRepo, getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import type { Ctx, Screen } from "../src/tui/app/app.ts";
import { aboutScreen, outsidersRow } from "../src/tui/screens/about.ts";
import { localSource } from "../src/view/local.ts";
import type { Session } from "../src/tui/session.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let founder: User;
let dev: User;
let bot: User;
let repo: Repo;

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};
const line = (): string =>
  outsidersRow(getRepoById(app.db, repo.id)).map(([, v]) => v.trim()).join(" ");
/** Poll for what the test checks; fail clearly at the deadline. */
async function until(what: string, done: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

function card(user: User) {
  const pushed: Screen[] = [];
  const ctx = {
    invalidate() {},
    toast() {},
    push: (s: Screen) => pushed.push(s),
    pop() {},
    copy() {},
  } as unknown as Ctx;
  const f = { app, db: app.db, user } as unknown as Session;
  const src = localSource(app, getRepoById(app.db, repo.id)!, user);
  const screen = aboutScreen(f, ctx, {} as Screen, src, undefined, "main");
  const offered = () => screen.keys.some((b) => b.keys.includes("d"));
  const press = (key: string) => screen.key!({ key } as never);
  return { pushed, offered, press };
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-tui-outsiders-"));
  app = createApp({ dataDir, port: 0 });
  const make = async (username: string) =>
    ok(
      await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: true,
      }),
    );
  founder = await make("founder");
  dev = await make("dev");
  const org = ok(createOrg(app.db, "acme", founder.id));
  const writers = ok(createTeam(app.db, org.id, "Writers", "write"));
  addTeamMember(app.db, writers, dev.id);
  repo = ok(await createRepo(app.db, app.reposRoot, { ownerId: org.id, name: "svc", visibility: "public" }));
  const agent = ok(await createAgent(app, founder, { username: "bot" }));
  expect(addToCrew(app, founder, repo, "bot").ok).toBe(true);
  const owners = listTeams(app.db, org.id).find((t) => t.name === OWNERS_TEAM)!;
  addTeamMember(app.db, owners, agent.user.id);
  bot = agent.user;
}, 30_000);

afterAll(async () => {
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("the line reads off; d and confirm turn it on, and the row says so", async () => {
  const c = card(founder);
  expect(line()).toBe(DIRECTION_NOTE);
  expect(c.offered()).toBe(true);
  c.press("d");
  await until("the plan", () => c.pushed.length === 1);
  // The plan is shown before anything changes.
  expect(getRepoById(app.db, repo.id)!.crewOutsiders).toBe(false);
  c.pushed[0]!.key!({ key: "enter" } as never);
  await until("outsiders on", () => getRepoById(app.db, repo.id)!.crewOutsiders);
  expect(line()).toBe(OUTSIDERS_NOTE);
});

test("esc leaves it as it was", async () => {
  const c = card(founder);
  c.press("d");
  await until("the plan", () => c.pushed.length === 1);
  c.pushed[0]!.key!({ key: "esc" } as never);
  expect(getRepoById(app.db, repo.id)!.crewOutsiders).toBe(true);
});

test("a writer and an agent are not offered d and it does nothing", async () => {
  for (const who of [dev, bot]) {
    const c = card(who);
    expect(c.offered()).toBe(false);
    // Refused before anything async starts, so there is nothing to wait for.
    c.press("d");
    expect(c.pushed).toHaveLength(0);
    expect(getRepoById(app.db, repo.id)!.crewOutsiders).toBe(true);
  }
});

test("on a fork ahead of its parent d still reaches outsiders and o still opens the upstream offer", async () => {
  const parent = ok(
    await createRepo(app.db, app.reposRoot, { ownerId: founder.id, name: "up", visibility: "public" }),
  );
  ok(await commitToBranch(app, founder, parent, { message: "one", files: [{ path: "a.txt", content: "a\n" }] }));
  ok(setRole(app, founder, "dev", "member"));
  const fork = ok(await forkRepo(app, dev, parent));
  ok(await commitToBranch(app, dev, fork, { message: "two", files: [{ path: "b.txt", content: "b\n" }] }));
  const pushed: Screen[] = [];
  const ctx = {
    invalidate() {},
    toast() {},
    push: (s: Screen) => pushed.push(s),
    pop() {},
    copy() {},
  } as unknown as Ctx;
  const f = { app, db: app.db, user: dev } as unknown as Session;
  const src = localSource(app, getRepoById(app.db, fork.id)!, dev);
  const screen = aboutScreen(f, ctx, {} as Screen, src, undefined, "main");
  const has = (k: string) => screen.keys.some((b) => b.keys.includes(k));
  await until("the upstream offer", () => has("o"));
  expect(has("o")).toBe(true);
  expect(has("d")).toBe(true);
  screen.key!({ key: "o" } as never);
  expect(pushed).toHaveLength(1);
  expect(pushed[0]!.title).not.toBe("Outsiders");
  screen.key!({ key: "d" } as never);
  await until("the plan", () => pushed.length === 2);
  expect(pushed[1]!.title).toBe("Outsiders");
  expect(getRepoById(app.db, fork.id)!.crewOutsiders).toBe(false);
});
