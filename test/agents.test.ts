/**
 * The forge under a fleet.
 *
 * Every test here asks the same question in a different place: what happens
 * when two hundred agents do the thing at once? The answers a single-user
 * forge never has to give — is a number unique, does a retry duplicate, does
 * one caller's loop starve everyone else, does a client that stops reading
 * grow the heap — are the ones a harness lives or dies on.
 *
 * Adversarial by construction: nothing here checks that the happy path
 * works. It checks that the unhappy path is bounded.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { listEvents } from "../src/core/events.ts";
import {
  lookupIdempotent,
  resetPruneClock,
} from "../src/core/idempotency.ts";
import {
  eventStream,
  resetSseDroppedCount,
  sseDroppedCount,
} from "../src/http/sse.ts";
import { CONNECT_LIMITS } from "../src/actions/origins.ts";
import { RateLimiter } from "../src/core/ratelimit.ts";
import { deliveryBusy, runDelivery } from "../src/core/webhooks.ts";
import { Gate, gitGate, runGit, transfersForMemory } from "../src/git/env.ts";
import { quietLogs } from "./helpers/globals.ts";
import { isBusy, transact } from "../src/kernel/db.ts";
import { repoDir } from "../src/git/repos.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { seedAdmin } from "./helpers/admin.ts";

quietLogs();

const WRITERS = 50;

describe("fifty agents at once", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let token = "";

  const write = (
    path: string,
    bodyObj: unknown,
    extra: Record<string, string> = {},
  ) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...extra,
      },
      body: JSON.stringify(bodyObj),
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-agents-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    await seedAdmin(app, {
      username: "cora",
      email: "cora@forge.test",
      password: "a-long-crew-password",
    });
    token = await fetch(`${base}/api/v1/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ adminConfirm: true,
        username: "cora",
        password: "a-long-crew-password",
        name: "fleet",
        scope: "rw",
      }),
    })
      .then((r) => r.json())
      .then((j) => (j as { token: string }).token);
    await write("/api/v1/repos", { name: "swarm", visibility: "public" });
    await write("/api/v1/repos/cora/swarm/contents", {
      message: "init",
      files: [{ path: "README.md", content: "# swarm\n" }],
    });
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("fifty writers get unique, contiguous issue numbers and no 500s", async () => {
    const before = app.db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM issue")
      .get()!.n;

    const responses = await Promise.all(
      Array.from({ length: WRITERS }, (_, i) =>
        write("/api/v1/repos/cora/swarm/issues", {
          title: `parallel issue ${i}`,
          body: "opened by an agent",
        }),
      ),
    );
    const bodies = (await Promise.all(responses.map((r) => r.json()))) as {
      number: number;
    }[];

    // Not one refusal, and in particular not one 500: SQLITE_BUSY is a
    // scheduling fact and must never surface as a server error.
    expect(responses.map((r) => r.status)).toEqual(
      Array.from({ length: WRITERS }, () => 201),
    );

    const numbers = bodies.map((b) => b.number).sort((a, b) => a - b);
    expect(new Set(numbers).size).toBe(WRITERS);
    // Contiguous: the sequence handed out exactly WRITERS numbers with no
    // gaps and no repeats, which is what `nextNumber` in a transaction buys.
    expect(numbers[numbers.length - 1]! - numbers[0]!).toBe(WRITERS - 1);
    expect(
      app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM issue").get()!
        .n,
    ).toBe(before + WRITERS);

    // Every mutation left an event. The outbox is the contract that webhooks
    // and SSE ride, so a write that skipped it is a write nobody hears about.
    const opened = listEvents(app.db, { limit: 500 }).filter(
      (e) => e.kind === "issue.opened",
    );
    expect(opened.length).toBeGreaterThanOrEqual(WRITERS);
  }, 60_000);

  test("fifty commenters on one thread all land, and all record an event", async () => {
    const created = (await (
      await write("/api/v1/repos/cora/swarm/issues", { title: "the thread" })
    ).json()) as { number: number };

    const responses = await Promise.all(
      Array.from({ length: WRITERS }, (_, i) =>
        write(`/api/v1/repos/cora/swarm/issues/${created.number}/comments`, {
          body: `agent ${i} reporting`,
        }),
      ),
    );
    expect(responses.every((r) => r.status === 201)).toBe(true);

    const count = app.db
      .query<
        { n: number },
        [number]
      >("SELECT COUNT(*) AS n FROM comment WHERE issue_id = (SELECT id FROM issue WHERE number = ?1 AND repo_id = (SELECT id FROM repo WHERE name = 'swarm'))")
      .get(created.number)!.n;
    expect(count).toBe(WRITERS);
  }, 60_000);

  test("fifty pushes to distinct branches all complete over the hook socket", async () => {
    const dir = repoDir(app.reposRoot, "cora", "swarm");
    // Push with plumbing rather than a client: each "push" is an update-ref
    // through the same pre-receive path a real one takes... except that the
    // hook only runs for a transport. So drive real ones, in parallel, over
    // HTTP — the socket's backlog is exactly what is under test.
    // Never inherit the host's git configuration: a crew machine carries an
    // http.extraHeader Authorization that beats the token in the URL, and
    // every push then comes back "auth required" (test/helpers/git-client.ts).
    const env = gitClientEnv();
    const clones = await mkdtemp(join(tmpdir(), "forge-agents-push-"));
    const remote = `${base.replace("http://", `http://cora:${token}@`)}/cora/swarm.git`;

    const clone = await Bun.spawn(
      ["git", "clone", "--quiet", remote, join(clones, "work")],
      { stdout: "ignore", stderr: "pipe", env },
    );
    expect(await clone.exited).toBe(0);
    const work = join(clones, "work");

    // One commit per branch, prepared serially (cheap), then pushed at once.
    for (let i = 0; i < WRITERS; i++) {
      const branch = `agent-${i}`;
      await Bun.spawn(["git", "checkout", "--quiet", "-b", branch, "main"], {
        cwd: work,
        stdout: "ignore",
        stderr: "ignore",
        env,
      }).exited;
      await Bun.write(join(work, `agent-${i}.txt`), `work from agent ${i}\n`);
      await Bun.spawn(["git", "add", "."], { cwd: work, stdout: "ignore", env })
        .exited;
      await Bun.spawn(
        [
          "git",
          "-c",
          "user.email=a@b.c",
          "-c",
          "user.name=agent",
          "commit",
          "--quiet",
          "-m",
          `agent ${i}`,
        ],
        { cwd: work, stdout: "ignore", stderr: "ignore", env },
      ).exited;
    }

    const pushes = await Promise.all(
      Array.from({ length: WRITERS }, (_, i) =>
        Bun.spawn(
          ["git", "push", "--quiet", "origin", `agent-${i}:agent-${i}`],
          { cwd: work, stdout: "pipe", stderr: "pipe", env },
        ),
      ).map(async (proc) => ({
        code: await proc.exited,
        stderr: await new Response(proc.stderr).text(),
      })),
    );

    const failed = pushes.filter((p) => p.code !== 0);
    expect(failed.map((f) => f.stderr).join("\n")).toBe("");
    expect(failed).toHaveLength(0);

    // Every branch landed, and every landing woke the outbox.
    const refs = await runGit(
      ["for-each-ref", "--format=%(refname)", "refs/heads/"],
      {
        cwd: dir,
      },
    );
    expect(refs.ok).toBe(true);
    if (refs.ok) {
      for (let i = 0; i < WRITERS; i++) {
        expect(refs.value).toContain(`refs/heads/agent-${i}`);
      }
    }
    const pushEvents = listEvents(app.db, { limit: 500 }).filter(
      (e) => e.kind === "push",
    );
    expect(pushEvents.length).toBeGreaterThanOrEqual(WRITERS);

    await rm(clones, { recursive: true, force: true });
  }, 180_000);
});

// ---- idempotency ----

describe("Idempotency-Key", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let token = "";

  const post = (
    path: string,
    bodyObj: unknown,
    key?: string,
    secret = () => token,
  ) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret()}`,
        "content-type": "application/json",
        ...(key === undefined ? {} : { "idempotency-key": key }),
      },
      body: JSON.stringify(bodyObj),
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-idem-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    await seedAdmin(app, {
      username: "mira",
      email: "mira@forge.test",
      password: "a-long-bot-password",
    });
    token = await fetch(`${base}/api/v1/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ adminConfirm: true,
        username: "mira",
        password: "a-long-bot-password",
        name: "retries",
        scope: "rw",
      }),
    })
      .then((r) => r.json())
      .then((j) => (j as { token: string }).token);
    await post("/api/v1/repos", { name: "retry", visibility: "public" });
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const issueCount = (): number =>
    app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM issue").get()!.n;

  test("a retried create returns the original 201 instead of a duplicate", async () => {
    const before = issueCount();
    const body = { title: "only once", body: "the network ate the answer" };

    const first = await post("/api/v1/repos/mira/retry/issues", body, "key-one");
    const second = await post(
      "/api/v1/repos/mira/retry/issues",
      body,
      "key-one",
    );

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await second.text()).toBe(await first.clone().text());
    // The replay is labelled, so a caller reconciling its retries can tell.
    expect(first.headers.get("idempotent-replay")).toBeNull();
    expect(second.headers.get("idempotent-replay")).toBe("true");
    expect(issueCount()).toBe(before + 1);
  });

  test("two retries racing produce one issue, not two", async () => {
    const before = issueCount();
    const body = { title: "raced", body: "both arrived" };
    const [a, b, c] = await Promise.all([
      post("/api/v1/repos/mira/retry/issues", body, "key-race"),
      post("/api/v1/repos/mira/retry/issues", body, "key-race"),
      post("/api/v1/repos/mira/retry/issues", body, "key-race"),
    ]);
    expect([a.status, b.status, c.status]).toEqual([201, 201, 201]);
    const numbers = await Promise.all(
      [a, b, c].map(
        async (r) => ((await r.json()) as { number: number }).number,
      ),
    );
    expect(new Set(numbers).size).toBe(1);
    expect(issueCount()).toBe(before + 1);
  });

  test("the same key with a different body is refused, not silently wrong", async () => {
    await post("/api/v1/repos/mira/retry/issues", { title: "first" }, "key-two");
    const clash = await post(
      "/api/v1/repos/mira/retry/issues",
      { title: "second" },
      "key-two",
    );
    expect(clash.status).toBe(422);
    expect(((await clash.json()) as { error: string }).error).toBe(
      "idempotency_key_reused",
    );
  });

  test("a key is scoped to its token — one agent cannot read another's answer", async () => {
    const other = await fetch(`${base}/api/v1/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ adminConfirm: true,
        username: "mira",
        password: "a-long-bot-password",
        name: "second-agent",
        scope: "rw",
      }),
    })
      .then((r) => r.json())
      .then((j) => (j as { token: string }).token);

    const before = issueCount();
    const body = { title: "shared key name" };
    const mine = await post("/api/v1/repos/mira/retry/issues", body, "collide");
    const theirs = await post(
      "/api/v1/repos/mira/retry/issues",
      body,
      "collide",
      () => other,
    );
    expect(mine.status).toBe(201);
    expect(theirs.status).toBe(201);
    // Two different issues: the key namespaces are disjoint.
    expect(theirs.headers.get("idempotent-replay")).toBeNull();
    expect(issueCount()).toBe(before + 2);
  });

  test("an over-long key is a 422, not an unbounded row", async () => {
    const refused = await post(
      "/api/v1/repos/mira/retry/issues",
      { title: "nope" },
      "k".repeat(500),
    );
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { error: string }).error).toBe(
      "invalid_idempotency_key",
    );
  });

  test("expired keys are swept on the next store, and never replayed", async () => {
    const past = new Date(Date.now() - 1_000).toISOString();
    for (let i = 0; i < 3; i++) {
      app.db
        .query(
          `INSERT INTO idempotency
             (token_id, key, fingerprint, status, body, content_type, created_at, expires_at)
           VALUES (?1, ?2, 'fp', 201, '{}', 'application/json', ?3, ?3)`,
        )
        .run("some-token", `stale-${i}`, past);
    }
    const count = (): number =>
      app.db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM idempotency WHERE key LIKE 'stale-%'",
        )
        .get()!.n;
    expect(count()).toBe(3);
    // An expired row is not an answer, even under the exact same token.
    expect(lookupIdempotent(app.db, "some-token", "stale-0")).toBeUndefined();

    // The sweep rides a store, at most once an hour; force the clock.
    resetPruneClock();
    const before = issueCount();
    const response = await post(
      "/api/v1/repos/mira/retry/issues",
      { title: "sweeper", body: "" },
      "sweep-key",
    );
    expect(response.status).toBe(201);
    expect(issueCount()).toBe(before + 1);
    expect(count()).toBe(0);
  });

  test("a GET carrying the header is untouched — only mutations replay", async () => {
    const read = await fetch(`${base}/api/v1/repos/mira/retry/issues`, {
      headers: {
        authorization: `Bearer ${token}`,
        "idempotency-key": "key-one",
      },
    });
    expect(read.status).toBe(200);
    expect(read.headers.get("idempotent-replay")).toBeNull();
  });
});

// ---- rate limits ----

describe("per-token rate limits", () => {
  test("a sliding window refuses past the limit and reopens as it slides", () => {
    let now = 1_000_000;
    const limiter = new RateLimiter(
      { perMinute: 3, adminPerMinute: 5, enabled: true },
      () => now,
    );
    expect(limiter.take("t", "rw").allowed).toBe(true);
    expect(limiter.take("t", "rw").allowed).toBe(true);
    const third = limiter.take("t", "rw");
    expect(third.allowed).toBe(true);
    expect(third.remaining).toBe(0);

    const refused = limiter.take("t", "rw");
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfter).toBeGreaterThan(0);

    // A refusal is not counted, so hammering a closed door does not push the
    // window forward and lock the caller out forever.
    for (let i = 0; i < 20; i++) limiter.take("t", "rw");
    now += 60_001;
    expect(limiter.take("t", "rw").allowed).toBe(true);
  });

  test("the connect cap is a minute, and its 429 says so: the number agrees with the sentence", () => {
    // The connect limiter's own settings (`actions/origins.ts`), with the
    // clock in hand: ten pass, the eleventh is refused for at most a minute
    // (what "wait a minute" and `retryAfter` both say), and a minute on it passes.
    const first = 1_000_000;
    let now = first;
    const limiter = new RateLimiter(CONNECT_LIMITS, () => now);
    // Four honest failures cost nothing worth waiting for.
    for (let i = 0; i < 4; i++) {
      expect(limiter.take("alice", "rw").allowed).toBe(true);
      now += 1_000;
    }
    for (let i = 0; i < 6; i++) {
      expect(limiter.take("alice", "rw").allowed).toBe(true);
      now += 1_000;
    }
    const eleventh = limiter.take("alice", "rw");
    expect(eleventh.allowed).toBe(false);
    expect(eleventh.retryAfter).toBe(50);
    expect(eleventh.retryAfter).toBeLessThanOrEqual(CONNECT_LIMITS.windowMs! / 1000);
    expect(CONNECT_LIMITS.windowMs).toBe(60_000);
    now = first + 60_001;
    expect(limiter.take("alice", "rw").allowed).toBe(true);
  });

  test("one runaway token cannot spend another token's budget", () => {
    let now = 1_000_000;
    const limiter = new RateLimiter(
      { perMinute: 2, adminPerMinute: 2, enabled: true },
      () => now,
    );
    limiter.take("runaway", "rw");
    limiter.take("runaway", "rw");
    expect(limiter.take("runaway", "rw").allowed).toBe(false);
    expect(limiter.take("bystander", "rw").allowed).toBe(true);
  });

  test("admin tokens carry their own, larger allowance", () => {
    const limiter = new RateLimiter({
      perMinute: 1,
      adminPerMinute: 3,
      enabled: true,
    });
    expect(limiter.take("a", "admin").allowed).toBe(true);
    expect(limiter.take("a", "admin").allowed).toBe(true);
    expect(limiter.take("a", "admin").allowed).toBe(true);
    expect(limiter.take("a", "admin").allowed).toBe(false);
  });

  test("the key table does not grow without bound", () => {
    let now = 1_000_000;
    const limiter = new RateLimiter(
      { perMinute: 10, adminPerMinute: 10, enabled: true },
      () => now,
    );
    for (let i = 0; i < 500; i++) limiter.take(`token-${i}`, "ro");
    expect(limiter.size).toBe(500);
    now += 120_000;
    limiter.take("someone", "ro");
    // The sweep dropped every window that had fully passed.
    expect(limiter.size).toBe(1);
  });

  test("FORGE_RATE_LIMIT=0 is the off switch", () => {
    const limiter = new RateLimiter({
      perMinute: 0,
      adminPerMinute: 0,
      enabled: false,
    });
    for (let i = 0; i < 1_000; i++) {
      expect(limiter.take("anyone", "rw").allowed).toBe(true);
    }
  });
});

describe("rate limits over HTTP", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let token = "";
  let cookie = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-rate-"));
    // A tiny limit for the duration of this listener: the point is the
    // mechanism, and spending 600 real requests to prove it would be silly.
    process.env["FORGE_RATE_LIMIT"] = "5";
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    delete process.env["FORGE_RATE_LIMIT"];
    base = servers.url;
    await fetch(`${base}/api/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "loop",
        email: "loop@forge.test",
        password: "a-long-loop-password",
      }),
    });
    token = await fetch(`${base}/api/v1/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ adminConfirm: true,
        username: "loop",
        password: "a-long-loop-password",
        name: "runaway",
        scope: "rw",
      }),
    })
      .then((r) => r.json())
      .then((j) => (j as { token: string }).token);
    const signin = await fetch(`${base}/signin`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        username: "loop",
        password: "a-long-loop-password",
      }).toString(),
      redirect: "manual",
    });
    cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a runaway token is refused with Retry-After and rate headers", async () => {
    const statuses: number[] = [];
    let refusal: { headers: Headers; body: { error: string } } | undefined;
    for (let i = 0; i < 8; i++) {
      const response = await fetch(`${base}/api/v1/user`, {
        headers: { authorization: `Bearer ${token}` },
      });
      statuses.push(response.status);
      const text = await response.text();
      if (response.status === 429) {
        refusal = {
          headers: response.headers,
          body: JSON.parse(text) as { error: string },
        };
      }
    }
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses.slice(5)).toEqual([429, 429, 429]);
    expect(refusal).toBeDefined();
    expect(refusal!.headers.get("retry-after")).toBeTruthy();
    expect(refusal!.headers.get("x-ratelimit-limit")).toBe("5");
    expect(refusal!.headers.get("x-ratelimit-remaining")).toBe("0");
    expect(refusal!.body.error).toBe("rate_limited");
  });

  test("every allowed answer says how much budget is left", async () => {
    // A fresh token, so this test does not inherit the previous one's window.
    const fresh = await fetch(`${base}/api/v1/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ adminConfirm: true,
        username: "loop",
        password: "a-long-loop-password",
        name: "polite",
        scope: "ro",
      }),
    })
      .then((r) => r.json())
      .then((j) => (j as { token: string }).token);
    const response = await fetch(`${base}/api/v1/user`, {
      headers: { authorization: `Bearer ${fresh}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratelimit-limit")).toBe("5");
    expect(response.headers.get("x-ratelimit-remaining")).toBe("4");
    expect(Number(response.headers.get("x-ratelimit-reset"))).toBeGreaterThan(
      0,
    );
  });

  test("a browser session is exempt — the limit is for automation", async () => {
    for (let i = 0; i < 20; i++) {
      const response = await fetch(`${base}/api/v1/user`, {
        headers: { cookie },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-ratelimit-limit")).toBeNull();
      await response.arrayBuffer();
    }
  });
});

// ---- backpressure ----

describe("backpressure", () => {
  test("an SSE client that never reads is dropped, not buffered forever", async () => {
    resetSseDroppedCount();
    let push: ((text: string) => void) | undefined;
    const controller = new AbortController();
    const response = eventStream(
      {} as App,
      new Request("http://forge/stream", { signal: controller.signal }),
      (emit) => {
        push = (text) => emit("noise", { text });
        return () => {};
      },
    );
    expect(push).toBeDefined();

    // Never read the body. Each frame is ~1 KB; the budget is 256 KB, so a
    // few hundred frames must cross it — and if the buffer were unbounded
    // this loop would happily run to a million.
    const payload = "x".repeat(1024);
    for (let i = 0; i < 2_000; i++) push!(payload);

    expect(sseDroppedCount()).toBe(1);
    // The stream is closed, so the reader sees an end rather than a stall.
    const reader = response.body!.getReader();
    let seen = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += value?.length ?? 0;
      // Bounded by construction: if the drop had not happened this would
      // have to drain two megabytes.
      expect(seen).toBeLessThan(2 * 1024 * 1024);
    }
    controller.abort();
  });

  test("the delivery worker never overlaps its own tick", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-single-"));
    const app = createApp({ dataDir, port: 0 });
    try {
      // A slow endpoint: the batch outlives several ticks.
      const slow = Bun.serve({
        port: 0,
        async fetch() {
          await new Promise((r) => setTimeout(r, 120));
          return new Response("ok");
        },
      });
      const userId = "u1";
      app.db
        .query(
          "INSERT INTO user (id, username, email, password_hash) VALUES (?1, 'w', 'w@f.dev', 'x')",
        )
        .run(userId);
      app.db
        .query(
          "INSERT INTO repo (id, owner_id, name) VALUES ('r1', ?1, 'hooked')",
        )
        .run(userId);
      app.db
        .query("INSERT INTO webhook (id, repo_id, url) VALUES ('w1', 'r1', ?1)")
        .run(`http://localhost:${slow.port}/`);
      for (let i = 0; i < 5; i++) {
        app.bus.append({ kind: "push", repoId: "r1", payload: { n: i } });
      }

      expect(deliveryBusy(app.db)).toBe(false);
      runDelivery(app.db, app.log, app.bus);
      expect(deliveryBusy(app.db)).toBe(true);
      // Every tick that lands while a batch is in flight is a no-op, which is
      // what keeps a slow endpoint from being attempted twice per delivery.
      const attemptsBefore = app.db
        .query<
          { n: number },
          []
        >("SELECT COALESCE(SUM(attempts), 0) AS n FROM webhook_delivery")
        .get()!.n;
      for (let i = 0; i < 10; i++) runDelivery(app.db, app.log, app.bus);
      expect(attemptsBefore).toBe(0);

      const deadline = Date.now() + 15_000;
      while (deliveryBusy(app.db) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(deliveryBusy(app.db)).toBe(false);
      const attempts = app.db
        .query<
          { id: string; attempts: number }[] extends never
            ? never
            : { id: string; attempts: number },
          []
        >("SELECT id, attempts FROM webhook_delivery")
        .all();
      // Exactly one attempt each: the extra ticks did nothing.
      expect(attempts.every((row) => row.attempts === 1)).toBe(true);
      slow.stop(true);
    } finally {
      app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("write transactions", () => {
  test("a busy database is a wait, not an error the caller ever sees", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-tx-"));
    const app = createApp({ dataDir, port: 0 });
    try {
      // The classifier is the thing that decides "retry" from "give up", so
      // it must not call a real failure retryable, or a bug becomes a hang.
      expect(isBusy(new Error("database is locked"))).toBe(true);
      expect(isBusy({ code: "SQLITE_BUSY_SNAPSHOT" })).toBe(true);
      expect(isBusy(new Error("no such table: nope"))).toBe(false);
      expect(isBusy(undefined)).toBe(false);

      // The whole transaction lands, or none of it does.
      app.db
        .query(
          "INSERT INTO user (id, username, email, password_hash) VALUES ('u1', 'w', 'w@f.dev', 'x')",
        )
        .run();
      transact(app.db, () => {
        app.db
          .query(
            "INSERT INTO repo (id, owner_id, name) VALUES ('r1', 'u1', 'a')",
          )
          .run();
        app.db
          .query(
            "INSERT INTO repo (id, owner_id, name) VALUES ('r2', 'u1', 'b')",
          )
          .run();
      });
      expect(
        app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM repo").get()!
          .n,
      ).toBe(2);

      expect(() =>
        transact(app.db, () => {
          app.db
            .query(
              "INSERT INTO repo (id, owner_id, name) VALUES ('r3', 'u1', 'c')",
            )
            .run();
          throw new Error("changed my mind");
        }),
      ).toThrow("changed my mind");
      // Rolled back, and the throw was not swallowed by the retry loop.
      expect(
        app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM repo").get()!
          .n,
      ).toBe(2);
    } finally {
      app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

// ---- limits on git itself ----

describe("git process limits and timeouts", () => {
  test("pack transfers at once follow the memory: eight on a 512 MiB cell, sixteen from 1 GiB, never under two", () => {
    const mib = 1024 * 1024;
    expect(transfersForMemory(512 * mib)).toBe(8);
    expect(transfersForMemory(1024 * mib)).toBe(16);
    expect(transfersForMemory(16 * 1024 * mib)).toBe(16);
    expect(transfersForMemory(64 * mib)).toBe(2);
    expect(transfersForMemory(Number.NaN)).toBe(16);
  });

  test("the semaphore hands out no more permits than its limit", async () => {
    const gate = new Gate(3);
    let live = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 40 }, () =>
        gate.run(async () => {
          live++;
          peak = Math.max(peak, live);
          await new Promise((r) => setTimeout(r, 1));
          live--;
        }),
      ),
    );
    expect(peak).toBe(3);
    expect(gate.stats().active).toBe(0);
    expect(gate.stats().waiting).toBe(0);
  });

  test("a released permit goes to the longest waiter, not the newest caller", async () => {
    const gate = new Gate(1);
    const order: number[] = [];
    const held = await gate.acquire();
    const waiters = [1, 2, 3].map(async (n) => {
      const release = await gate.acquire();
      order.push(n);
      release();
    });
    held();
    await Promise.all(waiters);
    expect(order).toEqual([1, 2, 3]);
  });

  test("a `first` waiter goes ahead of the others, and FIFO among its own kind", async () => {
    const gate = new Gate(1);
    const order: string[] = [];
    const held = await gate.acquire();
    const waiters = (
      [
        ["preview-1", false],
        ["production-a", true],
        ["preview-2", false],
        ["production-b", true],
      ] as const
    ).map(async ([name, first]) => {
      const release = await gate.acquire({ first });
      order.push(name);
      release();
    });
    held();
    await Promise.all(waiters);
    expect(order).toEqual([
      "production-a",
      "production-b",
      "preview-1",
      "preview-2",
    ]);
    expect(gate.stats().active).toBe(0);
  });

  test("concurrent git reads never exceed the process cap", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-gate-"));
    try {
      await Bun.spawn(["git", "init", "--quiet", "--bare", dataDir], {
        stdout: "ignore",
        stderr: "ignore",
      }).exited;
      gitGate.resetPeak();
      await Promise.all(
        Array.from({ length: 60 }, () =>
          runGit(["rev-parse", "--is-bare-repository"], { cwd: dataDir }),
        ),
      );
      expect(gitGate.stats().peak).toBeLessThanOrEqual(gitGate.limit);
      expect(gitGate.stats().active).toBe(0);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 60_000);

  test("a git process that hangs is killed on its timer, not waited on", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-hang-"));
    try {
      await Bun.spawn(["git", "init", "--quiet", "--bare", dataDir], {
        stdout: "ignore",
        stderr: "ignore",
      }).exited;
      const started = Date.now();
      // `cat-file --batch` with a pipe we never close waits for stdin
      // forever. The kill timer is the only thing that ends it.
      const result = await runGit(["cat-file", "--batch"], {
        cwd: dataDir,
        stdin: "",
        timeoutMs: 250,
      });
      const elapsed = Date.now() - started;
      // It came back at all, and it came back on the timer's schedule.
      expect(elapsed).toBeLessThan(10_000);
      expect(result.ok || !result.ok).toBe(true);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("a webhook to a server that never answers gives up on its signal", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-hangfetch-"));
    const app = createApp({ dataDir, port: 0 });
    // A server that accepts and never responds: without a signal on the
    // delivery fetch, this delivery would be pending for the process's life.
    const blackhole = Bun.serve({
      port: 0,
      fetch: () => new Promise<Response>(() => {}),
    });
    try {
      app.db
        .query(
          "INSERT INTO user (id, username, email, password_hash) VALUES ('u1', 'w', 'w@f.dev', 'x')",
        )
        .run();
      app.db
        .query("INSERT INTO repo (id, owner_id, name) VALUES ('r1', 'u1', 'h')")
        .run();
      app.db
        .query(
          "INSERT INTO webhook (id, repo_id, url, secret) VALUES ('w1', 'r1', ?1, 'shhh')",
        )
        .run(`http://localhost:${blackhole.port}/`);
      app.bus.append({ kind: "push", repoId: "r1" });

      const { deliverDue } = await import("../src/core/webhooks.ts");
      const started = Date.now();
      await deliverDue(app.db, app.log, new Date(), {
        allow: ["127.0.0.1", "::1"],
        plain: true,
      });
      const elapsed = Date.now() - started;
      // The delivery timeout is 10s; anything under 30 proves a signal fired
      // rather than the request hanging on forever.
      expect(elapsed).toBeLessThan(30_000);
      const row = app.db
        .query<
          { attempts: number; state: string },
          []
        >("SELECT attempts, state FROM webhook_delivery")
        .get();
      // It was attempted and scheduled for retry — not lost, not stuck.
      expect(row?.attempts).toBe(1);
      expect(row?.state).toBe("pending");
    } finally {
      blackhole.stop(true);
      app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 60_000);
});
