/**
 * The stash screen's verbs beyond enter: `p` pops, `d` drops after a confirm,
 * and a pop that conflicts says so and keeps the entry. Driven through the
 * headless terminal over a real temporary repository, as tui-local.test.ts is.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

async function git(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: gitClientEnv(IDENTITY),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
  return out;
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

const subjects = async (dir: string): Promise<string[]> =>
  (await git(["stash", "list", "--format=%gs"], dir))
    .split("\n")
    .filter((l) => l !== "");

describe("the local terminal's stash verbs", () => {
  let root = "";
  let dir = "";
  let term: HeadlessTerminal;
  let app: App;
  const ambient: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const [key, value] of Object.entries(IDENTITY)) {
      ambient[key] = process.env[key];
      process.env[key] = value;
    }
    root = await mkdtemp(join(tmpdir(), "forge-tui-stash-"));
    dir = join(root, "forge.test", "ada", "workshop");
    await mkdir(dir, { recursive: true });
    await git(["init", "-b", "main", "."], dir);
    await git(["config", "user.name", "Ada"], dir);
    await git(["config", "user.email", "ada@forge.local"], dir);
    await writeFile(join(dir, "a.txt"), "a\n");
    await writeFile(join(dir, "b.txt"), "b\n");
    await git(["add", "-A"], dir);
    await git(["commit", "-m", "first"], dir);

    await writeFile(join(dir, "a.txt"), "a from first stash\n");
    await git(["stash", "push", "-m", "first stash"], dir);
    await writeFile(join(dir, "b.txt"), "b from second stash\n");
    await git(["stash", "push", "-m", "second stash"], dir);

    term = headlessTerminal(120, 40);
    app = createLocalApp({ root, terminal: term, theme: "dark" }).app;
    app.start();
    await settle(app);
    await type(term, app, "\r"); // library → working tree
    await type(term, app, "z"); // stashes
  });

  afterAll(async () => {
    app.stop();
    for (const [key, value] of Object.entries(ambient)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  test("the diff beside the list follows the cursor", async () => {
    let text = term.toText();
    expect(text).toContain("second stash");
    expect(text).toContain("+ b from second stash");
    expect(text).not.toContain("a from first stash");

    await type(term, app, "j");
    text = term.toText();
    expect(text).toContain("+ a from first stash");
    expect(text).not.toContain("b from second stash\n+");
    await type(term, app, "k");
    expect(term.toText()).toContain("+ b from second stash");
  });

  test("`d` asks first, and escape changes nothing", async () => {
    const before = await subjects(dir);
    expect(before.length).toBe(2);

    await type(term, app, "d");
    const text = term.toText();
    expect(text).toContain("Drop stash");
    expect(text).toContain("A dropped stash cannot be recovered.");
    // Nothing is dropped while the question is open.
    expect(await subjects(dir)).toEqual(before);

    await type(term, app, "\x1b");
    expect(term.toText()).not.toContain("Drop stash");
    expect(term.toText()).toContain("second stash");
    expect(term.toText()).toContain("first stash");
    expect(await subjects(dir)).toEqual(before);
  });

  test("confirming the drop removes only that entry", async () => {
    await type(term, app, "j"); // the older one
    await type(term, app, "d");
    expect(term.toText()).toContain("Drop stash");
    // Cancel is first; move to Drop and choose it.
    await type(term, app, "\x1b[C");
    await type(term, app, "\r");

    const left = await subjects(dir);
    expect(left.length).toBe(1);
    expect(left[0]).toContain("second stash");
    const text = term.toText();
    expect(text).toContain("second stash");
    expect(text).not.toContain("first stash");
  });

  test("`p` applies the top entry and removes it from the list", async () => {
    await type(term, app, "p");
    expect(await Bun.file(join(dir, "b.txt")).text()).toBe(
      "b from second stash\n",
    );
    expect(await subjects(dir)).toEqual([]);
    expect(term.toText()).toContain("No stashes");
  });

  test("a pop that conflicts says so and keeps the entry", async () => {
    await git(["checkout", "--", "."], dir);
    await writeFile(join(dir, "a.txt"), "a from a stash\n");
    await git(["stash", "push", "-m", "conflicting stash"], dir);
    await writeFile(join(dir, "a.txt"), "a changed since\n");
    await git(["commit", "-am", "change a"], dir);

    await type(term, app, "\x1b"); // back to the working tree
    await type(term, app, "z");
    expect(term.toText()).toContain("conflicting stash");

    await type(term, app, "p");
    expect(await subjects(dir)).toHaveLength(1);
    const text = term.toText();
    expect(text).toContain("conflicting stash");
    expect(text).toMatch(/conflict|overwritten|failed|could not/i);
  });
});
