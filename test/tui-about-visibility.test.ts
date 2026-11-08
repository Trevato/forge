/**
 * Visibility at the terminal's door (#8008): on the About card, an admin who
 * is a person makes the repository private or public with `V`, and only the
 * confirm (Cancel selected first) changes it. A writer who is not an admin and
 * an agent admin are not offered it.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createAgent } from "../src/actions/crew.ts";
import { addTeamMember, createOrg, createTeam } from "../src/core/orgs.ts";
import { canAdmin, canWrite, createRepo, getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import type { Ctx, Screen } from "../src/tui/app/app.ts";
import { aboutScreen } from "../src/tui/screens/about.ts";
import { Screen as Surface } from "../src/tui/term/screen.ts";
import { theme } from "../src/tui/ui/theme.ts";
import { localSource } from "../src/view/local.ts";
import type { Session } from "../src/tui/session.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let founder: User;
let writer: User;
let bot: User;
let repo: Repo;
let botRepo: Repo;

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};
async function until(what: string, done: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

function card(user: User, target: Repo = repo) {
  const pushed: Screen[] = [];
  const toasts: string[] = [];
  const ctx = {
    theme: theme("dark"),
    invalidate() {},
    toast: (t: string) => toasts.push(t),
    push: (s: Screen) => pushed.push(s),
    pop() {},
    copy() {},
    hit() {},
  } as unknown as Ctx;
  const f = { app, db: app.db, user } as unknown as Session;
  const src = localSource(app, getRepoById(app.db, target.id)!, user);
  const screen = aboutScreen(f, ctx, { render() {} } as unknown as Screen, src, undefined, "main");
  const label = (key: string) => screen.keys.find((b) => b.keys.includes(key))?.help;
  const press = (key: string) => screen.key!({ key } as never);
  return { pushed, toasts, label, press };
}
const visibility = () => getRepoById(app.db, repo.id)!.visibility;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-tui-visibility-"));
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
  const root = await make("founding", true);
  founder = await make("founder");
  writer = await make("writer");
  const org = ok(createOrg(app.db, "acme", founder.id));
  ok(await createRepo(app.db, app.reposRoot, { ownerId: org.id, name: "site", visibility: "public" }));
  repo = getRepoById(app.db, (app.db.query("SELECT id FROM repo WHERE name = 'site'").get() as { id: string }).id)!;
  addTeamMember(app.db, ok(createTeam(app.db, org.id, "Writers", "write")), writer.id);
  bot = ok(await createAgent(app, root, { username: "bot" })).user;
  // An agent never sits on an admin team; it administers what it owns.
  botRepo = ok(await createRepo(app.db, app.reposRoot, { ownerId: bot.id, name: "own", visibility: "public" }));
}, 30_000);

afterAll(async () => {
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("an admin makes a public repository private with V then confirm, and public again", async () => {
  const c = card(founder);
  expect(c.label("V")).toBe("make private");
  c.press("V");
  expect(c.pushed).toHaveLength(1);
  const confirm = c.pushed[0]!;
  // Cancel is selected first: enter alone changes nothing.
  confirm.key!({ key: "enter" } as never);
  await Bun.sleep(20);
  expect(visibility()).toBe("public");

  c.press("V");
  c.pushed[1]!.key!({ key: "left" } as never);
  c.pushed[1]!.key!({ key: "enter" } as never);
  await until("private", () => visibility() === "private");
  await until("the toast", () => c.toasts.includes("now private"));
  expect(c.label("V")).toBe("make public");

  c.press("V");
  c.pushed[2]!.key!({ key: "left" } as never);
  c.pushed[2]!.key!({ key: "enter" } as never);
  await until("public", () => visibility() === "public");
  expect(c.toasts).toContain("now public");
});

test("a writer who is not an admin and an agent admin are not offered V, and it does nothing", async () => {
  const fresh = getRepoById(app.db, repo.id)!;
  expect(canWrite(app.db, fresh, writer)).toBe(true);
  expect(canAdmin(app.db, fresh, writer)).toBe(false);
  expect(canAdmin(app.db, botRepo, bot)).toBe(true);
  for (const [who, at] of [[writer, repo], [bot, botRepo]] as const) {
    const c = card(who, at);
    expect(c.label("V")).toBeUndefined();
    c.press("V");
    expect(c.pushed).toHaveLength(0);
  }
  expect(visibility()).toBe("public");
  expect(getRepoById(app.db, botRepo.id)!.visibility).toBe("public");
});

test("the confirm says who will see it", () => {
  const c = card(founder);
  c.press("V");
  const s = new Surface(160, 30);
  c.pushed[0]!.render({ x: 0, y: 0, w: 160, h: 30 }, s);
  const text = s.toText();
  expect(c.pushed[0]!.title).toBe("Make private");
  // The sentence wraps inside the dialog: each of its lines is drawn whole.
  for (const line of [
    "Make acme/site private? Only its members and the",
    "crew can read it from now on; forks and clones",
    "already made keep what they have.",
  ])
    expect(text).toContain(line);
});

test("a sealed report is refused public, says why, and stays private", async () => {
  const sealed = ok(await createRepo(app.db, app.reposRoot, { ownerId: founder.id, name: "report", visibility: "private" }));
  app.db.query("UPDATE repo SET sealed_for = ?1 WHERE id = ?2").run(repo.id, sealed.id);
  const c = card(founder, sealed);
  expect(c.label("V")).toBe("make public");
  c.press("V");
  c.pushed[0]!.key!({ key: "left" } as never);
  c.pushed[0]!.key!({ key: "enter" } as never);
  await until("the refusal", () => c.toasts.length > 0);
  expect(c.toasts).toEqual(["a sealed report stays private until it merges"]);
  expect(getRepoById(app.db, sealed.id)!.visibility).toBe("private");
});
