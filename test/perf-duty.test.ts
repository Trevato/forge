import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { labelsFor, listIssues } from "../src/core/issues.ts";
import { getRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { startPerfWatcher } from "../src/perf/duty.ts";
import { createGitRecord } from "../src/perf/git.ts";
import { createPerfRecord, WINDOW_MS } from "../src/perf/record.ts";
import { quietLogs } from "./helpers/globals.ts";
import { proveAll } from "./helpers/verified.ts";

quietLogs();

let root = "";
let app: App;
const now = 50_000_000;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-perf-duty-"));
  app = createApp({ dataDir: root, port: 0, forgeRepo: "alice/forge" });
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  proveAll(app);
  const made = await createRepo(app, { id: u.value.id, username: "alice" } as never, { name: "forge" });
  if (!made.ok) throw new Error(made.error);
});
afterAll(() => {
  app.close();
  rmSync(root, { recursive: true, force: true });
});

const titles = () => listIssues(app.db, getRepo(app.db, "alice", "forge")!.id, { state: "open" }).map((i) => i.title);
const slow = () => {
  const r = createPerfRecord();
  for (let i = 0; i < 100; i++)
    r.add("/", {
      at: now - WINDOW_MS + (i * WINDOW_MS) / 100,
      ms: 4600,
      signedIn: false,
      phases: [{ name: "kpis", ms: 4400, hit: false }],
    });
  return r;
};

test("the watcher files a slow route once, and a restart skips the title already open", async () => {
  const stop = startPerfWatcher(app, slow(), () => now, 5);
  await Bun.sleep(60);
  stop();
  expect(titles()).toEqual(["/ is over its budget: kpis"]);
  const again = startPerfWatcher(app, slow(), () => now, 5);
  await Bun.sleep(60);
  again();
  expect(titles()).toEqual(["/ is over its budget: kpis"]);
});
test("a missing forge repo is skipped quietly", async () => {
  const other = createApp({ dataDir: mkdtempSync(join(tmpdir(), "forge-perf-none-")), port: 0, forgeRepo: "nobody/none" });
  const warn = spyOn(other.log, "warn");
  const before = other.db.query("SELECT count(*) AS n FROM issue").get() as { n: number };
  const stop = startPerfWatcher(other, slow(), () => now, 5);
  await Bun.sleep(30);
  stop();
  const after = other.db.query("SELECT count(*) AS n FROM issue").get() as { n: number };
  other.close();
  expect(warn).not.toHaveBeenCalled();
  expect(after.n).toBe(before.n);
});
test("the watcher files a slow git subcommand once (#8158)", async () => {
  const git = createGitRecord();
  for (let i = 0; i < 100; i++)
    git.add("git rev-parse", { at: now - WINDOW_MS + (i * WINDOW_MS) / 100, ms: 7000, signedIn: false, phases: [] });
  const stop = startPerfWatcher(app, createPerfRecord(), () => now, 5, git);
  await Bun.sleep(60);
  stop();
  expect(titles().filter((t) => t.startsWith("git "))).toEqual(["git rev-parse is over its budget"]);
});

test("a slow route is filed as a bug, so its clock runs from the filing (#8856)", () => {
  const repo = getRepo(app.db, "alice", "forge")!;
  const issue = listIssues(app.db, repo.id, { state: "open" }).find((i) => i.title === "/ is over its budget: kpis")!;
  expect(labelsFor(app.db, issue.id).map((l) => l.name)).toEqual(["bug"]);
});

test("the watcher folds each tick into its hour's row, driven without timers (#11477)", () => {
  app.db.query("DELETE FROM route_hour").run();
  let t = now;
  const rec = slow();
  const stop = startPerfWatcher(app, rec, () => t, 3_600_000);
  const rows = () => app.db.query<{ hour: number; n: number }, []>("SELECT hour, n FROM route_hour ORDER BY hour").all();
  stop.tick();
  expect(rows().length).toBe(1);
  const first = rows()[0]!;
  t += 60_000;
  rec.add("/", { at: t - 1000, ms: 9, signedIn: false, phases: [] });
  stop.tick();
  expect(rows()).toEqual([{ hour: first.hour, n: first.n + 1 }]); // same hour: the row grows
  stop();
});
