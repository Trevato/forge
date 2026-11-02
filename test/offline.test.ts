/**
 * Offline-first feed: the outbox keeps acts and replays them without
 * doubling, the service worker is served and is valid, the page carries
 * what it needs, a tell by key lands once, and /events resumes from an id.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { listIssues } from "../src/core/issues.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { outboxJs } from "../src/web/outbox.ts";
import { serviceWorker, swSource } from "../src/web/sw.ts";
import { withScripts } from "./helpers/page-script.ts";

type Send = (url: string, init: any) => Promise<{ status: number }>;
const make = new Function(`${outboxJs}; return forgeOutbox;`)() as (
  storage: Storage,
  send: Send,
) => {
  add(url: string, body: unknown): void;
  flush(): Promise<{ sent: number; refused?: number; left: number }>;
  size(): number;
  clear(): void;
};
const memory = (): Storage => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  } as Storage;
};

describe("the outbox", () => {
  test("keeps acts while the network is down and sends them in order when it is back", async () => {
    const store = memory();
    let up = false;
    const seen: string[] = [];
    const box = make(store, async (_u, init) => {
      if (!up) throw new TypeError("offline");
      seen.push(init.body);
      return { status: 201 };
    });
    box.add("/api/v1/feed/interactions", { n: 1 });
    box.add("/api/v1/feed/tells", { n: 2 });
    expect(await box.flush()).toEqual({ sent: 0, refused: 0, left: 2 });
    // a reload: a new outbox over the same storage still holds them
    up = true;
    const reopened = make(store, async (_u, init) => {
      seen.push(init.body);
      return { status: 201 };
    });
    expect(await reopened.flush()).toEqual({ sent: 2, refused: 0, left: 0 });
    expect(seen).toEqual(['{"n":1}', '{"n":2}']);
  });

  test("a replay carries the key it was queued with, so the server can refuse a double", async () => {
    const store = memory();
    const keys: string[] = [];
    let lose = true;
    const box = make(store, async (_u, init) => {
      keys.push(init.headers["idempotency-key"]);
      if (lose) throw new TypeError("answer lost");
      return { status: 201 };
    });
    box.add("/x", { a: 1 });
    await box.flush();
    lose = false;
    await box.flush();
    expect(keys.length).toBe(2);
    expect(keys[0]).toBe(keys[1]);
    expect(box.size()).toBe(0);
  });

  test("a server error keeps the entry and stops; a refusal drops it", async () => {
    const store = memory();
    const statuses = [503, 404];
    let calls = 0;
    const box = make(store, async () => ({ status: statuses[calls++] ?? 201 }));
    box.add("/a", {});
    box.add("/b", {});
    expect(await box.flush()).toEqual({ sent: 0, refused: 0, left: 2 });
    expect(calls).toBe(1);
    expect(await box.flush()).toEqual({ sent: 1, refused: 1, left: 0 });
  });

  test("two flushes at once send an entry once", async () => {
    const store = memory();
    let calls = 0;
    const box = make(store, async () => {
      calls++;
      await Promise.resolve();
      return { status: 201 };
    });
    box.add("/a", {});
    await Promise.all([box.flush(), box.flush()]);
    expect(calls).toBe(1);
  });

  test("clear forgets everything; junk in storage is ignored", async () => {
    const store = memory();
    store.setItem("forge.outbox", "{not json");
    const box = make(store, async () => ({ status: 201 }));
    expect(box.size()).toBe(0);
    box.add("/a", {});
    box.clear();
    expect(box.size()).toBe(0);
  });
});

describe("the service worker and the server", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let cookie: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-offline-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const r = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!r.ok) throw new Error(r.error);
    alice = r.value;
    cookie = `forge_session=${createSession(app.db, alice.id).token}`;
    const made = await createRepo(app, alice, { name: "open", visibility: "public" });
    if (!made.ok) throw new Error("repo");
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("/sw.js is valid script, root-scoped, never cached by the browser", async () => {
    const res = await fetch(`${servers.url}/sw.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(res.headers.get("service-worker-allowed")).toBe("/");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    // the worker's CSP is its own: it must let the worker fetch same-origin
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain("default-src 'none'");
    expect(() => new Function(swSource)).not.toThrow();
    expect(swSource).toContain("stale");
  });

  test("the home page registers the worker, has the note, and allows workers", async () => {
    const res = await fetch(`${servers.url}/feed`, { headers: { cookie } });
    const text = await res.text();
    const all = await withScripts(servers.url, text);
    expect(all).toContain("serviceWorker");
    expect(text).toContain('id="feed-note"');
    expect(all).toContain("forgeOutbox");
    expect(res.headers.get("content-security-policy")).toContain("worker-src 'self'");
  });

  test("the live client resumes /events from the last seen id", async () => {
    const text = await (await fetch(`${servers.url}/feed`, { headers: { cookie } })).text();
    const all = await withScripts(servers.url, text);
    expect(all).toContain("/events?since=");
    expect(all).toContain("'online'");
  });

  test("a tell sent twice with one key makes one issue", async () => {
    const send = (key: string, text = "make it faster") =>
      fetch(`${servers.url}/api/v1/feed/tells`, {
        method: "POST",
        headers: {
          cookie,
          origin: servers.url,
          "content-type": "application/json",
          "idempotency-key": key,
        },
        body: JSON.stringify({ app: "alice/open", text }),
      });
    const before = listIssues(app.db, repoId()).length;
    const a = await send("k1");
    const b = await send("k1");
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.headers.get("idempotent-replay")).toBe("true");
    expect(await b.json()).toEqual(await a.json());
    expect(listIssues(app.db, repoId()).length).toBe(before + 1);
    expect((await send("k2")).status).toBe(201);
    expect(listIssues(app.db, repoId()).length).toBe(before + 2);
  });

  test("a tell is validated and same-origin checked", async () => {
    const post = (body: unknown, origin = servers.url) =>
      fetch(`${servers.url}/api/v1/feed/tells`, {
        method: "POST",
        headers: { cookie, origin, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await post({ app: "alice/open", text: " " })).status).toBe(422);
    expect((await post({ app: "alice/nope", text: "hi" })).status).toBe(404);
    expect((await post({ app: "alice/open", text: "hi" }, "http://evil.example")).status).toBe(403);
  });

  test("an interaction replayed by key is recorded once", async () => {
    const post = () =>
      fetch(`${servers.url}/api/v1/feed/interactions`, {
        method: "POST",
        headers: {
          cookie,
          origin: servers.url,
          "content-type": "application/json",
          "idempotency-key": "int-1",
        },
        body: JSON.stringify({ item: "ask:look:1", kind: "dismissed", app: "alice/open" }),
      });
    const a = await (await post()).json();
    const b = await (await post()).json();
    expect(b).toEqual(a);
    const rows = app.db
      .query<{ n: number }, []>("SELECT count(*) n FROM interaction WHERE item_id = 'ask:look:1'")
      .get()!;
    expect(rows.n).toBe(1);
  });

  function repoId(): string {
    return app.db
      .query<{ id: string }, []>("SELECT id FROM repo WHERE name = 'open'")
      .get()!.id;
  }
});

describe("the worker never turns a restart into a browser error", () => {
  const boot = (kill = false) => {
    const handlers: Record<string, (e: any) => void> = {};
    const store = new Map<string, Response>();
    const cache = {
      put: async (k: any, v: Response) => void store.set(typeof k === "string" ? k : new URL(k.url).pathname, v),
    };
    const self = {
      addEventListener: (n: string, f: any) => (handlers[n] = f),
      skipWaiting() {},
      clients: { claim: async () => {} },
    };
    const caches = {
      open: async () => cache,
      match: async (k: any) => store.get(typeof k === "string" ? k : new URL(k.url).pathname)?.clone(),
      keys: async () => [],
      delete: async () => true,
    };
    const down = async () => {
      throw new TypeError("connection refused");
    };
    new Function("self", "caches", "fetch", "location", swSource)(self, caches, down, new URL("http://x"));
    return { handlers, store };
  };
  const navigate = async (h: any, path: string) => {
    let out: Promise<Response> | undefined;
    h.fetch({
      request: { method: "GET", mode: "navigate", url: `http://x${path}` },
      respondWith: (p: Promise<Response>) => (out = p),
    });
    return out!;
  };

  test("server stopped, nothing kept: a navigation gets the offline page", async () => {
    const { handlers } = boot();
    const res = await navigate(handlers, "/");
    expect(res.type).not.toBe("error");
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain("restarting");
    expect(html).toContain('http-equiv="refresh"');
    expect((await navigate(handlers, "/some/page")).status).toBe(503);
  });

  test("the offline page is cached at install; a kept home is served stale", async () => {
    const { handlers, store } = boot();
    let done: Promise<unknown> | undefined;
    handlers.install!({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
    expect(store.has("/__offline")).toBe(true);
    store.set("/", new Response('<main data-stale="0">hi</main>'));
    const res = await navigate(handlers, "/");
    expect(await res.text()).toContain('data-stale="1"');
  });

  test("the kill switch serves a self-unregistering worker", async () => {
    process.env.FORGE_SW_KILL = "1";
    try {
      const body = await serviceWorker().text();
      expect(body).toContain("unregister");
      expect(body).not.toContain("fetch");
    } finally {
      delete process.env.FORGE_SW_KILL;
    }
  });
});
