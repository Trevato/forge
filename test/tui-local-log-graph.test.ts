/**
 * The local terminal's log across a merge: two lanes that join, a graph that
 * survives a 40-column pane, and enter on a commit opening its diff.
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

const SUBJECTS = [
  "root commit",
  "work on main",
  "work on feature",
  "merge feature",
];

describe("the local log graph across a merge", () => {
  let root = "";
  let term: HeadlessTerminal;
  let app: App;
  const ambient: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const [key, value] of Object.entries(IDENTITY)) {
      ambient[key] = process.env[key];
      process.env[key] = value;
    }
    root = await mkdtemp(join(tmpdir(), "forge-tui-log-graph-"));
    const dir = join(root, "forge.test", "ada", "braid");
    await mkdir(dir, { recursive: true });
    await sh(["init", "-b", "main", "."], dir);
    await sh(["config", "user.name", "Ada"], dir);
    await sh(["config", "user.email", "ada@forge.local"], dir);
    await writeFile(join(dir, "base.txt"), "base\n");
    await sh(["add", "-A"], dir);
    await sh(["commit", "-m", SUBJECTS[0]!], dir);
    await sh(["checkout", "-b", "feature"], dir);
    await writeFile(join(dir, "feature.txt"), "feature\n");
    await sh(["add", "-A"], dir);
    await sh(["commit", "-m", SUBJECTS[2]!], dir);
    await sh(["checkout", "main"], dir);
    await writeFile(join(dir, "main.txt"), "main\n");
    await sh(["add", "-A"], dir);
    await sh(["commit", "-m", SUBJECTS[1]!], dir);
    await sh(["merge", "--no-ff", "-m", SUBJECTS[3]!, "feature"], dir);

    term = headlessTerminal(120, 30);
    app = createLocalApp({ root, terminal: term, theme: "dark" }).app;
    app.start();
    await settle(app);
    await type(term, app, "\r"); // the repo
    await type(term, app, "l"); // its log
  });

  afterAll(async () => {
    app.stop();
    for (const [key, value] of Object.entries(ambient)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  const rowOf = (text: string, subject: string): string =>
    text.split("\n").find((l) => l.includes(subject)) ?? "";

  test("two lanes join at the merge, every commit once", () => {
    const text = term.toText();
    for (const subject of SUBJECTS)
      expect(text.split(subject).length - 1).toBe(1);

    const merge = rowOf(text, "merge feature");
    const rootRow = rowOf(text, "root commit");
    // The merge opens a second lane; the root is where they meet again.
    expect(merge).toMatch(/^▸ ●╮ {2}merge feature/);
    expect(rootRow).toMatch(/^ {2}●╯ {2}root commit/);
    // Both sides sit between the two, one on each lane.
    expect(rowOf(text, "work on main")).toMatch(/●│\s+work on main/);
    expect(rowOf(text, "work on feature")).toMatch(
      /│●\s+work on feature/,
    );

    const order = SUBJECTS.map((s) => text.indexOf(s));
    // Newest first: the merge, the feature side, the main side, the root.
    expect(order[3]).toBeLessThan(order[2]!);
    expect(order[2]).toBeLessThan(order[1]!);
    expect(order[1]).toBeLessThan(order[0]!);
  });

  test("at 40 columns the graph column is drawn and nothing overflows", async () => {
    term.resize(40, 30);
    await settle(app);
    const lines = term.toText().split("\n");
    for (const line of lines) expect([...line].length).toBeLessThanOrEqual(40);
    const merge = lines.find((l) => l.includes("merge")) ?? "";
    expect(merge).toMatch(/●╮/);
    expect(lines.some((l) => /│●/.test(l))).toBe(true);
  });

  test("enter on a commit opens its diff", async () => {
    term.resize(120, 30);
    await settle(app);
    await type(term, app, "j"); // one below the merge: the feature side
    expect(rowOf(term.toText(), "work on feature")).toMatch(/^▸/);
    expect(term.toText().match(/^▸.*$/gm)).toHaveLength(1);
    await type(term, app, "\r");
    const text = term.toText();
    expect(text).toContain("feature.txt");
    expect(text).not.toContain("main.txt");
    expect(text).toContain("commit");
    expect(text).toContain("Ada");
    await type(term, app, "\x1b");
    expect(term.toText()).toContain("merge feature");
  });
});
