import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import type { Ranked } from "../src/core/dependencies.ts";
import type { Issue } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import type { Run } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { holdFile } from "../src/crew/file_holds.ts";
import { heldBy, mapHolds } from "../src/crew/held.ts";
import { holdHot, hotOverlap, hotSays, relievedFiles, rememberPullFiles, standingHot } from "../src/crew/hot_files.ts";

const HOT = "src/tui/forge.ts";

test("only paths on both lines are relieved, at most three", () => {
  const body = (files: string, rel: string) => `Files: ${files}\nRelieves: ${rel}`;
  expect(relievedFiles({ body: body("src/a.ts, src/b.ts", "src/a.ts, src/c.ts") })).toEqual(["src/a.ts"]);
  expect(relievedFiles({ body: "Relieves: src/a.ts" })).toEqual([]);
  expect(relievedFiles({ body: body("src/a.ts, src/b.ts, src/c.ts, src/d.ts", "src/a.ts src/b.ts src/c.ts src/d.ts") })).toHaveLength(3);
});

test("a relieved hot file is left out of the overlap, an unlisted one is not", () => {
  const hot = new Map([[HOT, 7]]);
  expect(hotOverlap({ title: "t", body: `Files: ${HOT}\nRelieves: ${HOT}` }, hot)).toEqual([]);
  expect(hotOverlap({ title: "t", body: `Files: ${HOT}\nRelieves: src/other.ts` }, hot)).toEqual([{ path: HOT, pulls: 7 }]);
  expect(hotOverlap({ title: "t", body: `Relieves: ${HOT}\nSee ${HOT}` }, hot)).toEqual([{ path: HOT, pulls: 7 }]);
});

let dataDir: string;
let app: App;
let alice: User;
let repo: Repo;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-relieves-"));
  app = createApp({ dataDir, port: 0 });
  const a = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!a.ok) throw new Error(a.error);
  alice = a.value;
  const made = await createRepo(app, alice, { name: "engine", visibility: "private" });
  if (!made.ok) throw new Error(String(made.error));
  repo = getRepoById(app.db, made.value.id)!;
  rememberPullFiles(repo.id, Array.from({ length: 6 }, (_, i) => ({ number: 900 + i, files: [HOT] })));
});

afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

function issue(title: string, body: string): Issue {
  const opened = openIssue(app, alice, getRepoById(app.db, repo.id)!, { title, body });
  if (!opened.ok) throw new Error(String(opened.error));
  return opened.value;
}

const ranked = (i: Issue) => ({ issue: i }) as unknown as Ranked;
const running = (i: Issue) => ({ issueId: i.id }) as unknown as Run;
const sort = (issues: Issue[], active: Run[] = []) => heldBy(app, repo, issues.map(ranked), [], active);

test("a relieving issue starts on a hot file, a plain one waits", () => {
  const relieve = issue("Split palette entries", `Files: ${HOT}\nRelieves: ${HOT}`);
  const plain = issue("Touch the hot file", `Files: ${HOT}`);
  const held = sort([relieve, plain]);
  expect(held.startable.map((r) => r.issue.number)).toEqual([relieve.number]);
  expect(held.by.hot_file.map((i) => i.number)).toEqual([plain.number]);
});

test("a second relieving issue on the same path waits for the one in flight", () => {
  const first = issue("Split palette, part 1", `Files: ${HOT}\nRelieves: ${HOT}`);
  const second = issue("Split palette, part 2", `Files: ${HOT}\nRelieves: ${HOT}`);
  const held = sort([second], [running(first)]);
  expect(held.startable).toEqual([]);
  expect(held.by.hot_file.map((i) => i.number)).toEqual([second.number]);
  const relieving = held.relieving.get(second.number)!;
  expect(relieving).toEqual({ path: HOT, by: first.number });
  expect(mapHolds(repo, held).holds.get(second.number)!.detail).toBe(
    `waits: ${HOT} is already being relieved by #${first.number}`,
  );
  expect(hotSays({ number: second.number, title: "", files: [], relieving })).toBe(
    `#${second.number} waits: ${HOT} is already being relieved by #${first.number}.`,
  );
  // Both ready at once: only the first starts.
  const both = sort([first, second]);
  expect(both.startable.map((r) => r.issue.number)).toEqual([first.number]);
});

test("a path on Relieves: but not on Files: changes nothing", () => {
  const sly = issue("Sneak in", `Files: src/cold.ts\nRelieves: ${HOT}\nSee ${HOT}`);
  const hot = new Map([[HOT, 6]]);
  expect(hotOverlap(sly, hot)).toEqual([]); // Files: names no hot file, as before
  const naming = issue("Name it", `Files: ${HOT}\nRelieves: src/cold.ts`);
  expect(sort([naming]).by.hot_file.map((i) => i.number)).toEqual([naming.number]);
});

test("a pinned file still holds a relieving issue", () => {
  const relieve = issue("Split again", `Files: ${HOT}\nRelieves: ${HOT}`);
  const pinned = holdFile(app.db, repo.id, HOT, alice.id);
  expect(pinned.ok).toBe(true);
  const held = sort([relieve]);
  expect(held.startable).toEqual([]);
  expect(held.pinned.get(relieve.number)?.path).toBe(HOT);
});

test("the picker's record carries the wait, and the feed sentence reads from it", () => {
  const second = issue("Split palette, part 3", `Files: ${HOT}\nRelieves: ${HOT}`);
  holdHot(repo.id, [second], new Date(), new Map(), new Map([[second.number, { path: HOT, by: 7299 }]]));
  const hold = standingHot(repo.id)!.holds[0]!;
  expect(hold.relieving).toEqual({ path: HOT, by: 7299 });
  expect(hotSays(hold)).toBe(`#${second.number} waits: ${HOT} is already being relieved by #7299.`);
  holdHot(repo.id, []);
});
