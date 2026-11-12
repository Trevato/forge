/** The line under the home timeline's last post: how far back it reaches, and the way on. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import type { FeedItem } from "../src/feed/rank.ts";
import { caughtUp, FEED_FIRST_PAGE, feedJs } from "../src/web/studio/feed.ts";
import { promote } from "./helpers/members.ts";
import { freshHome } from "./helpers/home-fresh.ts";

describe("the timeline's caught-up line", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let cookie: string;
  let repo: Repo;

  const emit = (n: number) => {
    for (let i = 0; i < n; i++)
      app.bus.append({ kind: "run.finished", repoId: repo.id, actorId: alice.id, payload: { kind: "agent", state: "ok", summary: `work ${i}`, runId: `r${i}` } });
  };
  const home = (path = "/feed") => freshHome(servers.url, cookie, path);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-caught-up-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    for (const [name, first] of [["root", true], ["alice", false]] as const) {
      const r = await createUser(app.db, { origin: "seed", trusted: true, username: name, allowReserved: true, email: `${name}@forge.local`, password: "a-good-passphrase", adminIfFirst: first });
      if (!r.ok) throw new Error(r.error);
      promote(app.db, r.value);
      if (name === "alice") alice = r.value;
    }
    cookie = `forge_session=${createSession(app.db, alice.id).token}`;
    const made = await createRepo(app, alice, { name: "open", visibility: "public" });
    if (!made.ok) throw new Error("repo");
    repo = made.value;
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a short feed says that is everything, with no link", async () => {
    emit(3);
    const text = await home();
    expect(text).toContain("That's everything");
    expect(text).not.toContain("Older posts");
  });

  test("a feed with more pages says how far it reaches and links to the next", async () => {
    emit(FEED_FIRST_PAGE + 5);
    const text = await home();
    expect(text).toContain("You're caught up to");
    expect(text).not.toContain("That's everything");
    const href = /href="(\/feed\?cursor=[^"]+)"[^>]*>Older posts/.exec(text);
    expect(href).not.toBeNull();
    const older = await home(href![1]!.replaceAll("&amp;", "&"));
    expect(older).toContain("data-item=");
    expect(older).toContain("That's everything");
    expect(older).toContain('<a href="/feed">Newest</a>');
    expect(text).not.toContain(">Newest<");
  });

  test("a page after the first carries its own address, so a chip refetch stays on it", async () => {
    const href = /href="(\/feed\?cursor=[^"]+)"[^>]*>Older posts/.exec(await home())![1]!.replaceAll("&amp;", "&");
    const cursor = href.slice("/feed?cursor=".length).split("&day=")[0];
    const older = await home(href);
    expect(older).toContain(`data-live-src="/live/feed?cursor=${cursor}&amp;day=`);
    expect(await home()).toContain('data-live-src="/live/feed"');
    expect(feedJs).toContain("feed.getAttribute('data-live-src')");
  });

  test("the time is the oldest shown, not the last in score order", () => {
    const item = (id: string, at: string) => ({ id, at }) as FeedItem;
    const html = String(caughtUp([item("a", "2020-01-01T00:00:00.000Z"), item("b", "2024-06-01T00:00:00.000Z")], "n"));
    expect(html).toContain("2020-01-01T00:00:00.000Z");
    expect(html).not.toContain("2024-06-01T00:00:00.000Z");
  });

  test("a cursor not issued here is the first page", async () => {
    const text = await home("/feed?cursor=garbage");
    expect(text).toContain("You're caught up to");
  });
});
