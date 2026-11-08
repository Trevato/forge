/** The terminal's Vision screen under its rules: the open direction issue and its parts, as MCP `vision` reads them; Enter opens the issue. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { ensureDirectionIssue } from "../src/crew/autonomy.ts";
import { getRepoById, updateRepoSettings, type Repo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import type { User } from "../src/core/users.ts";
import { BLOCK_END, BLOCK_START } from "../src/crew/vision.ts";
import { setIssueState } from "../src/actions/issues.ts";
import { NO_VISION_LINE } from "../src/core/vision.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { visionScreen } from "../src/tui/screens/vision.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let app: App;
let alice: User;
let steered: Repo;
let plain: Repo;
let bare: Repo;
let closed: Repo;
let bob: User;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-vision-dir-"));
  app = createApp({ dataDir: dir, port: 0 });
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@f.dev",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  alice = made.value;
  const bobMade = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "bob",
    email: "bob@f.dev",
    password: "a-good-passphrase",
    adminIfFirst: false,
  });
  if (!bobMade.ok) throw new Error(bobMade.error);
  bob = bobMade.value;
  const mk = async (name: string, vision = true) => {
    const repo = await createRepo(app, alice, { name, visibility: "public" });
    if (!repo.ok) throw new Error(JSON.stringify(repo.error));
    const done = await commitToBranch(app, alice, repo.value, {
      message: "start",
      files: [
        vision
          ? { path: "docs/VISION.md", content: "# Lab\n\nA forge.\n\n## Order of work\n\n1. **Story.** First.\n" }
          : { path: "README.md", content: "# bare\n" },
      ],
    });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
    return repo.value;
  };
  steered = await mk("steered");
  plain = await mk("plain");
  bare = await mk("bare", false);
  closed = await mk("closed");
  const direction = `Alpha owner words.\n\n${BLOCK_START}\nBeta vision block\n${BLOCK_END}\n\nGamma more owner words.`;
  const steer = (repo: Repo) => {
    const set = updateRepoSettings(app.db, repo, { autonomyDirection: direction });
    const issue = ensureDirectionIssue(app, alice, set);
    if (!issue) throw new Error("no direction issue");
    return { repo: getRepoById(app.db, set.id)!, issue };
  };
  steered = steer(steered).repo;
  bare = steer(bare).repo;
  const shut = steer(closed);
  closed = shut.repo;
  setIssueState(app, alice, closed, shut.issue, "closed");
}, 60_000);

afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

async function open(repo: Repo, user: User | undefined) {
  const terminal = headlessTerminal(100, 40);
  const { app: tui, session } = createForgeApp(
    app,
    { sshUsername: "t", remoteAddress: "127.0.0.1", ...(user ? { user } : { fingerprint: "SHA256:t" }) } as never,
    { terminal, exitHooks: false },
  );
  tui.start();
  tui.ctx.push(visionScreen(session, tui.ctx, repo));
  await settleApp(tui);
  return tui;
}

test("the direction is drawn under the rules: #N title, then each part in order; Enter opens the issue", async () => {
  const tui = await open(steered, alice);
  const text = tui.screen.toText();
  const at = (s: string) => text.indexOf(s);
  expect(at("Direction")).toBeGreaterThan(at("1. Story."));
  expect(at("#1 ")).toBeGreaterThan(at("Direction"));
  expect(at("Alpha owner words.")).toBeGreaterThan(at("#1 "));
  expect(at("Beta vision block")).toBeGreaterThan(at("Alpha owner words."));
  expect(at("Gamma more owner words.")).toBeGreaterThan(at("Beta vision block"));
  tui.dispatch({ type: "key", key: "enter", ctrl: false, alt: false, shift: false });
  await settleApp(tui);
  const after = tui.screen.toText();
  tui.stop?.();
  expect(after).not.toContain("open direction");
  expect(after).not.toContain("How we build");
  expect(after).toContain("#1");
  expect(after).toContain("This issue carries the repository's direction");
});

test("a repository without a direction issue, and a viewer who may not read the settings, draw no section", async () => {
  const none = await open(plain, alice);
  expect(none.screen.toText()).not.toContain("Direction");
  none.stop?.();
  const guest = await open(steered, undefined);
  const text = guest.screen.toText();
  guest.stop?.();
  expect(text).toContain("1. Story.");
  expect(text).not.toContain("Alpha owner words.");
  expect(text).not.toContain("Direction");
});

test("without a docs/VISION.md the no-vision line is followed by the Direction section", async () => {
  const tui = await open(bare, alice);
  const text = tui.screen.toText();
  tui.stop?.();
  expect(text).toContain(NO_VISION_LINE);
  expect(text.indexOf("Direction")).toBeGreaterThan(text.indexOf(NO_VISION_LINE));
  expect(text.indexOf("Alpha owner words.")).toBeGreaterThan(text.indexOf("Direction"));
});

test("a signed-in non-admin and a closed direction issue draw no Direction section", async () => {
  const other = await open(steered, bob);
  const otherText = other.screen.toText();
  other.dispatch({ type: "key", key: "enter", ctrl: false, alt: false, shift: false });
  await settleApp(other);
  const stayed = other.screen.toText();
  other.stop?.();
  expect(otherText).toContain("1. Story.");
  expect(otherText).not.toContain("Direction");
  expect(otherText).not.toContain("Alpha owner words.");
  expect(stayed).toContain("1. Story.");
  const shut = await open(closed, alice);
  const shutText = shut.screen.toText();
  shut.stop?.();
  expect(shutText).toContain("1. Story.");
  expect(shutText).not.toContain("Direction");
});
