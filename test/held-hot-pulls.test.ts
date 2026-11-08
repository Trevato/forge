/** A hot-file hold names the open pulls on that file, oldest first, in the map answer and the held card (#7491). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createIssue } from "../src/core/issues.ts";
import { PULLS_NAMED, pullsTouching, rememberPullFiles } from "../src/crew/hot_files.ts";
import { readHeld } from "../src/flow/held.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { heldLines } from "../src/tui/screens/flow.ts";
import { heldCard } from "../src/web/pages/boards-held.ts";
import { seedAdmin } from "./helpers/admin.ts";

const SEED = [
  { number: 31, files: ["src/hot.ts"] },
  { number: 12, files: ["src/hot.ts", "a.ts"] },
  { number: 20, files: ["src/hot.ts"] },
  { number: 25, files: ["src/hot.ts"] },
  { number: 26, files: ["src/hot.ts"] },
  { number: 40, files: ["other.ts"] },
];

let dataDir = "";
let app: App, servers: Servers, repoId = "", issueNo = 0;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-heldpulls-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const admin = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!admin.ok) throw new Error(admin.error);
  const made = await createRepo(app, admin.value, { name: "notes", visibility: "public", description: "" });
  if (!made.ok) throw new Error(String(made.error));
  repoId = made.value.id;
  app.db.run("UPDATE repo SET autonomy = 'autonomous', autonomy_by = ?2 WHERE id = ?1", [repoId, admin.value.id]);
  rememberPullFiles(repoId, SEED);
  const r = createIssue(app.db, { repoId, authorId: admin.value.id, title: "Add a flag to src/hot.ts", body: "", sealed: false });
  if (!r.ok) throw new Error(r.error);
  issueNo = r.value.number;
});

afterAll(async () => {
  rememberPullFiles(repoId, []);
  servers.stop?.();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("pullsTouching lists pull numbers oldest first and stops at eight", () => {
  expect(pullsTouching(repoId, "src/hot.ts")).toEqual([12, 20, 25, 26, 31]);
  rememberPullFiles(repoId, Array.from({ length: 12 }, (_, i) => ({ number: 50 - i, files: ["x.ts"] })));
  const many = pullsTouching(repoId, "x.ts");
  expect(many).toHaveLength(PULLS_NAMED);
  expect(many[0]).toBe(39);
  rememberPullFiles(repoId, SEED);
});

test("the map answer carries the pulls on a held issue, oldest first", async () => {
  const body = (await (await fetch(`${servers.url}/api/v1/repos/alice/notes/map`)).json()) as {
    ready: { number: number; held: { by: string; detail: string; pulls: number[] } | null }[];
  };
  const held = body.ready.find((r) => r.number === issueNo)!.held!;
  expect(held.by).toBe("hot_file");
  expect(held.detail).toBe("src/hot.ts is in 5 open pulls");
  expect(held.pulls).toEqual([12, 20, 25, 26, 31]);
});

test("the held card links them after the sentence, in order", () => {
  const page = String(heldCard(readHeld(app, true, Date.now() + 60_000)));
  expect(page).toContain(`data-held-hot-issue="${issueNo}"`);
  const at = (n: number) => page.indexOf(`href="/alice/notes/pulls/${n}"`);
  expect(page.indexOf("src/hot.ts is in 5 open pulls")).toBeGreaterThan(-1);
  expect(at(12)).toBeGreaterThan(page.indexOf("src/hot.ts is in 5 open pulls"));
  expect([12, 20, 25, 26, 31].map(at)).toEqual([...[12, 20, 25, 26, 31].map(at)].sort((a, b) => a - b));
  expect(at(40)).toBe(-1);
});

test("the terminal's Flow lines name the pulls too", () => {
  const lines = heldLines(readHeld(app, true, Date.now() + 120_000), 200).join("\n");
  expect(lines).toContain(`#${issueNo} waits: src/hot.ts is in 5 open pulls: #12 #20 #25 #26 #31`);
});

test("a guest is told neither the number of a sealed pull nor a count that includes it", () => {
  app.db.run(
    "INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, sealed) VALUES ('sp', ?1, 26, 'pull', 's', '', (SELECT id FROM user LIMIT 1), 'open', 1)",
    [repoId],
  );
  rememberPullFiles(repoId, [...SEED, { number: 27, files: ["src/hot.ts"] }]);
  const now = Date.now() + 300_000;
  const guest = String(heldCard(readHeld(app, false, now)));
  expect(guest).toContain("src/hot.ts is in 5 open pulls");
  expect(guest).not.toContain("/pulls/26");
  expect(guest).not.toContain("#26");
  expect(heldLines(readHeld(app, false, now), 200).join("\n")).not.toContain("#26");
  const owner = String(heldCard(readHeld(app, true, now)));
  expect(owner).toContain("src/hot.ts is in 6 open pulls");
  expect(owner).toContain("/pulls/26");
  rememberPullFiles(repoId, SEED);
  app.db.run("DELETE FROM issue WHERE id = 'sp'");
});
