/**
 * The adapter's terminal door (#10037) is gated like the page: owner facts
 * (`canSeeOwnerFacts`) only. A guest or a signed-in outsider gets no palette
 * entry and, were the screen reached, no rows; the owner gets both.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createApp as createAppRecord } from "../src/core/apps.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import type { AdapterFacts } from "../src/apps/adapter_facts.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { adapterCommands, adapterScreen } from "../src/tui/screens/adapter.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";
import { proveAll } from "./helpers/verified.ts";
import { promote } from "./helpers/members.ts";

quietLogs();

let dir: string;
let app: App;
let olive: User;
let otto: User;
let repo: Repo;

const facts: AdapterFacts = {
  spec: { schedule: { every: 900 }, source: { name: "Shop API", hosts: ["api.shop.example"] } },
  last: undefined,
  cursor: "c-secret-9",
};

async function mk(username: string, first = false): Promise<User> {
  const r = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username,
    email: `${username}@forge.local`,
    password: "a-good-passphrase",
    adminIfFirst: first,
  });
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-adapter-tui-"));
  app = createApp({ dataDir: dir, port: 0 });
  await mk("siteadmin", true); // the site admin, so neither below is one
  olive = await mk("olive");
  otto = await mk("otto");
  proveAll(app);
  promote(app.db, olive, otto);
  const made = await createRepo(app, olive, { name: "shop", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  repo = made.value;
  const record = createAppRecord(app.db, { repoId: repo.id, slug: "shop", access: "public" });
  if (!record.ok) throw new Error(String(record.error));
});

afterAll(async () => {
  app.db.close();
  await rm(dir, { recursive: true, force: true });
});

async function look(user: User | undefined) {
  const terminal = headlessTerminal(100, 20);
  const { app: tui, session } = createForgeApp(
    app,
    { sshUsername: user?.username ?? "guest", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", ...(user ? { user } : {}) },
    { terminal, exitHooks: false },
  );
  tui.start();
  let read = 0;
  const commands = adapterCommands(session, tui.ctx, repo);
  tui.ctx.push(adapterScreen(session, tui.ctx, repo, async () => (read++, facts)));
  await settleApp(tui);
  await settleApp(tui);
  const text = tui.screen.toText();
  tui.stop?.();
  return { commands, text, read };
}

test("the owner gets the palette entry and the rows", async () => {
  const seen = await look(olive);
  expect(seen.commands.map((c) => c.id)).toEqual(["adapter"]);
  expect(seen.text).toContain("Shop API");
  expect(seen.text).toContain("c-secret-9");
});

test("a signed-in outsider gets no entry, and the screen reads nothing", async () => {
  const seen = await look(otto);
  expect(seen.commands).toEqual([]);
  expect(seen.read).toBe(0);
  expect(seen.text).not.toContain("Shop API");
  expect(seen.text).not.toContain("c-secret-9");
});

test("a guest gets no entry, and the screen reads nothing", async () => {
  const seen = await look(undefined);
  expect(seen.commands).toEqual([]);
  expect(seen.read).toBe(0);
  expect(seen.text).not.toContain("c-secret-9");
});
