/** The terminal's repository screen offers Forge it, as the page's button does (#7642). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { commitFiles } from "../src/git/write.ts";
import { repoDir } from "../src/git/repos.ts";
import { useProbe } from "../src/spawn/door.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { repoScreen } from "../src/tui/screens/repo.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let forge: App;
let alice: User;
let repo: Repo;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-forge-it-"));
  forge = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
  const a = await createUser(forge.db, { origin: "seed", trusted: true, username: "alice", email: "a@x.test", password: "a-long-passphrase", isAdmin: true });
  if (!a.ok) throw new Error("user");
  alice = a.value;
  const made = await createRepo(forge, alice, { name: "bakery", visibility: "public" });
  if (!made.ok) throw new Error("repo");
  repo = made.value;
  const c = await commitFiles(repoDir(forge.reposRoot, "alice", "bakery"), {
    branch: "main", message: "bakery", files: [{ path: "README.md", content: "# bakery\n" }], author: { name: "a", email: "a@x.invalid" },
  });
  if (!c.ok) throw new Error("commit");
  useProbe(forge, () => async () => true);
}, 60_000);
afterAll(async () => {
  forge.close?.();
  await rm(dir, { recursive: true, force: true });
});

const open = async (user: User | undefined) => {
  const { app, session } = createForgeApp(
    forge,
    { sshUsername: user?.username ?? "anon", remoteAddress: "127.0.0.1", user },
    { terminal: headlessTerminal(120, 40), exitHooks: false },
  );
  app.start();
  await settleApp(app);
  app.push(repoScreen(session, app.ctx, local(session, repo)));
  await settleApp(app);
  return app;
};
const key = async (app: Awaited<ReturnType<typeof open>>, k: string): Promise<string> => {
  app.dispatch({ type: "key", key: k, ctrl: false, alt: false, shift: false });
  await settleApp(app);
  return app.screen.toText();
};
const type = async (app: Awaited<ReturnType<typeof open>>, text: string): Promise<string> => {
  let out = "";
  for (const ch of text) out = await key(app, ch);
  return out;
};

test("a signed-in person is offered Forge it in the palette; a stranger is not", async () => {
  const app = await open(alice);
  await key(app, ":");
  expect(await type(app, "forge it")).toContain("alice/bakery — Forge it");
  const stranger = await open(undefined);
  await key(stranger, ":");
  expect(await type(stranger, "forge it")).not.toContain("alice/bakery — Forge it");
});

test("Forge it confirms, then makes the forge and shows its claim link once", async () => {
  const app = await open(alice);
  await key(app, ":");
  await type(app, "forge it");
  const confirm = await key(app, "enter");
  expect(confirm).toContain("bakery");
  expect(await Bun.file(join(dir, "spawn", "bakery.json")).exists()).toBe(false);
  expect(await key(app, "enter")).toMatch(/bakery--forge\.test\/claim#/);
  expect(await Bun.file(join(dir, "spawn", "bakery.json")).exists()).toBe(true);
});
