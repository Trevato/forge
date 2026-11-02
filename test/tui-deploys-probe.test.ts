/**
 * The deploys screen's `p`: the MCP tool `probe`'s knock, from the terminal.
 * A fake app that admits everyone stands behind a runtime that says it is
 * running; its table lets anyone list notes and only an admin create one, so
 * the anonymous list is `ok` and the anonymous create is wrong, and the row
 * the MCP tool keeps is the row stored. An app that is not running, has no
 * contract or is no app is said so in words; a reader, a stranger to a
 * private repository and a guest are not offered `p`, and pressing it tries
 * nothing.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { signUp } from "../src/actions/users.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { createApp as createAppRecord, type AppRecord } from "../src/core/apps.ts";
import type { Knock } from "../src/contract/probe.ts";
import { listProbes } from "../src/contract/probes.ts";
import type { Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { deploysScreen, knockLine } from "../src/tui/screens/deploys.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";
import { fixtureSlot } from "./helpers/slot.ts";
import { seedAdmin } from "./helpers/admin.ts";

quietLogs();

const CONTRACT = JSON.stringify({
  roles: {
    anon: { above: [], held: { by: "everyone" } },
    user: { above: ["anon"], held: { by: "identity", role: "user" } },
    admin: { above: ["user"], held: { by: "identity", role: "admin" } },
  },
  resources: {
    note: {
      api: "/api/notes",
      can: { list: "anon", create: "admin", read: "admin", update: "admin", delete: "admin" },
    },
  },
});

let dir: string;
let forge: Forge;
let runtime: AppsRuntime;
let alice: User;
let bob: User;
let carol: User;
let repo: Repo;
let bare: Repo;
let plain: Repo;
let vault: Repo;
let record: AppRecord;
let fake: ReturnType<typeof Bun.serve>;
let knocks = 0;
let running = true;
/** When set, the probe's own status read throws: the app died mid-knock. */
let dies = false;

const appOn = (r: Repo, slug: string): AppRecord => {
  const made = createAppRecord(forge.db, { repoId: r.id, slug, access: "public" });
  if (!made.ok) throw new Error(made.error);
  return made.value;
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-deploys-probe-"));
  forge = createApp({ dataDir: dir, port: 0 });
  runtime = new AppsRuntime(forge, { domain: "apps.test", scheme: "https", forgeUrl: "https://forge.test", concurrency: 1 });
  const a = await seedAdmin(forge, { username: "alice", email: "alice@forge.test", password: "a-long-passphrase" });
  if (!a.ok) throw new Error("signup failed");
  alice = a.value;
  const person = async (username: string): Promise<User> => {
    const made = await signUp(
      forge,
      { username, email: `${username}@forge.test`, password: "a-long-passphrase" },
      { slot: fixtureSlot(forge) },
    );
    if (!made.ok) throw new Error("signup failed");
    return made.value;
  };
  bob = await person("bob");
  carol = await person("carol");
  const repoOf = async (name: string, visibility: "public" | "private"): Promise<Repo> => {
    const r = await createRepo(forge, alice, { name, visibility });
    if (!r.ok) throw new Error("repo failed");
    return r.value;
  };
  repo = await repoOf("notes", "public");
  bare = await repoOf("bare", "public");
  plain = await repoOf("plain", "public");
  vault = await repoOf("vault", "private");
  for (const r of [repo, vault]) {
    const wrote = await commitToBranch(forge, alice, r, {
      message: "the table",
      files: [{ path: "contract.json", content: CONTRACT }],
    });
    if (!wrote.ok) throw new Error(String(wrote.error));
  }
  record = appOn(repo, "notes");
  appOn(bare, "bare");
  appOn(vault, "vault");
  // Every door open: right for the list, wrong for an anonymous create.
  fake = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => {
      knocks++;
      return Response.json({ ok: true });
    },
  });
  // The probe's own status read is the screen's only one before a knock.
  runtime.envStatus = ((_rec, env) => {
    if (env !== "production") return undefined;
    if (dies) throw new Error("the app died");
    return running
      ? { state: "running", port: fake.port, commitOid: "c".repeat(40) }
      : { state: "stopped", commitOid: "c".repeat(40) };
  }) as typeof runtime.envStatus;
});

afterAll(async () => {
  fake?.stop(true);
  await runtime?.stop();
  forge.close?.();
  await rm(dir, { recursive: true, force: true });
});

const key = (k: string) => ({ type: "key" as const, key: k, ctrl: false, alt: false, shift: false });

/** The deploys screen before `p`, then after each key pressed. */
const drive = async (who: User | null, of: Repo, keys: readonly string[] = ["p"]): Promise<string[]> => {
  const { app, session } = createForgeApp(
    forge,
    { sshUsername: who?.username ?? "guest", remoteAddress: "127.0.0.1", ...(who === null ? {} : { user: who }) },
    { terminal: headlessTerminal(220, 50), exitHooks: false },
  );
  app.start();
  await settleApp(app);
  app.push(deploysScreen(session, app.ctx, of));
  await settleApp(app);
  const frames = [app.screen.toText()];
  for (const k of keys) {
    app.dispatch(key(k));
    await settleApp(app);
    frames.push(app.screen.toText());
  }
  app.stop();
  return frames;
};
const pressP = async (who: User | null, of: Repo = repo): Promise<string> => (await drive(who, of)).at(-1)!;

