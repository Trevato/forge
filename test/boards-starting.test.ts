/**
 * The forge offers the Usage, Crew and Security boards on boot: every panel runs, an
 * edit survives the next boot, and a deletion is not undone.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changeBoard, deleteBoard, offerStartingBoards } from "../src/actions/boards.ts";
import { createApp } from "../src/app.ts";
import { runQuery } from "../src/boards/query.ts";
import { STARTING_BOARDS } from "../src/boards/starting.ts";
import { listBoards, readBoard } from "../src/boards/store.ts";
import { createUser, type User } from "../src/core/users.ts";

let dir: string;
let app: ReturnType<typeof createApp>;
let admin: User;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-boards-starting-"));
  app = createApp({ dataDir: dir, port: 0 });
  const made = await createUser(app.db, { username: "alice", email: "a@x.test", password: "correct horse battery", isAdmin: true });
  if (!made.ok) throw new Error("no admin");
  admin = made.value;
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("a forge with no person to found the repo writes nothing", async () => {
  const bare = createApp({ dataDir: await mkdtemp(join(tmpdir(), "forge-boards-bare-")), port: 0 });
  expect(await offerStartingBoards(bare)).toEqual([]);
});

test("a fresh boot writes Usage, Crew and Security, and every panel runs", async () => {
  expect((await offerStartingBoards(app)).sort()).toEqual(["crew", "security", "usage"]);
  const boards = await listBoards(app.reposRoot);
  expect(boards.map((b) => b.slug)).toEqual(["crew", "security", "usage"]);
  let panels = 0;
  for (const { board } of boards) {
    for (const p of board.panels) {
      const ran = runQuery(app.db, p.query, { repoIds: "all" });
      expect(ran.ok).toBe(true);
      panels++;
    }
  }
  expect(panels).toBe(STARTING_BOARDS.usage!.panels.length + STARTING_BOARDS.crew!.panels.length + STARTING_BOARDS.security!.panels.length);
});

test("a second boot leaves an edit in place", async () => {
  const edited = await changeBoard(app, admin, "usage", { kind: "title", title: "My usage" });
  expect(edited.ok).toBe(true);
  expect(await offerStartingBoards(app)).toEqual([]);
  expect((await readBoard(app.reposRoot, "usage"))?.title).toBe("My usage");
});

test("a deleted starting board stays deleted", async () => {
  expect((await deleteBoard(app, admin, "crew")).ok).toBe(true);
  expect(await offerStartingBoards(app)).toEqual([]);
  expect(await readBoard(app.reposRoot, "crew")).toBeUndefined();
});
