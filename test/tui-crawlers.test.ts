/** #8129: the crawler share and refusals in the terminal, a forge admin's who is a person; a member is offered nothing. */
import { quietWeek } from "./helpers/week-quiet.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser, type User } from "../src/core/users.ts";
import { setCrawlClock, takeCrawl } from "../src/http/crawl.ts";
import { createForgeApp, forgeCommands } from "../src/tui/forge.ts";
import { crawlersScreen } from "../src/tui/screens/crawlers.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let app: App;
let carol: User;
let bob: User;
const identity = (user: User) => ({ sshUsername: user.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-crawlers-"));
  app = createApp({ dataDir: dir, port: 0 });
  quietWeek(app.db);
  const mk = async (username: string, isAdmin: boolean) => {
    const r = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", isAdmin });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  carol = await mk("carol", true);
  bob = await mk("bob", false);
}, 30_000);

afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("only an admin who is a person is offered Crawlers", () => {
  const door = (u: User) => {
    const { app: tui, session } = createForgeApp(app, identity(u), { terminal: headlessTerminal(80, 24), exitHooks: false });
    const ids = forgeCommands(session)(tui.ctx).map((c) => c.id);
    tui.stop?.();
    return ids;
  };
  expect(door(carol)).toContain("crawlers");
  expect(door(bob)).not.toContain("crawlers");
});

test("the screen shows the share, the budgets that refused and the agent refused", async () => {
  setCrawlClock(app, () => 1_000_000);
  const req = () => new Request("http://x/a/b/blob/main/f", { headers: { "user-agent": "Screenbot/1.0" } });
  for (let i = 0; i < 8; i++) takeCrawl(app, req(), "/a/b/blob/main/f");
  const { app: tui, session } = createForgeApp(app, identity(carol), { terminal: headlessTerminal(140, 20), exitHooks: false });
  tui.start();
  tui.ctx.push(crawlersScreen(session, tui.ctx));
  await settleApp(tui);
  const text = tui.screen.toText();
  expect(text).toContain("Share of answering time");
  expect(text).toContain("address 2");
  expect(text).toContain("screenbot");
  tui.stop?.();
});
