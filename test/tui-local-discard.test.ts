/**
 * The local screens, driven through the headless terminal.
 *
 * Everything here goes in as bytes and comes out as a grid: no screen is
 * reached into, no private state is inspected. If a key does not produce the
 * text a person would see, the test fails — which is the only property worth
 * asserting about a terminal UI.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as git from "../src/git/local.ts";
import type { App } from "../src/tui/app/app.ts";
import {
  headlessTerminal,
  type HeadlessTerminal,
} from "../src/tui/term/terminal.ts";
import { createLocalApp } from "../src/tui/local/app.ts";
import { localBusy, localIdle } from "../src/tui/local/common.ts";
import { gitClientEnv } from "./helpers/git-client.ts";

async function sh(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: gitClientEnv({
      GIT_AUTHOR_NAME: "Ada",
      GIT_AUTHOR_EMAIL: "ada@forge.local",
      GIT_COMMITTER_NAME: "Ada",
      GIT_COMMITTER_EMAIL: "ada@forge.local",
    }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [err, code] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until nothing is loading, then paint. */
async function settle(app: App): Promise<void> {
  for (let i = 0; i < 400; i++) {
    await localIdle();
    if (!app.busy && !localBusy()) {
      await sleep(4);
      if (!app.busy && !localBusy()) break;
    }
    await sleep(4);
  }
  app.frame();
}

/** Type, then let the loop see it. Esc needs the decoder's idle backstop. */
async function type(
  term: HeadlessTerminal,
  app: App,
  keys: string,
): Promise<void> {
  term.feed(keys);
  if (keys.includes("\x1b")) await sleep(40);
  await settle(app);
}

const IDENTITY = {
  GIT_AUTHOR_NAME: "Ada",
  GIT_AUTHOR_EMAIL: "ada@forge.local",
  GIT_COMMITTER_NAME: "Ada",
  GIT_COMMITTER_EMAIL: "ada@forge.local",
};

const A_CHANGED = "caf\u00e9 changed\r\nno trailing newline";

describe("discarding in the local terminal", () => {
  let root = "";
  let dir = "";
  let term: HeadlessTerminal;
  let app: App;
  const ambient: Record<string, string | undefined> = {};

  const read = (name: string): Promise<Uint8Array> =>
    Bun.file(join(dir, name)).bytes();
  const same = async (name: string, text: string): Promise<boolean> =>
    Buffer.compare(await read(name), Buffer.from(text)) === 0;

  beforeAll(async () => {
    for (const [key, value] of Object.entries(IDENTITY)) {
      ambient[key] = process.env[key];
      process.env[key] = value;
    }
    root = await mkdtemp(join(tmpdir(), "forge-tui-discard-"));
    dir = join(root, "forge.test", "ada", "workshop");
    await mkdir(dir, { recursive: true });
    await sh(["init", "-b", "main", "."], dir);
    await sh(["config", "user.name", "Ada"], dir);
    await sh(["config", "user.email", "ada@forge.local"], dir);
    await sh(["config", "core.autocrlf", "false"], dir);
    await writeFile(join(dir, "a.txt"), "a committed\n");
    await writeFile(join(dir, "b.txt"), "b committed\n");
    await sh(["add", "-A"], dir);
    await sh(["commit", "-m", "base"], dir);

    // a.txt: changed in the working tree only.
    await writeFile(join(dir, "a.txt"), A_CHANGED);
    // b.txt: half-staged — one edit in the index, another on top of it.
    await writeFile(join(dir, "b.txt"), "b staged\n");
    await sh(["add", "b.txt"], dir);
    await writeFile(join(dir, "b.txt"), "b unstaged\n");

    term = headlessTerminal(120, 40);
    app = createLocalApp({ root, terminal: term, theme: "dark" }).app;
    app.start();
    await settle(app);
    await type(term, app, "\r");
  });

  afterAll(async () => {
    app.stop();
    for (const [key, value] of Object.entries(ambient)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  test("d asks first, naming the path, and escape keeps the file byte for byte", async () => {
    expect(term.toText()).toContain("CHANGED");
    await type(term, app, "j"); // staged b.txt -> changed a.txt
    await type(term, app, "d");
    const text = term.toText();
    expect(text).toContain("Throw away changes to a.txt?");
    expect(text).toContain("This cannot be undone.");
    expect(await same("a.txt", A_CHANGED)).toBe(true);

    await type(term, app, "\x1b");
    expect(term.toText()).not.toContain("Throw away");
    expect(await same("a.txt", A_CHANGED)).toBe(true);
  });

  test("the default choice is Cancel: enter alone discards nothing", async () => {
    await type(term, app, "d");
    await type(term, app, "\r");
    expect(await same("a.txt", A_CHANGED)).toBe(true);
  });

  test("confirming restores the committed content and the row leaves CHANGED", async () => {
    await type(term, app, "d");
    await type(term, app, "\x1b[C\r"); // right: Discard, enter
    expect(await same("a.txt", "a committed\n")).toBe(true);
    const status = await git.status(dir);
    expect(status.ok && status.value.unstaged.map((f) => f.path)).toEqual([
      "b.txt",
    ]);
    expect(term.toText()).not.toContain("a.txt");
  });

  test("on a half-staged path, discard drops only the unstaged half", async () => {
    // The cursor landed on the one remaining Changed row: b.txt.
    await type(term, app, "d");
    expect(term.toText()).toContain("Throw away changes to b.txt?");
    await type(term, app, "\x1b[C\r");
    expect(await same("b.txt", "b staged\n")).toBe(true);
    const status = await git.status(dir);
    expect(status.ok && status.value.staged.map((f) => f.path)).toEqual([
      "b.txt",
    ]);
    expect(status.ok && status.value.unstaged.length).toBe(0);
    expect(term.toText()).toContain("STAGED");
    expect(term.toText()).not.toContain("CHANGED");
  });

  test("with no row under the cursor, d is disabled and does nothing", async () => {
    await sh(["reset", "--hard", "HEAD"], dir);
    await type(term, app, "a"); // reload the screen
    const text = term.toText();
    expect(text).toContain("Nothing to commit");
    await type(term, app, "d");
    expect(term.toText()).not.toContain("Throw away");
    expect(term.toText()).not.toContain("Discard changes");
    expect(await same("a.txt", "a committed\n")).toBe(true);
    expect(await same("b.txt", "b committed\n")).toBe(true);
  });
});
