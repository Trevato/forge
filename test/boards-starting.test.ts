/**
 * The forge offers the ten starting boards on boot: every panel runs, an
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
import { OFFERED_FILE } from "../src/boards/starting.ts";
import { BOARDS_OWNER, BOARDS_REPO, listBoards, readBoard } from "../src/boards/store.ts";
import { repoDir } from "../src/git/repos.ts";
import { commitFiles } from "../src/git/write.ts";
import { createUser, type User } from "../src/core/users.ts";

let dir: string;
let app: ReturnType<typeof createApp>;
let admin: User;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-boards-starting-"));
  app = createApp({ dataDir: dir, port: 0 });
  const made = await createUser(app.db, { origin: "seed", username: "alice", email: "a@x.test", password: "correct horse battery", isAdmin: true });
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

test("a fresh boot writes the eleven starting boards, and every panel runs", async () => {
  expect((await offerStartingBoards(app)).sort()).toEqual(["apps", "crew", "forges", "maintenance", "reach", "releases", "restarts", "security", "serving", "throughput", "usage"]);
  const boards = await listBoards(app.reposRoot);
  expect(boards.map((b) => b.slug)).toEqual(["apps", "crew", "forges", "maintenance", "reach", "releases", "restarts", "security", "serving", "throughput", "usage"]);
  let panels = 0;
  for (const { board } of boards) {
    for (const p of board.panels) {
      const ran = runQuery(app.db, p.query, { repoIds: "all" });
      expect(ran.ok).toBe(true);
      panels++;
    }
  }
  expect(panels).toBe(Object.values(STARTING_BOARDS).reduce((n, b) => n + b.panels.length, 0));
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

test("a forge offered Usage, Crew and Security before gets Throughput, and the rest stay as they are", async () => {
  // As a forge from before Throughput existed: it is not in `.offered` and has no file.
  expect((await deleteBoard(app, admin, "throughput")).ok).toBe(true);
  const rewound = await commitFiles(repoDir(app.reposRoot, BOARDS_OWNER, BOARDS_REPO), {
    branch: "main",
    message: "as offered before Throughput",
    files: [{ path: OFFERED_FILE, content: `${JSON.stringify(["usage", "crew", "security"])}\n` }],
    author: { name: "forge", email: "forge@x.test" },
  });
  expect(rewound.ok).toBe(true);
  expect(await offerStartingBoards(app)).toEqual(["throughput"]);
  expect((await readBoard(app.reposRoot, "throughput"))?.title).toBe("Throughput");
  expect((await readBoard(app.reposRoot, "usage"))?.title).toBe("My usage");
  expect(await readBoard(app.reposRoot, "crew")).toBeUndefined();
  expect(await offerStartingBoards(app)).toEqual([]);
});
