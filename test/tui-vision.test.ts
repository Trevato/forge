/** The terminal's Vision screen (#7272): the purpose, the pillars in order and the rules from docs/VISION.md; one line without it; only for readers. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { NO_VISION, NO_VISION_LINE } from "../src/core/vision.ts";
import { readDefaultVision } from "../src/crew/vision.ts";
import { createForgeApp, Session } from "../src/tui/forge.ts";
import type { Ctx } from "../src/tui/app/app.ts";
import { repoScreen } from "../src/tui/screens/repo.ts";
import { local } from "../src/tui/screens/where.ts";
import { NOT_FOUND_LINE, visionCommands, visionLines, visionScreen } from "../src/tui/screens/vision.ts";
import { displayWidth } from "../src/tui/term/width.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

const VISION = `# Lab

A forge where agents build and people decide what lands.

## Order of work

1. **Story.** The purpose is the first thing a door says.
2. **Reach.** Every function is reachable from the feed in two taps, through the MCP, and by a test that proves it.
3. **Polish.** Small and quiet.

## How we build

- Small modules named for one concept.
- Every input validated at the boundary.
`;

let dir: string;
let app: App;
let withVision: Repo;
let without: Repo;
let secret: Repo;
const guest = { sshUsername: "git", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test" };

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-vision-"));
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
  const mk = async (name: string, visibility: "public" | "private", files: { path: string; content: string }[]) => {
    const repo = await createRepo(app, made.value, { name, visibility });
    if (!repo.ok) throw new Error(JSON.stringify(repo.error));
    const done = await commitToBranch(app, made.value, repo.value, { message: "start", files });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
    return repo.value;
  };
  withVision = await mk("lab", "public", [{ path: "docs/VISION.md", content: VISION }]);
  without = await mk("plain", "public", [{ path: "README.md", content: "# plain\n" }]);
  secret = await mk("secret", "private", [{ path: "docs/VISION.md", content: VISION }]);
}, 60_000);

afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

async function screenText(repo: Repo, cols = 100): Promise<string> {
  const terminal = headlessTerminal(cols, 30);
  const { app: tui, session } = createForgeApp(app, guest, { terminal, exitHooks: false });
  tui.start();
  tui.ctx.push(visionScreen(session, tui.ctx, repo));
  await settleApp(tui);
  const text = tui.screen.toText();
  tui.stop?.();
  return text;
}

test("a repository with a VISION.md shows its purpose, then its pillars in order, then its rules", async () => {
  const text = await screenText(withVision);
  const at = (s: string) => text.indexOf(s);
  expect(at("A forge where agents build")).toBeGreaterThan(-1);
  expect(at("1. Story. The purpose is the first thing a door says.")).toBeGreaterThan(at("A forge where agents build"));
  expect(at("2. Reach.")).toBeGreaterThan(at("1. Story."));
  expect(at("3. Polish. Small and quiet.")).toBeGreaterThan(at("2. Reach."));
  expect(at("- Small modules named for one concept.")).toBeGreaterThan(at("3. Polish."));
  expect(at("- Every input validated at the boundary.")).toBeGreaterThan(at("- Small modules"));
});

test("a repository without the document says so in one line", async () => {
  const lines = visionLines((await readDefaultVision(app.reposRoot, without)) ?? NO_VISION, 200);
  expect(lines.map((l) => l.text)).toEqual([NO_VISION_LINE]);
  expect(await screenText(without, 120)).toContain(NO_VISION_LINE);
  expect(await readDefaultVision(app.reposRoot, without)).toBeNull();
});

test("the screen opened directly on a private repository shows a stranger none of its VISION.md", async () => {
  const text = await screenText(secret, 120);
  expect(text).toContain(NOT_FOUND_LINE);
  expect(text).not.toContain("A forge where agents build");
  expect(text).not.toContain("Story");
  expect(text).not.toContain("Reach");
  expect(text).not.toContain("Small modules");
  expect(text).not.toContain(NO_VISION_LINE);
});

test("long text wraps to the width and no word is cut", async () => {
  const vision = (await readDefaultVision(app.reposRoot, withVision))!;
  const width = 30;
  const lines = visionLines(vision, width);
  for (const l of lines) expect(displayWidth(l.text)).toBeLessThanOrEqual(width);
  const words = (s: string) => s.split(/\s+/).filter((w) => w !== "");
  const wide = visionLines(vision, 1000).flatMap((l) => words(l.text));
  expect(lines.flatMap((l) => words(l.text))).toEqual(wide);
  // A pillar's continuation lines hang under its text, not under its number.
  const reach = lines.findIndex((l) => l.text.startsWith("2. Reach."));
  expect(lines[reach + 1]!.text.startsWith("   ")).toBe(true);
});

test("the command is offered to a reader and not on a private repository the viewer cannot read", () => {
  const ctx = {} as Ctx;
  const stranger = new Session(app, guest);
  expect(visionCommands(stranger, ctx, withVision).map((c) => c.id)).toEqual(["vision"]);
  expect(visionCommands(stranger, ctx, secret)).toEqual([]);
  expect(visionCommands(stranger, ctx, undefined)).toEqual([]);
});

test("the repository screen's commands carry Vision, and running it opens the screen", async () => {
  const terminal = headlessTerminal(100, 30);
  const { app: tui, session } = createForgeApp(app, guest, { terminal, exitHooks: false });
  tui.start();
  const screen = repoScreen(session, tui.ctx, local(session, withVision));
  tui.ctx.push(screen);
  await settleApp(tui);
  const command = screen.commands?.().find((c) => c.id === "vision");
  expect(command?.title).toBe("alice/lab — Vision");
  command!.run();
  await settleApp(tui);
  const text = tui.screen.toText();
  tui.stop?.();
  expect(text).toContain("1. Story.");
});
