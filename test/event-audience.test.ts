/**
 * Who an event is for. A reader of a public repository sees what happened to
 * it — never its configuration. A webhook's URL is often a secret in itself,
 * an app's variable names say what it holds, and what someone keeps on their
 * own machine is their own business. Proven on every surface that hands
 * events to a reader: the JSON outbox, the stream, and the activity rail.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { setAppEnvVar } from "../src/actions/apps.ts";
import { pinRepo } from "../src/actions/origins.ts";
import {
  commitToBranch,
  createRepo,
  createWebhook,
} from "../src/actions/repos.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { audienceFilter, eventAudience } from "../src/core/event_audience.ts";
import { listEvents } from "../src/core/events.ts";
import type { Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

const HOOK = "https://hooks.example.test/services/T000/B000/s3cr3t-in-the-path";

const EGRESS = "100.89.95.68:8101";

describe("who an event is for", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
  let bob: User;
  let aliceToken: string;
  let bobToken: string;
  let repo: Repo;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-audience-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const b = await createUser(app.db, { origin: "seed", trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    bob = b.value;
    aliceToken = createToken(app.db, alice.id, "t", "admin").token;
    bobToken = createToken(app.db, bob.id, "t", "rw").token;
    const made = await createRepo(app, alice, {
      name: "open",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    await commitToBranch(app, alice, repo, {
      message: "seed",
      files: [{ path: "README.md", content: "# open\n" }],
    });
    const record = insertApp(app.db, {
      repoId: repo.id,
      slug: "open",
      access: "public",
    });
    if (!record.ok) throw new Error(record.error);
    // Configuration, and one person's own choice.
    const hook = createWebhook(app, alice, repo, { url: HOOK });
    if (!hook.ok) throw new Error(String(hook.error));
    const set = await setAppEnvVar(
      app,
      alice,
      repo,
      "STRIPE_SECRET_KEY",
      "sk_live_x",
    );
    if (!set.ok) throw new Error(String(set.error));
    app.bus.append({
      kind: "app.egress.granted",
      repoId: repo.id,
      actorId: alice.id,
      payload: { destination: EGRESS },
    });
    expect(pinRepo(app, bob, repo).ok).toBe(true);
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the outbox holds all of it, and each kind has one audience", () => {
    const kinds = listEvents(app.db, { repoId: repo.id }).map((e) => e.kind);
    expect(kinds).toContain("webhook.created");
    expect(kinds).toContain("app.env_set");
    expect(kinds).toContain("repo.pinned");
    expect(kinds).toContain("push");
    expect(eventAudience("thought.received")).toBe("actor");
    expect(eventAudience("webhook.created")).toBe("admins");
    expect(eventAudience("webhook.deleted")).toBe("admins");
    expect(eventAudience("app.env_set")).toBe("admins");
    expect(eventAudience("app.env_deleted")).toBe("admins");
    expect(eventAudience("app.egress.granted")).toBe("admins");
    expect(eventAudience("app.egress.revoked")).toBe("admins");
    expect(eventAudience("repo.settings_updated")).toBe("admins");
    expect(eventAudience("prompt.told")).toBe("admins");
    expect(eventAudience("prompt.source_added")).toBe("admins");
    expect(eventAudience("repo.pinned")).toBe("actor");
    expect(eventAudience("push")).toBe("readers");
    expect(eventAudience("a.kind.nobody.classified")).toBe("admins");
  });

  test("the filter: admins see configuration, an actor their own choice, a stranger neither", () => {
    const all = listEvents(app.db, { repoId: repo.id });
    const seenBy = (viewer: User | undefined) =>
      all.filter(audienceFilter(app.db, viewer)).map((e) => e.kind);
    const stranger = seenBy(undefined);
    expect(stranger).toContain("push");
    expect(stranger).not.toContain("webhook.created");
    expect(stranger).not.toContain("app.env_set");
    expect(stranger).not.toContain("repo.pinned");
    const bobs = seenBy(bob);
    expect(bobs).toContain("repo.pinned"); // his own
    expect(bobs).not.toContain("webhook.created");
    const alices = seenBy(alice);
    expect(alices).toContain("webhook.created");
    expect(alices).toContain("app.env_set");
    expect(alices).not.toContain("repo.pinned"); // bob's, even to an admin
  });

  test("a private destination and its granter are for the repository's admins", () => {
    const all = listEvents(app.db, { repoId: repo.id });
    const text = (viewer: User | undefined) =>
      JSON.stringify(all.filter(audienceFilter(app.db, viewer)));
    expect(text(undefined)).not.toContain(EGRESS);
    expect(text(bob)).not.toContain(EGRESS);
    expect(text(alice)).toContain(EGRESS);
    expect(text(alice)).toContain(alice.id);
  });

  test("the JSON outbox never tells a reader a webhook's URL or a variable's name", async () => {
    for (const headers of [{}, { authorization: `Bearer ${bobToken}` }]) {
      const text = await fetch(`${base}/api/v1/repos/alice/open/events`, {
        headers,
      }).then((r) => r.text());
      expect(text).toContain('"push"');
      expect(text).not.toContain("hooks.example.test");
      expect(text).not.toContain("s3cr3t");
      expect(text).not.toContain("STRIPE_SECRET_KEY");
      expect(text).not.toContain("webhook.created");
    }
    const admin = await fetch(`${base}/api/v1/repos/alice/open/events`, {
      headers: { authorization: `Bearer ${aliceToken}` },
    }).then((r) => r.text());
    expect(admin).toContain("webhook.created");
    expect(admin).toContain("app.env_set");
  });

  test("a run event tells a stranger no cost, turns or node, and the owner all of it", async () => {
    app.bus.append({
      kind: "run.finished",
      repoId: repo.id,
      payload: {
        runId: "r1",
        state: "succeeded",
        costUsd: 1.25,
        turns: 7,
        placement: "job",
        node: "vx-secret-node",
      },
    });
    const read = (headers: Record<string, string>) =>
      fetch(`${base}/api/v1/repos/alice/open/events`, { headers })
        .then((r) => r.json() as Promise<{ items: { kind: string; payload: Record<string, unknown> }[] }>)
        .then((all) => all.items.find((e) => e.kind === "run.finished")!);
    for (const headers of [{}, { authorization: `Bearer ${bobToken}` }]) {
      const seen = await read(headers);
      expect(seen.payload["runId"]).toBe("r1");
      expect(seen.payload["state"]).toBe("succeeded");
      for (const f of ["costUsd", "turns", "placement", "node"])
        expect(f in seen.payload).toBe(false);
    }
    const owner = await read({ authorization: `Bearer ${aliceToken}` });
    expect(owner.payload["costUsd"]).toBe(1.25);
    expect(owner.payload["turns"]).toBe(7);
    expect(owner.payload["placement"]).toBe("job");
    expect(owner.payload["node"]).toBe("vx-secret-node");
  });

  test("MCP `events` keeps the reader's view: no webhook URL or variable name for a reader, all for an admin", async () => {
    const call = async (token: string, args: unknown) => {
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "events", arguments: args },
        }),
      });
      return ((await res.json()) as any).result as { isError?: boolean; content: { text: string }[] };
    };
    const reader = await call(bobToken, { repo: "alice/open" });
    expect(reader.isError).not.toBe(true);
    const text = reader.content[0]!.text;
    expect(text).toContain('"push"');
    expect(text).toContain("next_cursor");
    expect(text).not.toContain("hooks.example.test");
    expect(text).not.toContain("STRIPE_SECRET_KEY");
    const admin = (await call(aliceToken, { repo: "alice/open" })).content[0]!.text;
    expect(admin).toContain("webhook.created");
    expect(admin).toContain("app.env_set");
    expect((await call(bobToken, { repo: "alice/open", limit: 0 })).isError).toBe(true);
    expect((await call(bobToken, { repo: "alice/open", limit: 201 })).isError).toBe(true);
  });

  test("the API pages events: limit cuts, next_cursor reaches the end, a bad limit is a 422", async () => {
    const get = (qs: string) =>
      fetch(`${base}/api/v1/repos/alice/open/events${qs}`, {
        headers: { authorization: `Bearer ${aliceToken}` },
      });
    type Page = { items: { id: string }[]; next_cursor: string | null };
    const everything = (await (await get("")).json()) as Page;
    expect(everything.next_cursor).toBeNull();
    expect(everything.items.length).toBeGreaterThan(3);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = (await (await get(`?limit=2${cursor ? `&cursor=${cursor}` : ""}`)).json()) as Page;
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((e) => e.id));
      cursor = page.next_cursor;
      pages++;
    } while (cursor !== null && pages < 100);
    expect(cursor).toBeNull();
    expect(pages).toBeGreaterThan(1);
    expect(seen).toEqual(everything.items.map((e) => e.id));
    for (const bad of ["limit=0", "limit=201", "limit=abc", "limit=1.5", "cursor=a%20b"])
      expect((await get(`?${bad}`)).status).toBe(422);
  });

  test("a reader's page of a mostly hidden outbox is bounded and paging reaches the same end", async () => {
    for (let i = 0; i < 1100; i++)
      app.bus.append({ kind: "webhook.deleted", repoId: repo.id, actorId: alice.id, payload: { n: i } });
    app.bus.append({ kind: "push", repoId: repo.id, actorId: alice.id, payload: { late: true } });
    type Page = { items: { id: string; kind: string }[]; next_cursor: string | null };
    const get = (qs: string) => fetch(`${base}/api/v1/repos/alice/open/events${qs}`).then((r) => r.json() as Promise<Page>);
    const first = await get("?limit=200");
    // The newest are visible, but 1,100 hidden rows lie before the older ones: the scan stops.
    expect(first.items.length).toBeLessThan(200);
    expect(first.next_cursor).not.toBeNull();
    const seen: string[] = [];
    let page = first;
    for (let i = 0; i < 50; i++) {
      seen.push(...page.items.map((e) => e.id));
      if (page.next_cursor === null) break;
      page = await get(`?limit=200&cursor=${page.next_cursor}`);
    }
    expect(page.next_cursor).toBeNull();
    const all = listEvents(app.db, { repoId: repo.id, limit: 100_000 }).filter(audienceFilter(app.db, undefined));
    expect(seen).toEqual(all.map((e) => e.id));
    expect(seen.length).toBeGreaterThan(0);
  });

  test("the activity rail on the front page says nothing of it to a visitor", async () => {
    const page = await fetch(`${base}/`, {
      headers: { accept: "text/html" },
    }).then((r) => r.text());
    expect(page).not.toContain("hooks.example.test");
    expect(page).not.toContain("STRIPE_SECRET_KEY");
  });

  test("the home, in dev mode too, says nothing of it to a signed-in stranger either", async () => {
    const as = (user: User) =>
      fetch(`${base}/?mode=dev`, {
        headers: {
          accept: "text/html",
          cookie: `forge_session=${createSession(app.db, user.id).token}`,
        },
      }).then((r) => r.text());
    // One home (#625): the feed, whatever the mode; the dev dashboard's
    // activity rail is gone, and the feed holds the same line back.
    const strangers = await as(bob);
    expect(strangers).toContain("Your apps");
    expect(strangers).not.toContain("hooks.example.test");
    expect(strangers).not.toContain("STRIPE_SECRET_KEY");
  });

  test("the streams hold configuration back from a reader as it happens", async () => {
    const read = async (path: string, headers: Record<string, string>) => {
      const controller = new AbortController();
      const res = await fetch(`${base}${path}`, {
        headers: { accept: "text/event-stream", ...headers },
        signal: controller.signal,
      });
      const reader = res.body!.getReader();
      let text = "";
      const pump = (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            text += new TextDecoder().decode(value);
          }
        } catch {
          // aborted
        }
      })();
      // Connected: now something for everyone, and something for admins.
      await Bun.sleep(150);
      await commitToBranch(app, alice, repo, {
        message: "more",
        files: [{ path: `f-${Date.now()}.txt`, content: "x\n" }],
      });
      const hook = createWebhook(app, alice, repo, { url: `${HOOK}-live` });
      if (!hook.ok) throw new Error(String(hook.error));
      await Bun.sleep(300);
      controller.abort();
      await pump;
      return text;
    };
    for (const path of ["/alice/open/stream", "/events"]) {
      const stranger = await read(path, {});
      expect(stranger).toContain("push");
      expect(stranger).not.toContain("hooks.example.test");
      const admin = await read(path, { authorization: `Bearer ${aliceToken}` });
      expect(admin).toContain("hooks.example.test");
    }
  }, 20_000);

  test("the streams tell a stranger no run cost, turns or node, in replay and live, and the owner all of it", async () => {
    const run = (runId: string) =>
      app.bus.append({
        kind: "run.finished",
        repoId: repo.id,
        payload: {
          runId,
          state: "succeeded",
          costUsd: 3.5,
          turns: 9,
          placement: "job",
          node: "vx-stream-node",
        },
      });
    const before = listEvents(app.db, { repoId: repo.id, limit: 500 })
      .map((e) => e.id)
      .sort()[0]!;
    run("replayed-run");
    const read = async (path: string, headers: Record<string, string>) => {
      const controller = new AbortController();
      const res = await fetch(`${base}${path}`, {
        headers: {
          accept: "text/event-stream",
          "last-event-id": before,
          ...headers,
        },
        signal: controller.signal,
      });
      const reader = res.body!.getReader();
      let text = "";
      const pump = (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            text += new TextDecoder().decode(value);
          }
        } catch {
          // aborted
        }
      })();
      await Bun.sleep(150);
      run("live-run");
      await Bun.sleep(300);
      controller.abort();
      await pump;
      return text;
    };
    for (const path of ["/alice/open/stream", "/events"]) {
      const stranger = await read(path, {});
      expect(stranger).toContain("replayed-run");
      expect(stranger).toContain("live-run");
      for (const f of ["costUsd", "turns", "placement", "vx-stream-node"])
        expect(stranger).not.toContain(f);
      const owner = await read(path, { authorization: `Bearer ${aliceToken}` });
      expect(owner).toContain("replayed-run");
      expect(owner).toContain("live-run");
      for (const f of ["costUsd", "turns", "placement", "vx-stream-node"])
        expect(owner).toContain(f);
    }
  }, 20_000);
});
