/** The terminal's Display screen: title, layout and builds, the open/private split, 404-alike for the unreadable. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { pinBuild } from "../src/git/builds.ts";
import { repoDir } from "../src/git/repos.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { displayCommands, displayScreen, NO_DISPLAY_LINE } from "../src/tui/screens/display.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let app: App;
let alice: User;
let bob: User;
const guest = { sshUsername: "git", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test" };
const repo = (n: string): Repo => getRepo(app.db, "alice", n)!;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-display-"));
  app = createApp({ dataDir: dir, port: 0 });
  const mk = async (username: string) => {
    const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@f.dev`, password: "a-good-passphrase", adminIfFirst: true });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  alice = await mk("alice");
  bob = await mk("bob");
  for (const [name, visibility] of [["karts", "public"], ["vault", "private"], ["plain", "public"]] as const) {
    const made = await createRepo(app, alice, { name, visibility });
    if (!made.ok) throw new Error(String(made.error));
  }
  const commit = async (name: string, path: string, content: string) => {
    const c = await commitToBranch(app, alice, repo(name), { message: path, files: [{ path, content }] });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    return c.value.commitOid;
  };
  const pin = async (name: string, label: string, demo: string) => {
    const p = await pinBuild(repoDir(app.reposRoot, "alice", name), {
      label, oid: await commit(name, `${label}.txt`, label), note: "", source: "commit",
      tagger: { name: "alice", email: "alice@forge.local" }, at: 1_800_000_000,
      demo: { name: demo, version: "1.0", page: "/", showcase: true, launch: "shots" },
    });
    if (!p.ok) throw new Error(p.error);
  };
  await pin("karts", "fiesta", "krazy-karts");
  await pin("vault", "hush", "secret-game");
  await commit("karts", "display.json", JSON.stringify({ title: "Kart night", layout: "grid", sources: ["alice/karts", "alice/vault"] }));
  await commit("vault", "display.json", JSON.stringify({ title: "Vault night", layout: "shelf", sources: ["alice/vault"] }));
}, 60_000);

afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

async function drive(r: Repo, user: User | undefined): Promise<string> {
  const terminal = headlessTerminal(100, 30);
  const { app: tui, session } = createForgeApp(app, user ? { ...guest, user } : guest, { terminal, exitHooks: false });
  tui.start();
  tui.ctx.push(displayScreen(session, tui.ctx, r));
  await settleApp(tui);
  const text = tui.screen.toText();
  tui.stop?.();
  return text;
}

test("a reader sees the title, layout and builds; a private build's repository is named only to its readers", async () => {
  const mine = await drive(repo("karts"), alice);
  for (const w of ["Kart night", "grid", "krazy-karts 1.0", "alice/karts", "secret-game 1.0", "alice/vault"]) expect(mine).toContain(w);
  const other = await drive(repo("karts"), bob);
  expect(other).toContain("krazy-karts 1.0");
  expect(other).toContain("secret-game 1.0  private");
  expect(other).not.toContain("alice/vault");
});

test("no display.json, or an unreadable repository, reads as no display", async () => {
  expect(await drive(repo("plain"), alice)).toContain(NO_DISPLAY_LINE);
  const text = await drive(repo("vault"), undefined);
  expect(text).toContain(NO_DISPLAY_LINE);
  expect(text).not.toContain("Vault night");
});

test("the command is offered for a readable repository only", () => {
  const terminal = headlessTerminal(100, 30);
  const { app: tui, session } = createForgeApp(app, guest, { terminal, exitHooks: false });
  expect(displayCommands(session, tui.ctx, repo("vault"))).toEqual([]);
  expect(displayCommands(session, tui.ctx, repo("karts")).map((c) => c.id)).toEqual(["display"]);
});
