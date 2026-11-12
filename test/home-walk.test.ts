/**
 * The home is the feed, walked end to end (#1802): signed in, `GET /` shows
 * the composer, then the timeline; a tell posted through the composer is a
 * post; a crew member's run and pull are posts with its name; a share
 * arrives as a post that says who shared it; the apps are one link away.
 */
import { freshHome } from "./helpers/home-fresh.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { share } from "../src/feed/share.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

let dataDir: string;
let app: App;
let servers: Servers;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-home-walk-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("composer, timeline, a tell, a crew member's run and pull, a share, the apps one link away", async () => {
  const mk = async (username: string, first = false): Promise<User> => {
    const r = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: first,
    });
    if (!r.ok) throw new Error(r.error);
    promote(app.db, r.value);
    return r.value;
  };
  const root = await mk("keeper", true);
  const alice = await mk("alice");
  const bob = await mk("bob");
  const made = await createAgent(app, root, { username: "scribe", brief: "Be brief." });
  if (!made.ok) throw new Error(String(made.error));
  const bot = made.value.user;
  const repo = await createRepo(app, alice, { name: "garden", visibility: "public" });
  if (!repo.ok) throw new Error("repo");
  expect(addToCrew(app, root, repo.value, "scribe").ok).toBe(true);
  const cookie = (u: User) => `forge_session=${createSession(app.db, u.id).token}; forge_mode=studio`;
  const home = (u: User) => freshHome(servers.url, cookie(u), "/feed");

  // The composer comes first, then the timeline.
  const first = await home(alice);
  const composer = first.indexOf('id="composer"');
  expect(composer).toBeGreaterThan(-1);
  expect(first.indexOf('id="live-feed"')).toBeGreaterThan(composer);

  // A tell posted through the composer appears as a post, one tap from it.
  const posted = await fetch(`${servers.url}/tell`, {
    method: "POST",
    headers: { cookie: cookie(alice), origin: servers.url },
    body: new URLSearchParams({ app: "alice/garden", text: "Plant the beans" }),
    redirect: "manual",
  });
  expect(posted.status).toBe(303);
  expect(await home(alice)).toMatch(
    /href="\/alice\/garden\/issues\/1"[^>]*data-feed-open>opened an issue: Plant the beans</,
  );

  // The crew member's run and pull are posts under its name.
  const run = app.bus.append({
    kind: "run.finished",
    repoId: repo.value.id,
    actorId: bot.id,
    payload: { kind: "agent", state: "ok", summary: "Sorted the seed list", runId: "r1" },
  });
  app.bus.append({
    kind: "pull.opened",
    repoId: repo.value.id,
    actorId: bot.id,
    payload: {},
  });
  const page = await home(alice);
  expect(page).toContain("Sorted the seed list");
  expect(page).toMatch(/<strong class="break">scribe<\/strong\s*>\s*<span[^>]*data-mark="crew"/);
  expect(page).toContain("opened a pull request");

  // A share reaches another person as a post that says who shared it.
  const shared = await share(app, alice, `event:${run.id}`, ["bob"]);
  expect(shared.ok).toBe(true);
  expect(await home(bob)).toContain("shared by alice");

  // The apps are one link away.
  expect(page).toContain('href="/apps"');
});
