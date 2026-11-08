/**
 * The commit screen's message rules, driven through `createLocalApp` over a
 * real temporary repository: an empty subject is refused, a long one is
 * marked but still commits, and a pasted message splits into subject + body.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as git from "../src/git/local.ts";
import type { App } from "../src/tui/app/app.ts";
import { createLocalApp } from "../src/tui/local/app.ts";
import { localBusy, localIdle } from "../src/tui/local/common.ts";
import {
  headlessTerminal,
  type HeadlessTerminal,
} from "../src/tui/term/terminal.ts";
import { gitClientEnv } from "./helpers/git-client.ts";

const IDENTITY = {
  GIT_AUTHOR_NAME: "Ada",
  GIT_AUTHOR_EMAIL: "ada@forge.local",
  GIT_COMMITTER_NAME: "Ada",
  GIT_COMMITTER_EMAIL: "ada@forge.local",
};

async function sh(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: gitClientEnv(IDENTITY),
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

async function type(
  term: HeadlessTerminal,
  app: App,
  keys: string,
): Promise<void> {
  term.feed(keys);
  if (keys.includes("\x1b")) await sleep(40);
  await settle(app);
}

describe("the local commit screen", () => {
  let root = "";
  let dir = "";
  let term: HeadlessTerminal;
  let app: App;
  const ambient: Record<string, string | undefined> = {};

  beforeEach(async () => {
    // The app inherits this process's identity on purpose; pin it to Ada.
    for (const [key, value] of Object.entries(IDENTITY)) {
      ambient[key] = process.env[key];
      process.env[key] = value;
    }
    root = await mkdtemp(join(tmpdir(), "forge-tui-commit-"));
    dir = join(root, "forge.test", "ada", "workshop");
    await mkdir(dir, { recursive: true });
    await sh(["init", "-b", "main", "."], dir);
    await sh(["config", "user.name", "Ada"], dir);
    await sh(["config", "user.email", "ada@forge.local"], dir);
    await writeFile(join(dir, "poem.txt"), "one\n");
    await sh(["add", "-A"], dir);
    await sh(["commit", "-m", "the first commit"], dir);
    await writeFile(join(dir, "poem.txt"), "one\ntwo\n");
    await sh(["add", "-A"], dir);

    term = headlessTerminal(120, 40);
    app = createLocalApp({ root, terminal: term, theme: "dark" }).app;
    app.start();
    await settle(app);
    await type(term, app, "\r"); // open the working tree
    await type(term, app, "c"); // open the commit screen
    expect(term.toText()).toContain("1 file");
  });

  afterEach(async () => {
    app.stop();
    for (const [key, value] of Object.entries(ambient)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  async function head(): Promise<string> {
    const m = await git.headMessage(dir);
    return m.ok ? m.value : "";
  }

  /** The colour of the subject field's left bar, found via its hint line. */
  function barColour(): number {
    const lines = term.toText().split("\n");
    const hint = lines.findIndex((l) => /\d+ (over|left)/.test(l));
    expect(hint).toBeGreaterThan(0);
    const x = lines[hint]!.search(/\d/);
    return term.screen.styleAt(x, hint - 1).fg as number;
  }

  for (const subject of ["", "   "]) {
    test(`ctrl+d with subject ${JSON.stringify(subject)} is refused`, async () => {
      await type(term, app, subject);
      await type(term, app, "\x04");
      expect(term.toText()).toContain("a subject is required");
      expect(await head()).toBe("the first commit");
      // Still on the commit screen, nothing committed.
      expect(term.toText()).toContain("Commit");
    });
  }

  test("a subject past the limit is marked, by display width, and commits", async () => {
    // 25 wide characters are 50 columns: at the limit, not over it.
    await type(term, app, "世".repeat(25));
    expect(term.toText()).toContain("0 left");
    const ok = barColour();

    // Two columns more is 25 chars + 1 = 52 columns, though only 26 chars.
    await type(term, app, "世");
    expect(term.toText()).toContain("2 over the 50-column subject line");
    expect(barColour()).not.toBe(ok);

    await type(term, app, "\x04");
    expect(await head()).toBe("世".repeat(26));
  });

  test("a pasted first line is the subject and the rest the body", async () => {
    term.feed("\x1b[200~fix the thing\n\nbecause it was broken\nand slow\x1b[201~");
    await settle(app);
    await type(term, app, "\x04");
    expect(await head()).toBe(
      "fix the thing\n\nbecause it was broken\nand slow",
    );
  });
});
