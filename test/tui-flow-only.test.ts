/**
 * FLOW ONLY at the terminal's door (#6392): the About card shows the switch
 * to every reader; only a repository admin who is a person gets the `w` key.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { listLabels } from "../src/core/issues.ts";
import { addTeamMember, createOrg, createTeam, listTeams, OWNERS_TEAM } from "../src/core/orgs.ts";
import { createRepo, getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import type { Ctx, Screen } from "../src/tui/app/app.ts";
import { flowRow, aboutScreen } from "../src/tui/screens/about.ts";
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
const row = (): string => flowRow(getRepoById(app.db, repo.id)).map(([, v]) => v)[0]!;

function card(user: User) {
  const toasts: string[] = [];
  const ctx = {
    invalidate() {},
    toast: (t: string) => toasts.push(t),
    push() {},
    pop() {},
    copy() {},
  } as unknown as Ctx;
  const f = { app, db: app.db, user } as unknown as Session;
  const src = localSource(app, getRepoById(app.db, repo.id)!, user);
  const screen = aboutScreen(f, ctx, {} as Screen, src, undefined, "main");
  const offered = () => screen.keys.some((b) => b.keys.includes("w"));
  const press = async (key: string) => {
    screen.key!({ key } as never);
    await new Promise((r) => setTimeout(r, 20));
  };
  return { toasts, offered, press };
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-tui-flow-"));
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

test("an admin turns it on and off from About", async () => {
  const c = card(founder);
  expect(row()).toBe("off");
  expect(c.offered()).toBe(true);
  await c.press("w");
  expect(row()).toBe("on");
  expect(listLabels(app.db, repo.id).filter((l) => l.name === "flow")).toHaveLength(1);
  expect(c.toasts.at(-1)).toBe("flow only is on");
  await c.press("w");
  expect(row()).toBe("off");
  expect(c.toasts.at(-1)).toBe("flow only is off");
});

test("a writer and an agent see the line but cannot toggle it", async () => {
  for (const who of [dev, bot]) {
    const c = card(who);
    expect(c.offered()).toBe(false);
    await c.press("w");
    expect(row()).toBe("off");
  }
});
