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

async function sh(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Ada",
      GIT_AUTHOR_EMAIL: "ada@forge.local",
      GIT_COMMITTER_NAME: "Ada",
      GIT_COMMITTER_EMAIL: "ada@forge.local",
      LC_ALL: "C",
    },
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

describe("the local terminal UI", () => {
  let root = "";
  let dir = "";
  let term: HeadlessTerminal;
  let app: App;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "forge-tui-local-"));
    dir = join(root, "forge.test", "ada", "workshop");
    await mkdir(dir, { recursive: true });
    await sh(["init", "-b", "main", "."], dir);
    await sh(["config", "user.name", "Ada"], dir);
    await sh(["config", "user.email", "ada@forge.local"], dir);

    const base = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join(
      "\n",
    );
    await writeFile(join(dir, "poem.txt"), `${base}\n`);
    await writeFile(join(dir, "notes.md"), "# notes\n");
    await sh(["add", "-A"], dir);
    await sh(["commit", "-m", "the first commit"], dir);

    // Two hunks in one file, plus an untracked file, plus a stash to find.
    await writeFile(
      join(dir, "poem.txt"),
      `${base.replace("line 2", "LINE TWO").replace("line 18", "LINE EIGHTEEN")}\n`,
    );
    await writeFile(join(dir, "notes.md"), "# notes\n\nmore\n");
    await writeFile(join(dir, "scratch.txt"), "untracked\n");
    await sh(["stash", "push", "--", "notes.md"], dir);
    await sh(["branch", "experiment"], dir);

    term = headlessTerminal(120, 40);
    app = createLocalApp({ root, terminal: term, theme: "dark" }).app;
    app.start();
    await settle(app);
  });

  afterAll(async () => {
    app.stop();
    await rm(root, { recursive: true, force: true });
  });

  test("the library lists every repo under the root", () => {
    const text = term.toText();
    expect(text).toContain("forge.test/ada/workshop");
    expect(text).toContain("main");
    expect(text).toContain("Repos");
  });

  test("enter opens the working tree, in sections", async () => {
    await type(term, app, "\r");
    const text = term.toText();
    expect(text).toContain("CHANGED");
    expect(text).toContain("poem.txt");
    expect(text).toContain("NEW");
    expect(text).toContain("scratch.txt");
    // The footer says where you are, always.
    expect(text).toContain("main");
  });

  test("space stages the file under the cursor", async () => {
    await type(term, app, " ");
    expect(term.toText()).toContain("STAGED");
    const status = await git.status(dir);
    expect(status.ok && status.value.staged.map((f) => f.path)).toEqual([
      "poem.txt",
    ]);
  });

  test("space again unstages it", async () => {
    await type(term, app, " ");
    const status = await git.status(dir);
    expect(status.ok && status.value.staged.length).toBe(0);
    expect(term.toText()).not.toContain("STAGED");
  });

  test("enter opens the hunks, and `s` stages one of them", async () => {
    await type(term, app, "\r");
    expect(term.toText()).toContain("hunk 1/2");

    await type(term, app, "s");
    const staged = await git.diff(dir, { path: "poem.txt", staged: true });
    expect(staged.ok).toBe(true);
    if (staged.ok) {
      const lines = staged.value.files[0]!.hunks.flatMap((h) => h.lines);
      expect(lines.some((l) => l.content === "LINE TWO")).toBe(true);
      expect(lines.some((l) => l.content === "LINE EIGHTEEN")).toBe(false);
    }
    await type(term, app, "\x1b");
  });

  test("`c` writes a commit through the textarea", async () => {
    await type(term, app, "c");
    expect(term.toText()).toContain("Commit");

    await type(term, app, "stage half a poem");
    expect(term.toText()).toContain("stage half a poem");

    await type(term, app, "\x04"); // ctrl+d
    await settle(app);

    const message = await git.headMessage(dir);
    expect(message.ok && message.value).toBe("stage half a poem");
    // And we are back on the working tree, with the rest still changed.
    expect(term.toText()).toContain("poem.txt");
  });

  test("`b` shows the branches, with the current one marked", async () => {
    await type(term, app, "b");
    const text = term.toText();
    expect(text).toContain("main");
    expect(text).toContain("experiment");
    expect(text).toContain("no upstream");
    await type(term, app, "\x1b");
  });

  test("`z` lists the stash and enter applies it", async () => {
    await type(term, app, "z");
    const text = term.toText();
    expect(text).toContain("WIP on main");
    // The preview reads the stash without applying it — the whole point.
    expect(text).toContain("notes.md");
    expect(text).toContain("+ more");

    await type(term, app, "\r");
    expect(await Bun.file(join(dir, "notes.md")).text()).toBe(
      "# notes\n\nmore\n",
    );
    await type(term, app, "\x1b");
  });

  test("`l` shows the log with a graph column", async () => {
    await type(term, app, "l");
    const text = term.toText();
    expect(text).toContain("the first commit");
    expect(text).toContain("stage half a poem");
    expect(text).toContain("Ada");
    expect(text).toMatch(/\*\s+stage half a poem/);
    await type(term, app, "\x1b");
  });

  test("`?` lists every binding the screen has", async () => {
    await type(term, app, "?");
    const text = term.toText();
    for (const help of ["stage", "commit", "push", "branches", "stashes"])
      expect(text).toContain(help);
    await type(term, app, "\x1b");
  });

  test("the emitted bytes really produce the grid we drew", () => {
    // The headless terminal replays our own ANSI; if the diff renderer moved
    // the cursor wrongly the two grids would have diverged by now.
    expect(term.screen.toText()).toBe(app.screen.toText());
  });

  test("a narrow terminal drops to one pane rather than overflowing", async () => {
    term.resize(80, 24);
    await settle(app);
    const text = term.toText();
    expect(text).toContain("poem.txt");
    for (const line of text.split("\n"))
      expect(line.length).toBeLessThanOrEqual(80);
    term.resize(120, 40);
    await settle(app);
  });
});
