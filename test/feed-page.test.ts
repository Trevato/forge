/**
 * The home page is the feed: server-rendered cards for the signed-in viewer,
 * every string escaped, card actions pointing at the routes that already
 * enforce them, and a fragment address the live client refreshes.
 */
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
import { readFeed } from "../src/feed/feed.ts";
import { feedCard } from "../src/web/studio/feed.ts";
import { promote } from "./helpers/members.ts";
import { withScripts } from "./helpers/page-script.ts";

describe("the feed on the home page", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let aliceCookie: string;
  let bobCookie: string;
  let secret: Repo;
  let open: Repo;
  const emit = (repo: Repo, kind: string, payload = {}) =>
    app.bus.append({ kind, repoId: repo.id, actorId: alice.id, payload });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-feed-page-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string, first = false) => {
      const r = await createUser(app.db, { origin: "seed", trusted: true,
        username,
        // Fixtures may name an account after a reserved word on purpose.
        allowReserved: true,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: first,
      });
      if (!r.ok) throw new Error(r.error);
      promote(app.db, r.value);
      return r.value;
    };
    await mk("root", true);
    alice = await mk("alice");
    bob = await mk("bob");
    aliceCookie = `forge_session=${createSession(app.db, alice.id).token}`;
    bobCookie = `forge_session=${createSession(app.db, bob.id).token}`;
    const s = await createRepo(app, alice, { name: "secret", visibility: "private" });
    const o = await createRepo(app, alice, { name: "open", visibility: "public" });
    if (!s.ok || !o.ok) throw new Error("repos");
    secret = s.value;
    open = o.value;
    emit(secret, "run.finished", { kind: "agent", state: "ok", summary: "hidden work", runId: "rs" });
    emit(open, "run.finished", {
      kind: "agent",
      state: "failed",
      summary: `<script>alert(1)</script> "x"`,
      runId: "r1",
    });
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const get = (path: string, cookie?: string, headers: Record<string, string> = {}) =>
    fetch(`${servers.url}${path}`, {
      headers: { ...(cookie ? { cookie } : {}), ...headers },
    });

  test("/ renders the ranked feed on first paint, escaped", async () => {
    const res = await get("/feed", aliceCookie);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('id="live-feed"');
    expect(text).toContain('data-live-src="/live/feed"');
    expect(text).toContain("alice/open");
    expect(text).not.toContain("<script>alert(1)</script>");
    expect(text).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    const order = [...text.matchAll(/class="card"\s+data-nav[^>]*data-item="([^"]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(readFeed(app.db, alice).items.map((i) => i.id));
  });

  test("a card links into the thing and steers or tells from where it is", async () => {
    const text = await (await get("/feed", aliceCookie)).text();
    expect(text).toContain('href="/alice/open/runs/r1"');
    expect(text).toContain('action="/alice/open/runs/r1/steer"');
    const item = readFeed(app.db, alice).items[0]!;
    const tell = feedCard({ ...item, kind: "pull", link: "/alice/open/pulls/1" }).text;
    expect(tell).toContain('action="/alice/open/tell"');
    expect(tell).toContain('data-feed="dismissed"');
    expect(tell).toContain('data-feed="muted"');
  });

  test("a hostile app or reason cannot break out of a card", () => {
    const card = feedCard({
      id: "event:e1",
      kind: "run",
      app: 'a"><img src=x onerror=1>/b',
      actor: null,
      at: new Date().toISOString(),
      link: "/a/b/runs/r",
      what: "<i>y</i>",
      reason: "<b>x</b>",
      score: 1,
    }).text;
    expect(card).not.toContain("<img");
    expect(card).not.toContain("<b>x</b>");
    expect(card).not.toContain("<i>y</i>");
  });

  test("a viewer sees only their own feed: no leak from a private app", async () => {
    const text = await (await get("/feed", bobCookie)).text();
    expect(text).not.toContain("alice/secret");
    expect(text).not.toContain("hidden work");
    expect(text).toContain("alice/open");
  });

  test("the live address answers the region alone, conditionally", async () => {
    const res = await get("/live/feed", aliceCookie);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.trimStart().startsWith("<section")).toBe(true);
    expect(text).not.toContain("<html");
    const again = await get("/live/feed", aliceCookie, { "if-none-match": res.headers.get("etag")! });
    expect(again.status).toBe(304);
    expect((await get("/live/feed")).status).toBe(404);
  });

  test("dismissing a card takes it out of the next render", async () => {
    const item = readFeed(app.db, bob).items.find((i) => i.kind === "run")!;
    const post = (origin: string) =>
      fetch(`${servers.url}/api/v1/feed/interactions`, {
        method: "POST",
        headers: { cookie: bobCookie, origin, "content-type": "application/json" },
        body: JSON.stringify({ item: item.id, kind: "dismissed", app: item.app }),
      });
    expect((await post("http://evil.example")).status).toBe(403);
    expect((await post(servers.url)).status).toBe(201);
    const text = await (await get("/live/feed", bobCookie)).text();
    expect(text).not.toContain(`data-item="${item.id}"`);
  });

  test("the page carries the feed script and a card is focusable for j/k", async () => {
    const text = await (await get("/feed", aliceCookie)).text();
    expect(text).toContain("data-nav");
    expect(await withScripts(servers.url, text)).toContain("/api/v1/feed/interactions");
  });
});
