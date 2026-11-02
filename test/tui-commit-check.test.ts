/**
 * The terminal's history says each commit's check, as MCP `commits` with
 * `oid` does: a mark in the log for green or red, a line under the title of
 * one commit, nothing where no check ran or the viewer may not read runs.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createApp as createAppRecord } from "../src/core/apps.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { createRun, finishRun } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import type { CommitCheck } from "../src/checks/commit_check.ts";
import type { Ctx, Screen } from "../src/tui/app/app.ts";
import { checkLine, commitScreen, commitsScreen } from "../src/tui/screens/commits.ts";
import { local } from "../src/tui/screens/where.ts";
import { Session } from "../src/tui/session.ts";
import { Screen as Surface } from "../src/tui/term/screen.ts";
import { theme } from "../src/tui/ui/theme.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir: string;
let app: App;
let alice: User;
let repo: Repo;
let priv: Repo;
let bob: User;
let appRepo: Repo;
let viaRepo: Repo;
let viaOids: string[] = [];
const oids: string[] = [];

const ctx = {
  theme: theme("dark"),
  push: () => {},
  pop: () => {},
  replace: () => {},
  invalidate: () => {},
  toast: () => {},
  hit: () => {},
  track: <T>(p: Promise<T>) => p,
} as unknown as Ctx;

const draw = (screen: Screen): string => {
  const s = new Surface(110, 30);
  screen.render({ x: 0, y: 0, w: 110, h: 30 }, s);
  return s.toText();
};

const session = (user: User | undefined) =>
  new Session(app, { sshUsername: "t", remoteAddress: "127.0.0.1", user });

async function check(r: Repo, oid: string, state: "ok" | "failed", summary: string) {
  const run = createRun(app.db, {
    repoId: r.id,
    kind: "check",
    env: r.defaultBranch,
    commitOid: oid,
  });
  app.db.query("UPDATE run SET state = 'running' WHERE id = ?1").run(run.id);
  finishRun(app.db, run.id, { state, summary });
}

async function seed(name: string, visibility: "public" | "private") {
  const made = await createRepo(app, alice, { name, visibility });
  if (!made.ok) throw new Error("repo creation failed");
  const r = getRepo(app.db, "alice", name)!;
  const list: string[] = [];
  for (const n of ["green", "red", "none"]) {
    const c = await commitToBranch(app, alice, r, {
      message: `${n} change`,
      files: [{ path: `${n}.txt`, content: `${n}\n` }],
    });
    if (!c.ok) throw new Error("commit failed");
    const log = await local(session(alice), r).commits(r.defaultBranch);
    if (!log.ok) throw new Error("log failed");
    list.push(log.value.items[0]!.oid);
  }
  return { r, list };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-commit-check-"));
  app = createApp({ dataDir: dir, port: 0 });
  const a = await seedAdmin(app, {
    username: "alice",
    email: "alice@forge.test",
    password: "a-long-passphrase",
  });
  if (!a.ok) throw new Error("signup failed");
  alice = a.value;
  const pub = await seed("pub", "public");
  repo = pub.r;
  oids.push(...pub.list);
  await check(repo, oids[0]!, "ok", "");
  await check(repo, oids[1]!, "failed", "step typecheck failed");
  const hidden = await seed("hidden", "private");
  priv = hidden.r;
  await check(priv, hidden.list[1]!, "failed", "step typecheck failed");
  oids.push(...hidden.list);
  const b = await createUser(app.db, {
    username: "bob",
    email: "bob@forge.test",
    password: "a-long-passphrase",
    origin: "seed",
    trusted: true,
  });
  if (!b.ok) throw new Error("bob failed");
  bob = b.value;
  // Public to read, but its runs answer only to those who may enter the private app.
  const walled = await seed("walled", "public");
  appRepo = walled.r;
  await check(appRepo, walled.list[0]!, "ok", "");
  oids.push(...walled.list);
  const madeApp = createAppRecord(app.db, { repoId: appRepo.id, slug: "walled", access: "private" });
  if (!madeApp.ok) throw new Error("app failed");
  // main moved on: the head's check covers the commits before it.
  const via = await seed("via", "public");
  viaRepo = via.r;
  viaOids = via.list;
  await check(viaRepo, viaOids[2]!, "ok", "");
}, 120_000);

afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const rowOf = (text: string, subject: string): string =>
  text.split("\n").find((l) => l.includes(subject)) ?? "";

describe("the log marks green and red", () => {
  test("a green and a red row carry a mark, a row with none does not", async () => {
    const f = session(alice);
    const screen = commitsScreen(f, ctx, local(f, repo), repo.defaultBranch);
    await screen.load!(new AbortController().signal);
    const text = draw(screen);
    expect(rowOf(text, "green change")).toContain("✓");
    expect(rowOf(text, "red change")).toContain("✗");
    expect(rowOf(text, "none change")).not.toMatch(/[✓✗]/);
  });

  test("a viewer who cannot read the repository's runs sees no mark", async () => {
    const f = session(undefined);
    const screen = commitsScreen(f, ctx, local(f, priv), priv.defaultBranch);
    await screen.load!(new AbortController().signal);
    expect(draw(screen)).not.toMatch(/[✓✗]/);
  });
});

describe("a viewer who sees the repository but may not read its runs", () => {
  test("the log has no mark for them, and does for a writer", async () => {
    const mark = async (user: User) => {
      const f = session(user);
      const screen = commitsScreen(f, ctx, local(f, appRepo), appRepo.defaultBranch);
      await screen.load!(new AbortController().signal);
      return draw(screen);
    };
    expect(rowOf(await mark(alice), "green change")).toContain("✓");
    const seen = await mark(bob);
    expect(seen).toContain("green change");
    expect(seen).not.toMatch(/[✓✗]/);
  });

  test("the one-commit view has no check line for them, and does for a writer", async () => {
    const open = async (user: User) => {
      const f = session(user);
      const src = local(f, appRepo);
      const found = await src.commit(oids[6]!);
      if (!found.ok) throw new Error("commit not found");
      const screen = commitScreen(f, ctx, src, found.value.commit);
      await screen.load!(new AbortController().signal);
      return draw(screen);
    };
    expect(await open(alice)).toContain("check: green");
    expect(await open(bob)).not.toContain("check:");
  });
});

describe("a check that comes from a later commit says so", () => {
  test("the log leaves the row unmarked and the commit line names the commit that answered", async () => {
    const f = session(alice);
    const src = local(f, viaRepo);
    const log = commitsScreen(f, ctx, src, viaRepo.defaultBranch);
    await log.load!(new AbortController().signal);
    expect(rowOf(draw(log), "green change")).not.toMatch(/[✓✗]/);
    const found = await src.commit(viaOids[0]!);
    if (!found.ok) throw new Error("commit not found");
    const screen = commitScreen(f, ctx, src, found.value.commit);
    await screen.load!(new AbortController().signal);
    expect(draw(screen)).toContain(`check: green · via ${viaOids[2]!.slice(0, 8)}`);
  });
});

describe("a failing look-up does not stop the diff", () => {
  test("the screen is still invalidated for a redraw", async () => {
    const broken = Object.create(app, {
      db: {
        get() {
          throw new Error("db gone");
        },
      },
    }) as App;
    const f = new Session(broken, { sshUsername: "t", remoteAddress: "127.0.0.1", user: alice });
    const src = local(session(alice), repo);
    const found = await src.commit(oids[0]!);
    if (!found.ok) throw new Error("commit not found");
    let drawn = 0;
    const screen = commitScreen(f, { ...ctx, invalidate: () => drawn++ } as Ctx, src, found.value.commit);
    await screen.load!(new AbortController().signal);
    expect(drawn).toBe(1);
  });
});

describe("one commit says its check under its title", () => {
  const open = async (user: User | undefined, r: Repo, oid: string) => {
    const f = session(user);
    const src = local(f, r);
    const found = await src.commit(oid);
    if (!found.ok) throw new Error("commit not found");
    const screen = commitScreen(f, ctx, src, found.value.commit);
    await screen.load!(new AbortController().signal);
    return draw(screen);
  };

  test("green, red with the failing step, and not run", async () => {
    expect(await open(alice, repo, oids[0]!)).toContain("check: green");
    expect(await open(alice, repo, oids[1]!)).toContain("check: red · step typecheck failed");
    expect(await open(alice, repo, oids[2]!)).toContain("check: not run");
  });

  test("an unreadable repository shows no check", async () => {
    expect(await open(undefined, priv, oids[4]!)).not.toContain("check:");
  });

  test("checkLine is empty without an answer", () => {
    expect(checkLine(null)).toBe("");
  });

  test("checkLine words running, superseded, and a red with no summary", () => {
    const base: CommitCheck = {
      commit: "a".repeat(40),
      checkedCommit: "a".repeat(40),
      state: "pending",
      runId: "r",
      summary: "",
      finishedAt: null,
    };
    expect(checkLine(base)).toBe("check: running");
    expect(checkLine({ ...base, state: "superseded" })).toBe("check: superseded");
    expect(checkLine({ ...base, state: "failed" })).toBe("check: red");
    expect(checkLine({ ...base, state: "none" })).toBe("check: not run");
    expect(checkLine({ ...base, state: "ok", checkedCommit: "b".repeat(40) })).toBe(
      "check: green · via bbbbbbbb",
    );
  });
});
