/**
 * Deleting a branch from the local terminal's branch list.
 *
 * `d` is git's safe delete and `D` its forced one; both go through a confirm,
 * and the confirm for `D` says commits will be lost. Driven as a person would,
 * over a real temporary repository: bytes in, grid out.
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

async function names(dir: string): Promise<string[]> {
  const result = await git.branches(dir);
  return result.ok ? result.value.map((b) => b.name).sort() : [];
}

describe("deleting a branch in the local terminal", () => {
  let root = "";
  let dir = "";
  let term: HeadlessTerminal;
  let app: App;
  const ambient: Record<string, string | undefined> = {};

  /** Move the cursor to a branch by filtering to its name, then leave the filter. */
  const select = async (name: string): Promise<void> => {
    await type(term, app, "/");
    await type(term, app, "\x7f".repeat(20));
    await type(term, app, name);
    await type(term, app, "\r");
  };

  beforeAll(async () => {
    for (const [key, value] of Object.entries(IDENTITY)) {
      ambient[key] = process.env[key];
      process.env[key] = value;
    }
    root = await mkdtemp(join(tmpdir(), "forge-tui-branch-delete-"));
    dir = join(root, "forge.test", "ada", "workshop");
    await mkdir(dir, { recursive: true });
    await sh(["init", "-b", "main", "."], dir);
    await writeFile(join(dir, "poem.txt"), "one\n");
    await sh(["add", "-A"], dir);
    await sh(["commit", "-m", "the first commit"], dir);
    // Merged: points at main. Unmerged: holds a commit main does not.
    await sh(["branch", "stale"], dir);
    await sh(["checkout", "-b", "wip"], dir);
    await writeFile(join(dir, "poem.txt"), "one\ntwo\n");
    await sh(["commit", "-am", "work only here"], dir);
    await sh(["checkout", "main"], dir);

    term = headlessTerminal(120, 40);
    app = createLocalApp({ root, terminal: term, theme: "dark" }).app;
    app.start();
    await settle(app);
    await type(term, app, "\r"); // the repo's working tree
    await type(term, app, "b"); // its branches
  });

  afterAll(async () => {
    app.stop();
    for (const [key, value] of Object.entries(ambient)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  test("`d` on a merged branch asks, and confirming removes it", async () => {
    await select("stale");
    await type(term, app, "d");
    const text = term.toText();
    expect(text).toContain("Delete branch");
    expect(text).not.toContain("Force delete branch");
    expect(text).toContain("Delete stale?");
    expect(await names(dir)).toContain("stale");

    // Cancel is the default; move to Delete.
    await type(term, app, "\t");
    await type(term, app, "\r");
    expect(await names(dir)).not.toContain("stale");
    expect(term.toText()).toContain("No branches");
  });

  test("`d` on an unmerged branch is refused in words, and it stays", async () => {
    await select("wip");
    await type(term, app, "d");
    await type(term, app, "\t");
    await type(term, app, "\r");
    const text = term.toText();
    expect(text).toMatch(/not fully merged/i);
    expect(await names(dir)).toContain("wip");
  });

  test("`D` says commits will be lost; Escape keeps the branch", async () => {
    await select("wip");
    await type(term, app, "D");
    const text = term.toText();
    expect(text).toContain("Force delete branch");
    expect(text).toMatch(/unreachable/);
    expect(text).toContain("even if it is not merged");

    await type(term, app, "\x1b");
    expect(term.toText()).not.toContain("Force delete branch");
    expect(await names(dir)).toContain("wip");
  });

  test("confirming `D` removes the unmerged branch", async () => {
    await select("wip");
    await type(term, app, "D");
    await type(term, app, "\t");
    await type(term, app, "\r");
    expect(await names(dir)).not.toContain("wip");
  });

  test("on the current branch, `d` and `D` are disabled", async () => {
    await select("main");
    for (const key of ["d", "D"]) {
      await type(term, app, key);
      const opened = /delete branch/i.test(term.toText());
      // Close a dialog opened by mistake so it cannot hide the next key; with
      // none open, Escape would leave the branch list, so it is not pressed.
      if (opened) await type(term, app, "\x1b");
      expect(opened).toBe(false);
    }
    expect(await names(dir)).toContain("main");
  });
});
