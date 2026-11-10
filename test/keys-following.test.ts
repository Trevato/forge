/** The real /:owner/:name/following page: its proposals to the parent forge are j/k rows (#10774). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { expectListKeys, mainOf, navHrefs } from "./helpers/shell-page.ts";

quietLogs();

let dir = "";
let app: App;
let servers: Servers;
let repoId = "";
let cookie = "";
const FAR = Date.now() + 10 * 365 * 86_400_000; // checked "recently": the parent is not asked
const add = (n: number) =>
  app.db
    .query(
      `INSERT INTO upstream_proposal (repo_id, branch, number, title, source, state, reachable, checked_at, created_at)
       VALUES (?1, ?2, ?3, 't', 's', 'open', 1, ?4, ?4)`,
    )
    .run(repoId, `b${n}`, n, FAR);
const page = async () => {
  const res = await fetch(`${servers.url}/alice/up/following`, { headers: { cookie } });
  expect(res.status).toBe(200);
  return mainOf(await res.text());
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-keys-following-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const u = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  const repo = await createRepo(app, u.value, { name: "up", visibility: "public" });
  if (!repo.ok) throw new Error(String(repo.error));
  repoId = repo.value.id;
  await Bun.write(
    join(dir, "parent.json"),
    JSON.stringify({
      upstream: "https://parent.invalid",
      proposal: { child: "kid", token: "tok-abcdefgh" },
      forgeCode: { repo: "alice/up", upstream: "root/forge", mode: "tell-me", tip: "a".repeat(40), chain: [] },
    }),
  );
  cookie = `forge_session=${createSession(app.db, u.value.id).token}`;
}, 60_000);
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("with no proposal the page draws the empty sentence and no proposal row", async () => {
  const html = await page();
  expect(html).toContain("Nothing proposed to the parent forge yet");
  expect(await navHrefs(html)).toEqual([]);
});

test("each proposal is a row: j/k focus it, Enter opens it, fields keep their keys; Esc has nowhere to go (the parent forge is another site)", async () => {
  add(1);
  add(2);
  const html = await page();
  const hrefs = await navHrefs(html);
  expect(hrefs.length).toBe(2);
  expect(hrefs.every((h) => h.startsWith("https://parent.invalid/"))).toBe(true);
  // opened: null asserts Esc on the page does not leave: the opened page is off-site, so no return is stored for it.
  await expectListKeys({ path: "/alice/up/following", html, hrefs, opened: null });
});