test("`p` knocks on every door and lists one ok and one wrong line", async () => {
  running = true;
  knocks = 0;
  const text = await pressP(alice);
  expect(text).toContain("GET /api/notes as anon · 200 · ok");
  expect(text).toContain("POST /api/notes as anon · 200 · wrong: the table says no, the door let them in");
  expect(text).toContain("POST /api/notes as admin · 200 · ok");
  expect(knocks).toBeGreaterThan(0);
});

test("the header counts the doors: five verbs as three identities, admin's all open", async () => {
  running = true;
  const text = await pressP(alice);
  // anon and user may only list (2 ok, 8 wrong); admin may all five (5 ok).
  expect(text).toContain("alice/notes · production doors as nobody, a user and an admin · ccccccc · 7 ok · 8 wrong · 0 not asked");
});

test("the knock is the MCP tool's: probeApp keeps the row it showed", async () => {
  running = true;
  const before = listProbes(forge.db, record.id).length;
  knocks = 0;
  await pressP(alice);
  const rows = listProbes(forge.db, record.id);
  expect(rows.length).toBe(before + 1);
  const row = rows[0]!;
  expect(row.verdict).toBe("mismatch");
  expect(row.commitOid).toBe("c".repeat(40));
  expect(row.knocks.length).toBe(15);
  expect(knocks).toBe(15);
  expect(row.knocks.find((k) => k.door === "POST /api/notes" && k.as === "anon")?.verdict).toBe("mismatch");
  expect(row.said).toContain("note.create as anon: the table says no, the app said 200");
});

test("`r` on the probe knocks again and keeps another row", async () => {
  running = true;
  const before = listProbes(forge.db, record.id).length;
  const frames = await drive(alice, repo, ["p", "r"]);
  expect(frames.at(-1)).toContain("GET /api/notes as anon · 200 · ok");
  expect(listProbes(forge.db, record.id).length).toBe(before + 2);
});

test("an app that is not running says so, nothing is tried, and the `down` row is kept as MCP `probe` keeps it", async () => {
  running = false;
  knocks = 0;
  const before = listProbes(forge.db, record.id).length;
  const text = await pressP(alice);
  expect(text).toContain("Not running");
  expect(text).toContain("No door was tried; it is stopped.");
  expect(text).not.toContain("GET /api/notes");
  expect(text).not.toContain("No doors");
  expect(knocks).toBe(0);
  const rows = listProbes(forge.db, record.id);
  expect(rows.length).toBe(before + 1);
  expect(rows[0]!.verdict).toBe("down");
  expect(rows[0]!.knocks).toEqual([]);
});

test("an app with no contract, and a repository that is no app, are said so", async () => {
  running = true;
  knocks = 0;
  const none = await pressP(alice, bare);
  expect(none).toContain("No contract");
  expect(none).toContain("No sound contract.json to compare with.");
  const notApp = await pressP(alice, plain);
  expect(notApp).toContain("Not an app here");
  expect(notApp).toContain("Nothing serves this repository here.");
  expect(knocks).toBe(0);
});

test("a probe that throws is said, not left knocking", async () => {
  running = true;
  dies = true;
  try {
    const text = await pressP(alice);
    expect(text).toContain("The probe failed");
    expect(text).not.toContain("Knocking");
  } finally {
    dies = false;
  }
});

test("the key bar offers `p` to a writer and not to a reader", async () => {
  running = true;
  const [writer] = await drive(alice, repo, []);
  expect(writer).toContain("probe the running app's doors");
  const [reader] = await drive(bob, repo, []);
  expect(reader).not.toContain("probe the running app's doors");
});

test("a reader, a stranger to a private app and a guest press `p` and nothing is tried", async () => {
  running = true;
  knocks = 0;
  const before = listProbes(forge.db, record.id).length;
  for (const [who, of] of [
    [bob, repo],
    [carol, vault],
    [null, repo],
    [null, vault],
  ] as const) {
    const [first, after] = await drive(who, of);
    expect(first).not.toContain("probe the running app's doors");
    expect(after).not.toContain("› Probe");
    expect(after).not.toContain("Knocking");
    expect(after).not.toContain("/api/notes");
  }
  expect(knocks).toBe(0);
  expect(listProbes(forge.db, record.id).length).toBe(before);
});

test("knockLine: an old row's resource.verb, and each way a door goes unasked", () => {
  const base = { resource: "note", verb: "read", as: "user", cell: "yes" } as const;
  const line = (k: Omit<Knock, keyof typeof base> & Partial<Knock>) => knockLine({ ...base, ...k } as Knock);
  expect(line({ result: { kind: "admitted", status: 200 }, verdict: "ok" })).toBe("note.read as user · 200 · ok");
  expect(line({ result: { kind: "unprobed", why: "needs a row that names the actor" }, verdict: "unprobed" })).toBe(
    "note.read as user · — · not asked: needs a row that names the actor",
  );
  expect(line({ door: "GET /api/notes/0", result: { kind: "no_door", status: 404 }, verdict: "unprobed" })).toBe(
    "GET /api/notes/0 as user · 404 · not asked: no such door",
  );
  expect(
    line({ door: "GET /api/notes/0", result: { kind: "error", message: "refused\u001b[31m\nconnect" }, verdict: "unprobed" }),
  ).toBe("GET /api/notes/0 as user · — · not asked: refused [31m connect");
  expect(
    line({ door: "DELETE /api/notes/0", cell: "yes", result: { kind: "refused", status: 403 }, verdict: "mismatch" }),
  ).toBe("DELETE /api/notes/0 as user · 403 · wrong: the table says yes, the door refused");
});
