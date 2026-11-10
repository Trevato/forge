/** The terminal's "Pages over budget": palette entry offered only to an admin when a page is slow, and the screen shows the lines (#10536). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser, type User } from "../src/core/users.ts";
import { Session } from "../src/tui/forge.ts";
import type { Ctx, Screen } from "../src/tui/app/app.ts";
import { entry } from "../src/tui/screens/slowpages.ts";
import { Screen as Surface } from "../src/tui/term/screen.ts";
import { theme } from "../src/tui/ui/theme.ts";
import { recordVital } from "../src/web/measure.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir: string;
let app: App;
let alice: User;
let bob: User;
const id = (user?: User) => ({ sshUsername: user?.username ?? "git", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "slow-pages-tui-"));
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

const feed = (route: string, ttfb: number) => {
  for (let i = 0; i < 12; i++) recordVital(app.db, { path: "/", ttfb, load: null, lcp: 500, inp: null, cls: 0 }, route, `c${i}`, "ua", Date.now() - 1000);
};

test("no palette entry on a fast forge; offered to an admin once a page is slow, never to others", async () => {
  feed("/fast", 40);
  expect(entry.offered(new Session(app, id(alice)))).toBe(false);
  feed("/slow-one", 500);
  expect(entry.offered(new Session(app, id(alice)))).toBe(true);
  expect(entry.offered(new Session(app, id(bob)))).toBe(false);
  expect(entry.offered(new Session(app, id()))).toBe(false);
});

test("running the entry pushes a screen that draws the slow page's line", () => {
  const pushed: Screen[] = [];
  const ctx = { theme: theme("dark"), invalidate() {}, toast() {}, push: (s: Screen) => pushed.push(s), pop() {}, copy() {}, hit() {} } as unknown as Ctx;
  entry.run(new Session(app, id(alice)), ctx);
  expect(pushed).toHaveLength(1);
  const s = new Surface(110, 20);
  pushed[0]!.render({ x: 0, y: 0, w: 110, h: 20 }, s);
  const text = s.toText();
  expect(text).toContain("/slow-one: server 500 ms");
  expect(text).toContain("slowest part: the server");
  expect(text).not.toContain("/fast");
});
