/**
 * makeBoard turns a title into a slug: `Ops` is `ops`, a title with nothing
 * to slug is `no_slug` and stores nothing, a repeat title gets a fresh slug
 * and leaves the first board alone, and a non-admin is told `not_found`.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAllBoards, makeBoard, showBoard } from "../src/actions/boards.ts";
import { createApp } from "../src/app.ts";
import { createUser, type User } from "../src/core/users.ts";

let dir: string;
let app: ReturnType<typeof createApp>;
let alice: User;
let bob: User;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-board-make-slug-"));
  app = createApp({ dataDir: dir, port: 0 });
  const mk = async (username: string, adminIfFirst?: boolean) => {
    const r = await createUser(app.db, {
      origin: "seed", trusted: true, username, email: `${username}@forge.local`,
      password: "a-good-passphrase", ...(adminIfFirst ? { adminIfFirst } : {}),
    });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  alice = await mk("alice", true);
  bob = await mk("bob");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const slugs = async () => {
  const all = await listAllBoards(app, alice);
  if (!all.ok) throw new Error(all.error);
  return all.value.map((s) => s.slug).sort();
};

test("a non-admin is refused and nothing is stored", async () => {
  expect(await makeBoard(app, bob, "Ops")).toEqual({ ok: false, error: "not_found" });
  expect(await makeBoard(app, undefined, "Ops")).toEqual({ ok: false, error: "not_found" });
  expect(await slugs()).toEqual([]);
});

test("a title of only punctuation or emoji is no_slug and no board is stored", async () => {
  for (const title of ["!!!", "  ---  ", "🔥🔥", ""]) {
    expect(await makeBoard(app, alice, title)).toEqual({ ok: false, error: "no_slug" });
  }
  expect(await slugs()).toEqual([]);
});

test("an admin makes Ops as ops, and a second Ops gets a fresh slug", async () => {
  const first = await makeBoard(app, alice, "Ops");
  expect(first).toEqual({ ok: true, value: "ops" });
  const before = await showBoard(app, alice, "ops");

  const second = await makeBoard(app, alice, "Ops");
  expect(second.ok).toBe(true);
  if (!second.ok) return;
  expect(second.value).not.toBe("ops");
  expect(await slugs()).toEqual(["ops", second.value].sort());
  expect(await showBoard(app, alice, "ops")).toEqual(before);
  expect(await showBoard(app, alice, second.value)).toMatchObject({ ok: true, value: { title: "Ops" } });
});
