/** The terminal's Builds screen: a repository's pins for its readers; pin, note and delete for a writer who is not an agent. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pinBuild } from "../src/actions/builds.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { listBuildPins, readBuildNotes } from "../src/git/builds.ts";
import { refTip } from "../src/git/read.ts";
import { repoDir } from "../src/git/repos.ts";
import type { Ctx } from "../src/tui/app/app.ts";
import { createForgeApp, Session } from "../src/tui/forge.ts";
import { buildsCommands, buildsScreen, DELETED_LINE, NOT_FOUND_LINE, NO_BUILDS_LINE, parsePin } from "../src/tui/screens/builds.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let app: App;
let open: Repo;
let secret: Repo;
let alice: User;
let oid: string;
const guest = { sshUsername: "git", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test" };
const pins = (r: Repo) => listBuildPins(repoDir(app.reposRoot, r.ownerName, r.name));

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-builds-"));
  app = createApp({ dataDir: dir, port: 0 });
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@f.dev", password: "a-good-passphrase", adminIfFirst: true });
  if (!made.ok) throw new Error(made.error);
  alice = made.value;
  const mk = async (name: string, visibility: "public" | "private") => {
    const repo = await createRepo(app, alice, { name, visibility });
    if (!repo.ok) throw new Error(JSON.stringify(repo.error));
    const c = await commitToBranch(app, alice, repo.value, { branch: repo.value.defaultBranch, message: "start", files: [{ path: "README.md", content: "hi\n" }] });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    return repo.value;
  };
  open = await mk("game", "public");
  secret = await mk("secret", "private");
  oid = (await refTip(repoDir(app.reposRoot, "alice", "game"), `refs/heads/${open.defaultBranch}`))!;
  const s = await pinBuild(app, alice, secret, { label: "hidden-pin", oid: (await refTip(repoDir(app.reposRoot, "alice", "secret"), `refs/heads/${secret.defaultBranch}`))! });
  if (!s.ok) throw new Error(s.error);
}, 60_000);

afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const key = (key: string) => ({ type: "key" as const, key, ctrl: false, alt: false, shift: false });

async function drive(repo: Repo, user: User | undefined, steps: (string | string[])[] = []): Promise<string> {
  const terminal = headlessTerminal(100, 30);
  const { app: tui, session } = createForgeApp(app, user ? { ...guest, user } : guest, { terminal, exitHooks: false });
  tui.start();
  tui.ctx.push(buildsScreen(session, tui.ctx, repo));
  await settleApp(tui);
  for (const step of steps) {
    for (const k of Array.isArray(step) ? step : [step]) tui.dispatch(key(k));
    await settleApp(tui);
  }
  const text = tui.screen.toText();
  tui.stop?.();
  return text;
}

test("parsePin reads label, commit, then the note", () => {
  expect(parsePin(" v2  abc  it plays ")).toEqual({ label: "v2", oid: "abc", note: "it plays" });
  expect(parsePin("v2")).toBeUndefined();
});

test("a reader with no pins sees so, and a guest is offered no writes", async () => {
  const text = await drive(open, undefined, ["p"]);
  expect(text).toContain(NO_BUILDS_LINE);
  expect(text).not.toContain("Pin a build");
});

test("a writer pins from the prefilled prompt, notes it, and deletes it", async () => {
  // The prompt is prefilled with the next label and the default branch's tip; type a note and submit.
  let text = await drive(open, alice, ["p", [..."looks good"], "enter"]);
  expect(text).toContain("Pinned v1.");
  const [made] = await pins(open);
  expect(made).toMatchObject({ label: "v1", oid, source: "terminal", note: "looks good" });

  text = await drive(open, alice, ["n", [..."it plays"], "enter"]);
  expect(text).toContain("Noted v1.");
  const notes = await readBuildNotes(repoDir(app.reposRoot, "alice", "game"), ["v1"]);
  expect(notes.get("v1")?.[0]).toMatchObject({ by: "alice", kind: "human", text: "it plays" });

  text = await drive(open, alice, ["d", "right", "enter"]);
  expect(await pins(open)).toEqual([]);
  expect(text).toContain(DELETED_LINE);
});

test("an agent holding write access is offered no writes, and its keys do nothing", async () => {
  const p = await pinBuild(app, alice, open, { label: "keep", oid });
  expect(p.ok).toBe(true);
  const agent = { ...alice, kind: "agent" } as User;
  await drive(open, agent, ["d", "right", "enter"]);
  await drive(open, agent, ["p", "enter"]);
  expect((await pins(open)).map((x) => x.label)).toEqual(["keep"]);
});

test("a stranger opening a private repository's screen gets No such repository and no pin", async () => {
  const text = await drive(secret, undefined);
  expect(text).toContain(NOT_FOUND_LINE);
  expect(text).not.toContain("hidden-pin");
});

test("the command is offered to a reader and not for a repository the viewer cannot read", () => {
  const ctx = {} as Ctx;
  const stranger = new Session(app, guest);
  expect(buildsCommands(stranger, ctx, open).map((c) => c.id)).toEqual(["builds"]);
  expect(buildsCommands(stranger, ctx, secret)).toEqual([]);
  expect(buildsCommands(stranger, ctx, undefined)).toEqual([]);
});
