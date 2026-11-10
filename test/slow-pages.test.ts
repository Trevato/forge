/** Real-user timings roll up per page; one line per page over budget, nothing when all are fast (#10536). */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser, type User } from "../src/core/users.ts";
import { slowPageLine, slowPages } from "../src/perf/watch.ts";
import { Session } from "../src/tui/forge.ts";
import { slowPageLines } from "../src/tui/screens/slowpages.ts";
import { slowPagesSection } from "../src/web/pages/system.ts";
import { recordVital } from "../src/web/measure.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir: string;
let app: App;
let alice: User;
let bob: User;
const NOW = Date.parse("2026-11-10T12:00:00Z");

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "slow-pages-"));
  app = createApp({ dataDir: dir, port: 0 });
  const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "b@forge.local", password: "a-good-passphrase" });
  if (!a.ok || !b.ok) throw new Error("users");
  alice = a.value;
  bob = b.value;
});
afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const report = (ttfb: number, lcp: number) => ({ path: "/", ttfb, load: null, lcp, inp: null, cls: 0 });
const feed = (route: string, n: number, ttfb: number, lcp: number, at = NOW - 60_000) => {
  for (let i = 0; i < n; i++) recordVital(app.db, report(ttfb, lcp), route, `c${i}`, "ua", at);
};
const identity = (user?: User) => ({ sshUsername: user?.username ?? "git", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user });

test("quiet: every page fast means no rows, no section, no terminal lines", () => {
  feed("/fast", 12, 40, 500);
  expect(slowPages(app.db, NOW)).toEqual([]);
  expect(slowPagesSection([]).text).toBe("");
  expect(slowPageLines(new Session(app, identity(alice)), app.db, NOW)).toEqual([]);
});

test("one line per page over budget, naming the slowest phase", () => {
  feed("/slow-server", 12, 400, 700);
  feed("/slow-paint", 12, 50, 3000);
  feed("/few", 3, 900, 9000); // too few reports to judge
  feed("/old", 12, 900, 9000, NOW - 2 * 3600_000); // outside the window
  const rows = slowPages(app.db, NOW);
  expect(rows.map((r) => [r.route, r.phase])).toEqual([["/slow-paint", "render"], ["/slow-server", "server"]]);
  expect(slowPageLine(rows[1]!)).toBe("/slow-server: server 400 ms (budget 150), first paint 700 ms (budget 1000); slowest part: the server");
  const html = slowPagesSection(rows).text;
  expect(html.match(/<li /g)?.length).toBe(2);
  expect(html).toContain('data-phase="render"');
});

test("the terminal gives an admin person the lines, nobody else", () => {
  expect(slowPageLines(new Session(app, identity(alice)), app.db, NOW)).toHaveLength(2);
  expect(slowPageLines(new Session(app, identity(bob)), app.db, NOW)).toEqual([]);
  expect(slowPageLines(new Session(app, identity()), app.db, NOW)).toEqual([]);
});

test("a route with markup in it is escaped", () => {
  const text = slowPagesSection([{ route: "/<b>", reports: 10, serverP95: 500, paintP95: null, phase: "server" }]).text;
  expect(text).not.toContain("<b>");
});
