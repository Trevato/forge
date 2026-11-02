/**
 * Detach at the terminal's door (#7452): on a fork's About, an admin's `x`
 * shows the plan, and only the confirm detaches; the card's row says the
 * phase. A reader and an agent are not offered it, and an archived parent
 * offers no `o`.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { detachJob } from "../src/actions/detach.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { commitToBranch, updateRepoSettings } from "../src/actions/repos.ts";
import { createRepo, forkRepo, getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { hasAlternates, repoDir } from "../src/git/repos.ts";
import type { Ctx, Screen } from "../src/tui/app/app.ts";
import { aboutScreen, detachRows } from "../src/tui/screens/about.ts";
import { localSource } from "../src/view/local.ts";
import type { Session } from "../src/tui/session.ts";
import { Screen as Surface } from "../src/tui/term/screen.ts";
import { theme } from "../src/tui/ui/theme.ts";
import { detachFromParent } from "../src/actions/detach.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let upstreamer: User;
let forker: User;
let reader: User;
let bot: User;
let parent: Repo;
let fork: Repo;

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};
/** Poll for what the test checks; fail clearly at the deadline. */
async function until(what: string, done: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

function card(user: User, target: Repo = fork) {
  const pushed: Screen[] = [];
  const ctx = {
    theme: theme("dark"),
    invalidate() {},
    toast() {},
    push: (s: Screen) => pushed.push(s),
    pop() {},
    copy() {},
  } as unknown as Ctx;
  const f = { app, db: app.db, user } as unknown as Session;
  const src = localSource(app, getRepoById(app.db, target.id)!, user);
  const screen = aboutScreen(f, ctx, { render() {} } as unknown as Screen, src, undefined, "main");
  const offered = (key: string) => screen.keys.some((b) => b.keys.includes(key));
  const press = (key: string) => screen.key!({ key } as never);
  const draw = (): string => {
    const s = new Surface(110, 40);
    screen.render({ x: 0, y: 0, w: 110, h: 40 }, s);
    return s.toText();
  };
  return { pushed, offered, press, draw };
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-tui-detach-"));
  app = createApp({ dataDir, port: 0 });
  const make = async (username: string, adminIfFirst = false) =>
    ok(
      await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst,
      }),
    );
  // The site admin only makes the agent; a site admin reads everything.
  const root = await make("founder", true);
  upstreamer = await make("upstreamer");
  forker = await make("forker");
  reader = await make("reader");
  parent = ok(await createRepo(app.db, app.reposRoot, { ownerId: upstreamer.id, name: "up", visibility: "public" }));
  ok(await commitToBranch(app, upstreamer, parent, { message: "one", files: [{ path: "a.txt", content: "a\n" }] }));
  fork = ok(await forkRepo(app.db, app.reposRoot, parent, forker.id, "down"));
  ok(await commitToBranch(app, forker, fork, { message: "two", files: [{ path: "b.txt", content: "b\n" }] }));
  const agent = ok(await createAgent(app, root, { username: "bot" }));
  expect(addToCrew(app, root, fork, "bot").ok).toBe(true);
  bot = agent.user;
}, 30_000);

afterAll(async () => {
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a reader and an agent are not offered x, and it does nothing", async () => {
  for (const who of [reader, bot]) {
    const c = card(who);
    expect(c.offered("x")).toBe(false);
    c.press("x");
    expect(c.pushed).toHaveLength(0);
  }
  expect(getRepoById(app.db, fork.id)!.forkParentId).toBe(parent.id);
});

test("an archived parent offers no o, and x plans, confirms, then detaches", async () => {
  ok(await updateRepoSettings(app, upstreamer, parent, { archived: true }));
  // Against an archived parent the drift is never read, so no offer can
  // arrive later: the keys are final as drawn.
  const c = card(forker);
  expect(c.offered("o")).toBe(false);
  expect(c.offered("x")).toBe(true);

  // Cancel changes nothing.
  c.press("x");
  await until("the plan", () => c.pushed.length === 1);
  c.pushed[0]!.key!({ key: "esc" } as never);
  expect(detachJob(fork.id)).toBeUndefined();

  c.press("x");
  await until("the plan again", () => c.pushed.length === 2);
  expect(c.pushed[1]!.title).toBe("Detach from parent");
  c.pushed[1]!.key!({ key: "enter" } as never);
  // The repack may land between two polls, so wait for the outcome, not
  // for the job to be seen running (the next test reads the running row).
  await until("the detach to land", () => getRepoById(app.db, fork.id)!.forkParentId === null, 20_000);
  expect(detachJob(fork.id)).toBeUndefined();
  expect(await hasAlternates(repoDir(app.reposRoot, fork.ownerName, fork.name))).toBe(false);
  expect(detachRows(getRepoById(app.db, fork.id))).toEqual([]);
  // Once detached, there is nothing to detach from.
  expect(card(forker).offered("x")).toBe(false);
}, 30_000);

test("the phase row is the admin's: a reader's About has none while a detach runs", async () => {
  const side = ok(await forkRepo(app.db, app.reposRoot, parent, forker.id, "side"));
  ok(await detachFromParent(app, forker, side, false));
  expect(detachJob(side.id)?.phase).toBe("repacking");
  // Drawn before the repack can land: the admin sees the phase, a reader does not.
  const admin = card(forker, side).draw();
  const guest = card(reader, side).draw();
  await detachJob(side.id)?.done;
  expect(admin).toMatch(/detach +repacking, started/);
  expect(guest).toContain("clone (http)");
  expect(guest).not.toMatch(/detach +(repacking|stopped)/);
}, 30_000);

