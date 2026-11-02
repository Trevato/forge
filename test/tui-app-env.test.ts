/**
 * An app's variables in the terminal (#7232): an admin opens "Variables"
 * from the repository's `:` palette, sets one through a masked field and a
 * scope, sees its name and scope listed and never its value, and unsets it
 * after a confirm. A refusal reads in the settings page's words. A writer
 * who is not an admin is offered no entry. Every frame drawn on the way is
 * kept, and none of them holds the value.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newApp } from "../src/actions/apps.ts";
import { APP_ENV_ERRORS } from "../src/actions/app_env_words.ts";
import { createApp, type App } from "../src/app.ts";
import { listAppEnvNames } from "../src/core/app_env.ts";
import { getAppByRepo } from "../src/core/apps.ts";
import { listEvents } from "../src/core/events.ts";
import { addTeamMember, createOrg, createTeam } from "../src/core/orgs.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { repoScreen } from "../src/tui/screens/repo.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";
import { proveAll } from "./helpers/verified.ts";

quietLogs();

const SECRET = "sk_live_b4n4n4s";
const RIGHT = "\x1b[C";
const DOWN = "\x1b[B";

let dir: string;
let app: App;
let alice: User; // admin of acme, and so of the app
let bob: User; // writes to it through a team, administers nothing
let shop: Repo;
/** Every frame any session in this file drew, after every key. */
const frames: string[] = [];

const vars = () => listAppEnvNames(app.db, getAppByRepo(app.db, shop.id)!.id);

/** Open the repository as `user`, feed `keys` one chunk at a time, keep each frame. */
async function drive(user: User, keys: string[]): Promise<string> {
  const terminal = headlessTerminal(120, 40);
  const { app: tui, session } = createForgeApp(
    app,
    { sshUsername: user.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user },
    { terminal, exitHooks: false },
  );
  tui.start();
  tui.ctx.push(repoScreen(session, tui.ctx, local(session, shop)));
  await settleApp(tui);
  frames.push(tui.screen.toText());
  for (const k of keys) {
    terminal.feed(k);
    await settleApp(tui);
    frames.push(tui.screen.toText());
  }
  const text = tui.screen.toText();
  tui.stop?.();
  return text;
}

const open = [":", "Variables", "\r"];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-app-env-"));
  app = createApp({ dataDir: dir, port: 0 });
  const mk = async (username: string, first = false) => {
    const r = await createUser(app.db, {
      origin: "seed", trusted: true, username, email: `${username}@forge.local`,
      password: "a-good-passphrase", adminIfFirst: first,
    });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  alice = await mk("alice", true);
  bob = await mk("bob");
  proveAll(app);
  const org = createOrg(app.db, "acme", alice.id);
  if (!org.ok) throw new Error("org");
  const team = createTeam(app.db, org.value.id, "writers", "write");
  if (!team.ok) throw new Error("team");
  addTeamMember(app.db, team.value, bob.id);
  const made = await newApp(app, alice, { name: "shop", owner: "acme", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  shop = getRepo(app.db, "acme", "shop")!;
});
afterAll(async () => {
  app.db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("an app's variables, in the terminal", () => {
  test("an admin sets one: masked as it is typed, then listed by name and scope", async () => {
    const text = await drive(alice, [...open, "a", "STRIPE_KEY", "\r", SECRET, "\r", DOWN, "\r"]);
    expect(vars().map((v) => [v.name, v.scope])).toEqual([["STRIPE_KEY", "production"]]);
    expect(text).toContain("STRIPE_KEY is set for production.");
    expect(text).toContain("STRIPE_KEY");
    // The masked field drew one dot per character the moment it held the value.
    expect(frames.some((f) => f.includes("•".repeat(SECRET.length)))).toBe(true);
  });

  test("the list shows the name and scope, never the value", async () => {
    const text = await drive(alice, open);
    expect(text).toContain("Variables");
    expect(text).toContain("STRIPE_KEY");
    expect(text).toContain("production · set");
    expect(text).not.toContain(SECRET);
  });

  test("a bad name is refused in the page's words, and nothing is set", async () => {
    const text = await drive(alice, [...open, "a", "lower", "\r", SECRET, "\r", "\r"]);
    // The page's sentence wraps across the head; its start is on the screen.
    expect(text).toContain("A name is capital letters, digits and underscores");
    expect(APP_ENV_ERRORS["invalid_name"]).toStartWith("A name is capital letters, digits and underscores");
    expect(vars().map((v) => v.name)).toEqual(["STRIPE_KEY"]);
  });

  test("a value too long is refused in the page's words", async () => {
    const long = `\x1b[200~${"x".repeat(64 * 1024 + 1)}\x1b[201~`;
    const text = await drive(alice, [...open, "a", "TOO_LONG", "\r", long, "\r", "\r"]);
    expect(text).toContain(APP_ENV_ERRORS["invalid_value"]!);
    expect(vars().map((v) => v.name)).toEqual(["STRIPE_KEY"]);
  });

  test("unset asks first: keeping it changes nothing, confirming removes it", async () => {
    const kept = await drive(alice, [...open, "d", "\r"]);
    expect(kept).toContain("STRIPE_KEY");
    expect(vars().length).toBe(1);
    const asked = await drive(alice, [...open, "d"]);
    expect(asked).toContain("Unset this variable");
    const text = await drive(alice, [...open, "d", RIGHT, "\r"]);
    expect(vars()).toEqual([]);
    expect(text).toContain("STRIPE_KEY is unset for production.");
  });

  test("a writer who is not an admin has no entry, and can set nothing", async () => {
    expect(await drive(bob, [":", "Variables"])).not.toContain("acme/shop — Variables");
    expect(await drive(alice, [":", "Variables"])).toContain("acme/shop — Variables");
    await drive(bob, [...open, "a", "BOB_KEY", "\r", SECRET, "\r", "\r"]);
    expect(vars()).toEqual([]);
  });

  test("no frame drawn, and no event written, ever held the value", () => {
    expect(frames.length).toBeGreaterThan(20);
    for (const f of frames) expect(f).not.toContain(SECRET);
    const events = listEvents(app.db, { repoId: shop.id }).filter((e) => e.kind.startsWith("app.env_"));
    expect(events.map((e) => e.kind).sort()).toEqual(["app.env_deleted", "app.env_set"]);
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });
});
