import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { listEvents, type ForgeEvent } from "../src/core/events.ts";
import { getCursor, getOriginById } from "../src/core/origins.ts";
import { dueOrigins, syncOrigin, syncsSettled } from "../src/origins/sync.ts";
import {
  mirrorAndWait,
  newFakeState,
  serveFakeForge,
  type FakeForge,
} from "./fake-origin.ts";
import { seedAdmin } from "./helpers/admin.ts";

/**
 * The sync loop, against a fake that speaks GitHub's dialect — because the
 * two things most likely to be wrong are exactly the two GitHub does
 * differently: pull requests live inside `/issues` and are told apart only
 * by a `pull_request` key, and an exhausted budget arrives as a 403 rather
 * than a 429.
 */

const LOGIN = "octo";
const TOKEN = "octo-origin-secret-4c11";
const PASSWORD = "alice-login-secret";

const basic = (user: string, secret: string): string =>
  `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;

const read = async <T>(response: Response): Promise<T> =>
  (await response.json()) as T;

describe("origin sync: incremental, event-shaped, and polite", () => {
  let dataDir: string;
  let originDataDir: string;
  let app: App;
  let servers: Servers;
  let originApp: App;
  let originServers: Servers;
  let fake: FakeForge;
  let base: string;
  let originId = "";

  const api = (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (init?.body !== undefined)
      headers.set("content-type", "application/json");
    headers.set("authorization", basic("alice", PASSWORD));
    return fetch(`${base}${path}`, { ...init, headers });
  };

  const since = (afterId: string): ForgeEvent[] =>
    listEvents(app.db, { afterId, limit: 200 });

  const lastEventId = (): string => {
    const rows = listEvents(app.db, { limit: 1 });
    return rows[0]?.id ?? "";
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-sync-"));
    originDataDir = await mkdtemp(join(tmpdir(), "forge-sync-up-"));

    originApp = createApp({ dataDir: originDataDir, port: 0 });
    originServers = await serve(originApp);
    await seedAdmin(originApp, {
      username: LOGIN,
      email: "octo@up.test",
      password: TOKEN,
    });
    await fetch(`${originServers.url}/api/v1/repos`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: basic(LOGIN, TOKEN),
      },
      body: JSON.stringify({ name: "sprockets", visibility: "public" }),
    });
    await fetch(`${originServers.url}/api/v1/repos/octo/sprockets/contents`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: basic(LOGIN, TOKEN),
      },
      body: JSON.stringify({
        branch: "main",
        message: "first",
        files: [{ path: "a.txt", content: "one\n" }],
      }),
    });

    const state = newFakeState("github", LOGIN, TOKEN);
    state.repos.push({
      id: 5,
      fullName: "octo/sprockets",
      cloneUrl: `${originServers.url}/octo/sprockets.git`,
      defaultBranch: "main",
    });
    state.labels.set("octo/sprockets", [
      { id: 1, name: "bug", color: "d73a4a" },
    ]);
    state.issues.set("octo/sprockets", [
      {
        id: 100,
        number: 3,
        title: "Sprocket squeaks",
        user: "mona",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: 101,
        number: 4,
        title: "Grease it",
        user: "hubot",
        createdAt: "2026-01-01T01:00:00.000Z",
        updatedAt: "2026-01-01T01:00:00.000Z",
        pull: { base: "main", head: "grease", headRepo: "octo/sprockets" },
      },
    ]);
    fake = serveFakeForge(state);

    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    await seedAdmin(app, {
      username: "alice",
      email: "alice@forge.test",
      password: PASSWORD,
    });

    // GitHub is discovered by name, so connect by kind and let the fake API
    // stand in for api.github.com.
    const connected = await read<{ id: string; kind: string }>(
      await api("/api/v1/user/origins", {
        method: "POST",
        body: JSON.stringify({ host: fake.url, kind: "github", token: TOKEN }),
      }),
    );
    originId = connected.id;
    expect(connected.kind).toBe("github");
    await mirrorAndWait(
      await api(`/api/v1/user/origins/${originId}/mirror`, {
        method: "POST",
        body: JSON.stringify({ fullName: "octo/sprockets" }),
      }),
    );
  });

  afterAll(async () => {
    fake.stop();
    servers.stop();
    originServers.stop();
    app.close();
    originApp.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(originDataDir, { recursive: true, force: true });
  });

  test("GitHub's issue list is split by the pull_request key", async () => {
    const issues = await read<{ items: { number: number }[] }>(
      await api("/api/v1/repos/alice/sprockets/issues?state=all"),
    );
    const pulls = await read<{ items: { number: number }[] }>(
      await api("/api/v1/repos/alice/sprockets/pulls?state=all"),
    );
    // #4 is a pull and must appear in exactly one of these lists.
    expect(issues.items.map((i) => i.number)).toEqual([3]);
    expect(pulls.items.map((p) => p.number)).toEqual([4]);
  });

  test("an incremental sync picks up a comment and a state change", async () => {
    const mark = lastEventId();
    const issues = fake.state.issues.get("octo/sprockets")!;
    const now = new Date().toISOString();
    issues.find((i) => i.number === 3)!.state = "closed";
    issues.find((i) => i.number === 3)!.updatedAt = now;
    fake.state.comments.set("octo/sprockets", [
      {
        id: 700,
        issueNumber: 3,
        body: "still squeaking",
        user: "mona",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    // A brand new issue upstream, to prove a later import does emit events.
    issues.push({
      id: 102,
      number: 5,
      title: "Replace the sprocket",
      user: "mona",
      createdAt: now,
      updatedAt: now,
    });

    const synced = await api("/api/v1/repos/alice/sprockets/sync", {
      method: "POST",
    });
    expect(synced.status).toBe(200);

    const detail = await read<{
      state: string;
      comments: { body: string; originAuthor: string }[];
    }>(await api("/api/v1/repos/alice/sprockets/issues/3"));
    expect(detail.state).toBe("closed");
    expect(detail.comments.map((c) => c.body)).toEqual(["still squeaking"]);
    expect(detail.comments[0]!.originAuthor).toBe("mona");

    const fresh = await read<{ title: string; originAuthor: string }>(
      await api("/api/v1/repos/alice/sprockets/issues/5"),
    );
    expect(fresh.title).toBe("Replace the sprocket");
    expect(fresh.originAuthor).toBe("mona");

    // Upstream activity is announced as ordinary events, marked `via`.
    const opened = since(mark).filter((e) => e.kind === "issue.opened");
    expect(opened).toHaveLength(1);
    expect(opened[0]!.payload).toMatchObject({ number: 5, via: "origin" });
  });

  test("a merged pull upstream becomes a pull.merged event here", async () => {
    const mark = lastEventId();
    const pull = fake.state.issues
      .get("octo/sprockets")!
      .find((i) => i.number === 4)!;
    pull.pull!.mergedAt = new Date().toISOString();
    pull.state = "closed";
    pull.updatedAt = new Date().toISOString();

    await api("/api/v1/repos/alice/sprockets/sync", { method: "POST" });

    const merged = since(mark).filter((e) => e.kind === "pull.merged");
    expect(merged).toHaveLength(1);
    expect(merged[0]!.payload).toMatchObject({ number: 4, via: "origin" });

    // A second sync must not announce it again: the upsert is idempotent, so
    // the five-minute overlap window costs nothing.
    const after = lastEventId();
    await api("/api/v1/repos/alice/sprockets/sync", { method: "POST" });
    expect(since(after).filter((e) => e.kind === "pull.merged")).toHaveLength(
      0,
    );
  });

  test("refs that moved upstream arrive as a push event marked via origin", async () => {
    const mark = lastEventId();
    await fetch(`${originServers.url}/api/v1/repos/octo/sprockets/contents`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: basic(LOGIN, TOKEN),
      },
      body: JSON.stringify({
        branch: "main",
        message: "second",
        files: [{ path: "b.txt", content: "two\n" }],
      }),
    });

    await api("/api/v1/repos/alice/sprockets/sync", { method: "POST" });

    const pushes = since(mark).filter((e) => e.kind === "push");
    expect(pushes).toHaveLength(1);
    // Same shape as a native push, plus where it came from — so webhooks and
    // SSE see upstream work without learning a new event kind.
    const payload = pushes[0]!.payload as {
      via: string;
      updates: { ref: string; oldOid: string; newOid: string }[];
    };
    expect(payload.via).toBe("origin");
    expect(payload.updates.map((u) => u.ref)).toEqual(["refs/heads/main"]);
    expect(payload.updates[0]!.newOid).toMatch(/^[0-9a-f]{40}$/);

    const contents = await read<{ content: string }>(
      await api("/api/v1/repos/alice/sprockets/contents/b.txt"),
    );
    expect(contents.content).toBe("two\n");
  });

  test("a rate-limited origin backs off instead of hammering", async () => {
    const origin = getOriginById(app.db, originId)!;
    fake.state.rateLimitFor = 50;
    const report = await syncOrigin(app, origin);
    fake.state.rateLimitFor = 0;

    expect(report.retryAt).toBeString();
    expect(report.error).toContain("rate-limit");
    // The pause is durable, so a restart does not resume hammering.
    const paused = getCursor(app.db, originId, "paused_until");
    expect(paused).toBeString();
    expect(Date.parse(paused!)).toBeGreaterThan(Date.now());
    // And the worker's due sweep skips it entirely while it lasts.
    expect(dueOrigins(app).map((o) => o.id)).not.toContain(originId);
    expect(getOriginById(app.db, originId)!.lastError).toContain("rate-limit");
  });

  test("a conditional request is answered from the cache, not refetched", async () => {
    // Clear the pause the previous test installed.
    app.db
      .query(
        "DELETE FROM origin_cursor WHERE key IN ('paused_until','next_sync_at')",
      )
      .run();
    // syncOrigin joins a run already in flight (the mirror import and earlier
    // tests chain syncs), and a joined run began before ETags were on — so it
    // would cache no validator and the next sweep would be a plain 200. Let
    // every earlier run finish, then drive exactly one sync per step.
    await syncsSettled();
    fake.state.etagsEnabled = true;
    const origin = getOriginById(app.db, originId)!;
    await syncOrigin(app, origin);
    await syncsSettled();
    const hitsBefore = fake.state.conditionalHits;
    await syncOrigin(app, origin);
    await syncsSettled();
    fake.state.etagsEnabled = false;

    // The second sweep sent If-None-Match and got a 304 back — and the labels
    // survived, because a 304 must serve the cached body, not an empty one.
    expect(fake.state.conditionalHits).toBeGreaterThan(hitsBefore);
    const labels = await read<{ items: { name: string }[] }>(
      await api("/api/v1/repos/alice/sprockets/labels"),
    );
    expect(labels.items.map((l) => l.name)).toEqual(["bug"]);
  });

  test("the worker's due sweep is time-driven and bounded", async () => {
    app.db.query("DELETE FROM origin_cursor").run();
    expect(dueOrigins(app).map((o) => o.id)).toEqual([originId]);
    await syncOrigin(app, getOriginById(app.db, originId)!);
    // Freshly synced, it is not due again until the interval passes.
    expect(dueOrigins(app)).toHaveLength(0);
    const next = getCursor(app.db, originId, "next_sync_at");
    expect(Date.parse(next!)).toBeGreaterThan(Date.now());
  });

  test("an origin that needs reauthorizing is skipped, not retried forever", async () => {
    app.db
      .query("UPDATE origin SET needs_reauth = 1 WHERE id = ?1")
      .run(originId);
    app.db.query("DELETE FROM origin_cursor").run();
    expect(dueOrigins(app)).toHaveLength(0);
    const report = await syncOrigin(app, getOriginById(app.db, originId)!);
    expect(report.error).toContain("reconnected");
    expect(report.repos).toBe(0);
    app.db
      .query("UPDATE origin SET needs_reauth = 0 WHERE id = ?1")
      .run(originId);
  });
});

describe("a mirror follows the origin's visibility", () => {
  test("a repo closed upstream stops being readable here", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-vis-"));
    const upDir = await mkdtemp(join(tmpdir(), "forge-vis-up-"));
    const upApp = createApp({ dataDir: upDir, port: 0 });
    const upServers = await serve(upApp);
    await seedAdmin(upApp, {
      username: LOGIN,
      email: "octo@v.test",
      password: TOKEN,
    });
    await fetch(`${upServers.url}/api/v1/repos`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: basic(LOGIN, TOKEN),
      },
      body: JSON.stringify({ name: "cogs", visibility: "public" }),
    });

    const state = newFakeState("forgejo", LOGIN, TOKEN);
    const remote = {
      id: 9,
      fullName: "octo/cogs",
      cloneUrl: `${upServers.url}/octo/cogs.git`,
      defaultBranch: "main",
      private: false,
    };
    state.repos.push(remote);
    const fakeForge = serveFakeForge(state);

    const app2 = createApp({ dataDir, port: 0 });
    const servers2 = await serve(app2);
    await seedAdmin(app2, {
      username: "alice",
      email: "alice@v.test",
      password: PASSWORD,
    });
    const auth = { authorization: basic("alice", PASSWORD) };
    const connected = await read<{ id: string }>(
      await fetch(`${servers2.url}/api/v1/user/origins`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ host: fakeForge.url, token: TOKEN }),
      }),
    );
    await mirrorAndWait(
      await fetch(
        `${servers2.url}/api/v1/user/origins/${connected.id}/mirror`,
        {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify({ fullName: "octo/cogs" }),
        },
      ),
    );

    // Public upstream, public here — and anonymously readable.
    expect(
      (await fetch(`${servers2.url}/api/v1/repos/alice/cogs`)).status,
    ).toBe(200);

    // Closed upstream. The next sweep must follow it: a mirror that keeps
    // serving a repo the origin has closed is a leak we caused.
    remote.private = true;
    await fetch(`${servers2.url}/api/v1/repos/alice/cogs/sync`, {
      method: "POST",
      headers: auth,
    });
    expect(
      (await fetch(`${servers2.url}/api/v1/repos/alice/cogs`)).status,
    ).toBe(404);
    // Its owner still sees it, of course.
    expect(
      (
        await fetch(`${servers2.url}/api/v1/repos/alice/cogs`, {
          headers: auth,
        })
      ).status,
    ).toBe(200);

    fakeForge.stop();
    servers2.stop();
    upServers.stop();
    app2.close();
    upApp.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(upDir, { recursive: true, force: true });
  });
});
