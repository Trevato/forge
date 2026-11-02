import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { listIssues } from "../src/core/issues.ts";
import { getRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { startPerfWatcher } from "../src/perf/duty.ts";
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
