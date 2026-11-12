/**
 * The description at the terminal's door (#8066): `w` on the About card writes it
 * through updateRepoSettings, for an admin who is a person only.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createAgent } from "../src/actions/crew.ts";
import { addTeamMember, createOrg, createTeam } from "../src/core/orgs.ts";
import { createRepo, getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import type { Ctx, Screen } from "../src/tui/app/app.ts";
import { aboutScreen } from "../src/tui/screens/about.ts";
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
const desc = () => getRepoById(app.db, repo.id)!.description;
const typed = (c: ReturnType<typeof card>, text: string) => {
  for (const ch of text) c.pushed.at(-1)!.key!({ key: ch } as never);
};
const trail = () =>
  (app.db.query("SELECT payload FROM event WHERE kind = 'repo.settings_updated' AND repo_id = ?1").all(repo.id) as { payload: string }[]).map((r) => r.payload);

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-tui-description-"));
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
  ok(await createRepo(app.db, app.reposRoot, { ownerId: org.id, name: "site", visibility: "public", description: "old" }));
  repo = getRepoById(app.db, (app.db.query("SELECT id FROM repo WHERE name = 'site'").get() as { id: string }).id)!;
  addTeamMember(app.db, ok(createTeam(app.db, org.id, "Writers", "write")), writer.id);
  bot = ok(await createAgent(app, root, { username: "bot" })).user;
  botRepo = ok(await createRepo(app.db, app.reposRoot, { ownerId: bot.id, name: "own", visibility: "public" }));
}, 30_000);

afterAll(async () => {
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("an admin's w, text and enter change the row and the audit trail", async () => {
  const c = card(founder);
  expect(c.label("w")).toBe("write description");
  c.press("w");
  typed(c, "!");
  c.pushed[0]!.key!({ key: "enter" } as never);
  await until("saved", () => desc() === "old!");
  await until("the toast", () => c.toasts.includes("description saved"));
  expect(trail().some((p) => p.includes('"description"') && p.includes("old!"))).toBe(true);
});

test("esc leaves it as it was", async () => {
  const c = card(founder);
  c.press("w");
  typed(c, "zzz");
  c.pushed[0]!.key!({ key: "esc" } as never);
  await Bun.sleep(20);
  expect(desc()).toBe("old!");
});

test("a refusal is a toast and the description stays", async () => {
  const c = card(founder);
  c.press("w");
  typed(c, "x".repeat(2000));
  c.pushed[0]!.key!({ key: "enter" } as never);
  await Bun.sleep(20);
  expect(c.toasts.some((t) => t.includes("2000 characters"))).toBe(true);
  expect(desc()).toBe("old!");
});

test("a control character is refused with a toast and the description stays", async () => {
  const c = card(founder);
  c.press("w");
  typed(c, "bad\u0007bell");
  c.pushed[0]!.key!({ key: "enter" } as never);
  await Bun.sleep(20);
  expect(c.toasts).toContain("a description is one line of plain text");
  expect(desc()).toBe("old!");
});

test("a reader and an agent admin are not offered w, and it does nothing", () => {
  for (const [who, at] of [[writer, repo], [bot, botRepo]] as const) {
    const c = card(who, at);
    expect(c.label("w")).toBeUndefined();
    c.press("w");
    expect(c.pushed).toHaveLength(0);
  }
});
