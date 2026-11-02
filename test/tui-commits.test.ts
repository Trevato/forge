/**
 * The terminal's history, against a real repository: the log pages through
 * a real "Load more…" row, a commit opens its message and diff, and another
 * branch shows its own log.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import type { Ctx, Screen } from "../src/tui/app/app.ts";
import { commitsScreen } from "../src/tui/screens/commits.ts";
import { local } from "../src/tui/screens/where.ts";
import { Session } from "../src/tui/session.ts";
import { Screen as Surface } from "../src/tui/term/screen.ts";
import { theme } from "../src/tui/ui/theme.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

/** The log's page size in src/view/local.ts. */
const PAGE = 50;
const TOTAL = PAGE + 7;

let dir: string;
let app: App;
let alice: User;
let repo: Repo;

const W = 110;
const H = 80;

/** A stand-in app: records pushed screens, lets the test await loads. */
function harness() {
  const pending: Promise<unknown>[] = [];
  const pushed: Screen[] = [];
  const toasts: string[] = [];
  const ctx = {
    theme: theme("dark"),
    push: (s: Screen) => void pushed.push(s),
    pop: () => {},
    replace: () => {},
    invalidate: () => {},
    toast: (t: string) => void toasts.push(t),
    hit: () => {},
    track: <T>(p: Promise<T>) => {
      pending.push(p);
      return p;
    },
  } as unknown as Ctx;
  const f = new Session(app, {
    sshUsername: "t",
    remoteAddress: "127.0.0.1",
    user: alice,
  });
  const settle = async () => {
    while (pending.length > 0) await pending.shift();
  };
  const draw = (screen: Screen): string => {
    const s = new Surface(W, H);
    screen.render({ x: 0, y: 0, w: W, h: H }, s);
    return s.toText();
  };
  const press = (screen: Screen, key: string, n = 1) => {
    for (let i = 0; i < n; i++)
      screen.key({ type: "key", key, ctrl: false, alt: false, shift: false });
  };
  const open = async (ref: string) => {
    const screen = commitsScreen(f, ctx, local(f, repo), ref);
    await screen.load!(new AbortController().signal);
    return screen;
  };
  return { ctx, f, pushed, toasts, settle, draw, press, open };
}

const subjects = (text: string): number[] =>
  [...text.matchAll(/change #(\d+)/g)].map((m) => Number(m[1]));

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-commits-"));
  app = createApp({ dataDir: dir, port: 0 });
  const a = await seedAdmin(app, {
    username: "alice",
    email: "alice@forge.test",
    password: "a-long-passphrase",
  });
  if (!a.ok) throw new Error("signup failed");
  alice = a.value;
  const made = await createRepo(app, alice, { name: "log", visibility: "public" });
  if (!made.ok) throw new Error("repo creation failed");
  repo = getRepo(app.db, "alice", "log")!;
  for (let i = 1; i <= TOTAL; i++) {
    const r = await commitToBranch(app, alice, repo, {
      message: `change #${i}`,
      files: [{ path: "counter.txt", content: `count ${i}\n` }],
    });
    if (!r.ok) throw new Error(`commit ${i} failed: ${JSON.stringify(r.error)}`);
  }
  const side = await commitToBranch(app, alice, repo, {
    branch: "side",
    message: "side only work",
    files: [{ path: "side.txt", content: "on the side\n" }],
  });
  if (!side.ok) throw new Error("side branch failed");
}, 120_000);

afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("the log pages through a real row", () => {
  test("the first page is newest first and ends in 'Load more…'", async () => {
    const h = harness();
    const screen = await h.open(repo.defaultBranch);
    const text = h.draw(screen);
    const seen = subjects(text);
    expect(seen[0]).toBe(TOTAL);
    expect(seen).toEqual([...seen].sort((a, b) => b - a));
    expect(text).toContain("Load more…");
    expect(text).not.toContain(`change #${TOTAL - PAGE}\n`);
  });

  test("the cursor lands on it and choosing it appends the rest, none twice, none missing", async () => {
    const h = harness();
    const screen = await h.open(repo.defaultBranch);
    const first = subjects(h.draw(screen));
    // PAGE commits, then the row: moving down PAGE times is the row.
    h.press(screen, "j", PAGE);
    h.press(screen, "enter");
    await h.settle();
    expect(h.pushed).toHaveLength(0);
    const text = h.draw(screen);
    const all = subjects(text);
    expect(first.length).toBeLessThan(all.length);
    expect(all).toHaveLength(new Set(all).size);
    expect(all.length).toBeGreaterThanOrEqual(TOTAL - 1); // the initial commit has another subject
    const want = Array.from({ length: all.length }, (_, i) => TOTAL - i);
    expect(all).toEqual(want);
    expect(text).not.toContain("Load more…");
  });
});

describe("a commit opens", () => {
  test("choosing it shows its message and its diff", async () => {
    const h = harness();
    const screen = await h.open(repo.defaultBranch);
    h.press(screen, "j", 2);
    h.press(screen, "enter");
    expect(h.pushed).toHaveLength(1);
    const detail = h.pushed[0]!;
    await detail.load!(new AbortController().signal);
    const text = h.draw(detail);
    expect(text).toContain(`change #${TOTAL - 2}`);
    expect(text).toContain("counter.txt");
    expect(text).toContain(`- count ${TOTAL - 3}`);
    expect(text).toContain(`+ count ${TOTAL - 2}`);
  });
});

describe("a branch other than the default", () => {
  test("shows its own log", async () => {
    const h = harness();
    const screen = await h.open("side");
    const text = h.draw(screen);
    expect(text).toContain("side only work");
    expect(text).toContain(`change #${TOTAL}`);
    const main = h.draw(await h.open(repo.defaultBranch));
    expect(main).not.toContain("side only work");
  });
});
