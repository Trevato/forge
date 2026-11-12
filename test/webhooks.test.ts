import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { createSession } from "../src/core/sessions.ts";
import { serve } from "../src/http/server.ts";
import { LOOPBACK, plainHook } from "./helpers/loopback-hook.ts";
import {
  createWebhook,
  deliverDue,
  kindMatches,
  enqueueForEvent,
  getWebhook,
  setWebhookActive,
  verifySignature,
} from "../src/core/webhooks.ts";

describe("kindMatches", () => {
  test("exact, wildcard, and prefix globs", () => {
    expect(kindMatches("*", "push")).toBe(true);
    expect(kindMatches("push", "push")).toBe(true);
    expect(kindMatches("push", "issue.opened")).toBe(false);
    expect(kindMatches("issue.*", "issue.opened")).toBe(true);
    expect(kindMatches("issue.*", "pull.opened")).toBe(false);
    expect(kindMatches("push issue.*", "issue.closed")).toBe(true);
  });
});

describe("webhook delivery", () => {
  let dataDir: string;
  let app: App;
  let userId = "";
  let repoId = "";
  // A tiny receiver that records what it gets.
  let received: { body: string; sig: string; event: string }[] = [];
  let receiver: ReturnType<typeof Bun.serve>;
  let receiverUrl = "";
  let failCount = 0;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-hook-"));
    app = createApp({ dataDir, port: 0 });
    const user = await createUser(app.db, { origin: "seed", trusted: true,
      username: "hooky",
      email: "h@f.dev",
      password: "webhooks-are-fun",
    });
    if (!user.ok) throw new Error("user");
    userId = user.value.id;
    const repo = await createRepo(app.db, app.reposRoot, {
      ownerId: userId,
      name: "r",
    });
    if (!repo.ok) throw new Error("repo");
    repoId = repo.value.id;

    receiver = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/fail")
          return new Response("no", { status: 500 });
        if (url.pathname === "/flaky") {
          failCount++;
          if (failCount <= 2) return new Response("later", { status: 503 });
        }
        received.push({
          body: await req.text(),
          sig: req.headers.get("x-forge-signature-256") ?? "",
          event: req.headers.get("x-forge-event") ?? "",
        });
        return new Response("ok");
      },
    });
    receiverUrl = `http://127.0.0.1:${receiver.port}`;
  });

  afterAll(async () => {
    receiver.stop(true);
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a matching event is delivered, signed, and verifiable", async () => {
    received = [];
    plainHook(app, repoId, `${receiverUrl}/ok`, "push");
    const secret = "test-secret";
    // A matching event enqueues a delivery via the bus subscriber.
    app.bus.append({
      kind: "push",
      repoId,
      actorId: userId,
      payload: { ref: "main" },
    });
    // A non-matching event should not be delivered.
    app.bus.append({
      kind: "issue.opened",
      repoId,
      actorId: userId,
      payload: {},
    });

    const attempted = await deliverDue(app.db, app.log, new Date(), LOOPBACK);
    expect(attempted).toBe(1); // only the push matched "push"
    expect(received).toHaveLength(1);
    expect(received[0]!.event).toBe("push");

    const body = received[0]!.body;
    expect(JSON.parse(body).kind).toBe("push");
    const header = received[0]!.sig;
    expect(header.startsWith("sha256=")).toBe(true);
    expect(await verifySignature(secret, body, header)).toBe(true);
    expect(await verifySignature("wrong-secret", body, header)).toBe(false);
  });

  test("a failing endpoint retries then gives up, without losing the row", async () => {
    plainHook(app, repoId, `${receiverUrl}/fail`, "tag");
    app.bus.append({ kind: "tag", repoId, actorId: userId, payload: {} });

    // First attempt fails → row goes pending with a future next_try_at.
    await deliverDue(app.db, app.log, new Date(), LOOPBACK);
    let row = app.db
      .query<
        { state: string; attempts: number; next_try_at: string | null },
        []
      >("SELECT state, attempts, next_try_at FROM webhook_delivery WHERE state='pending' ORDER BY id DESC LIMIT 1")
      .get();
    expect(row?.state).toBe("pending");
    expect(row?.attempts).toBe(1);
    expect(row?.next_try_at).not.toBeNull();

    // Drive it to exhaustion by delivering far in the future each time.
    for (let i = 0; i < 6; i++) {
      await deliverDue(app.db, app.log, new Date(Date.now() + i * 3_600_000), LOOPBACK);
    }
    const failed = app.db
      .query<
        { state: string },
        []
      >("SELECT state FROM webhook_delivery WHERE last_status = 500 ORDER BY id DESC LIMIT 1")
      .get();
    expect(failed?.state).toBe("failed");
  });

  test("a flaky endpoint eventually succeeds on retry", async () => {
    received = [];
    failCount = 0;
    plainHook(app, repoId, `${receiverUrl}/flaky`, "flaky.*");
    app.bus.append({
      kind: "flaky.event",
      repoId,
      actorId: userId,
      payload: {},
    });

    // 503, 503, then 200 — deliver repeatedly with advancing time.
    let ok = false;
    for (let i = 0; i < 5 && !ok; i++) {
      await deliverDue(app.db, app.log, new Date(Date.now() + i * 3_600_000), LOOPBACK);
      const row = app.db
        .query<
          { state: string },
          []
        >("SELECT d.state FROM webhook_delivery d JOIN event e ON e.id=d.event_id WHERE e.kind='flaky.event'")
        .get();
      ok = row?.state === "ok";
    }
    expect(ok).toBe(true);
    expect(received).toHaveLength(1);
  });

  test("a delivery queued before a pause waits, pending, and sends on resume", async () => {
    received = [];
    plainHook(app, repoId, `${receiverUrl}/ok`, "paused.*");
    const hookId = app.db
      .query<{ id: string }, []>("SELECT id FROM webhook WHERE kinds = 'paused.*'")
      .get()!.id;
    app.bus.append({ kind: "paused.event", repoId, actorId: userId, payload: {} });
    const state = (): string | undefined =>
      app.db
        .query<{ state: string }, []>(
          "SELECT d.state FROM webhook_delivery d JOIN event e ON e.id=d.event_id WHERE e.kind='paused.event'",
        )
        .get()?.state;
    expect(state()).toBe("pending");

    expect(setWebhookActive(app.db, repoId, hookId, false)).toBe(true);
    expect(await deliverDue(app.db, app.log, new Date(), LOOPBACK)).toBe(0);
    expect(received).toHaveLength(0);
    expect(state()).toBe("pending");

    expect(setWebhookActive(app.db, repoId, hookId, true)).toBe(true);
    expect(await deliverDue(app.db, app.log, new Date(), LOOPBACK)).toBe(1);
    expect(received).toHaveLength(1);
    expect(state()).toBe("ok");
  });
});

describe("webhook urls and refused deliveries", () => {
  test("only https is saved, with invalid_url", () => {
    const app = createApp({ dataDir: tmp(), port: 0 });
    try {
      const r = createWebhook(app.db, { repoId: "r", url: "http://example.com/h" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe("invalid_url");
    } finally {
      app.close();
    }
  });

  test("a delivery to a private address is refused and records no status", async () => {
    const app = createApp({ dataDir: tmp(), port: 0 });
    try {
      app.db.query("INSERT INTO user (id, username, email, password_hash) VALUES ('u1', 'w', 'w@f.dev', 'x')").run();
      app.db.query("INSERT INTO repo (id, owner_id, name) VALUES ('r1', 'u1', 'h')").run();
      plainHook(app, "r1", "https://127.0.0.1:9/h");
      app.bus.append({ kind: "push", repoId: "r1" });
      await deliverDue(app.db, app.log);
      const row = app.db
        .query<{ last_status: number | null; last_error: string | null; attempts: number }, []>(
          "SELECT last_status, last_error, attempts FROM webhook_delivery",
        )
        .get();
      expect(row?.last_status).toBeNull();
      expect(row?.last_error).toBe("refused: private address");
      expect(row?.attempts).toBe(1);
    } finally {
      app.close();
    }
  });
  test("a refusal fails at once, and the hooks page says why", async () => {
    const app = createApp({ dataDir: tmp(), port: 0 });
    const servers = await serve(app);
    try {
      const user = unwrap(
        await createUser(app.db, { origin: "seed", trusted: true, username: "shown", email: "s@f.dev", password: "shown-in-settings" }),
      );
      const repo = unwrap(await createRepo(app.db, app.reposRoot, { ownerId: user.id, name: "h" }));
      unwrap(createWebhook(app.db, { repoId: repo.id, url: "https://127.0.0.1:9/h" }));
      app.bus.append({ kind: "push", repoId: repo.id });
      await deliverDue(app.db, app.log);
      const row = app.db
        .query<{ state: string; attempts: number }, []>("SELECT state, attempts FROM webhook_delivery")
        .get();
      expect(row).toEqual({ state: "failed", attempts: 1 });
      const cookie = `forge_session=${createSession(app.db, user.id).token}`;
      const page = await fetch(`${servers.url}/shown/h/settings/hooks`, { headers: { cookie } });
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("refused: private address");
    } finally {
      servers.stop();
      app.close();
    }
  });

  test("a delivery that succeeds clears a stale last_error", async () => {
    const app = createApp({ dataDir: tmp(), port: 0 });
    const receiver = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    try {
      app.db.query("INSERT INTO user (id, username, email, password_hash) VALUES ('u1', 'w', 'w@f.dev', 'x')").run();
      app.db.query("INSERT INTO repo (id, owner_id, name) VALUES ('r1', 'u1', 'h')").run();
      plainHook(app, "r1", `http://127.0.0.1:${receiver.port}/h`);
      app.bus.append({ kind: "push", repoId: "r1" });
      app.db.query("UPDATE webhook_delivery SET last_error = 'old'").run();
      await deliverDue(app.db, app.log, new Date(), LOOPBACK);
      const row = app.db
        .query<{ state: string; last_error: string | null }, []>("SELECT state, last_error FROM webhook_delivery")
        .get();
      expect(row).toEqual({ state: "ok", last_error: null });
    } finally {
      receiver.stop(true);
      app.close();
    }
  });

  test("a hook saved as http before the https rule is refused, not sent", async () => {
    const app = createApp({ dataDir: tmp(), port: 0 });
    try {
      app.db.query("INSERT INTO user (id, username, email, password_hash) VALUES ('u1', 'w', 'w@f.dev', 'x')").run();
      app.db.query("INSERT INTO repo (id, owner_id, name) VALUES ('r1', 'u1', 'h')").run();
      plainHook(app, "r1", "http://93.184.216.34/h");
      app.bus.append({ kind: "push", repoId: "r1" });
      await deliverDue(app.db, app.log);
      const row = app.db
        .query<{ state: string; last_error: string | null }, []>("SELECT state, last_error FROM webhook_delivery")
        .get();
      expect(row).toEqual({ state: "failed", last_error: "refused: not https" });
    } finally {
      app.close();
    }
  });
});

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "forge-hook-r-"));
}

function unwrap<T>(
  r: { ok: true; value: T } | { ok: false; error: unknown },
): T {
  if (!r.ok) throw new Error(`unwrap: ${String(r.error)}`);
  return r.value;
}

describe("pausing a webhook", () => {
  test("a paused hook enqueues nothing, resumes without backfill, and is scoped to its repo", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-hook-pause-"));
    const app = createApp({ dataDir, port: 0 });
    try {
      const user = await createUser(app.db, { origin: "seed", trusted: true,
        username: "pauser", email: "p@f.dev", password: "webhooks-are-fun" });
      if (!user.ok) throw new Error("user");
      const mk = async (name: string) => {
        const r = await createRepo(app.db, app.reposRoot, { ownerId: user.value.id, name });
        if (!r.ok) throw new Error("repo");
        return r.value.id;
      };
      const repoId = await mk("a");
      const other = await mk("b");
      const made = createWebhook(app.db, { repoId, url: "https://example.com/h", kinds: "push" });
      if (!made.ok) throw new Error("hook");
      const hookId = made.value.webhook.id;
      const event = (): number =>
        app.db.query<{ n: number }, []>("SELECT count(*) n FROM webhook_delivery").get()!.n;
      expect(made.value.webhook.active).toBe(true);

      expect(setWebhookActive(app.db, other, hookId, false)).toBe(false);
      expect(getWebhook(app.db, repoId, hookId)!.active).toBe(true);

      expect(setWebhookActive(app.db, repoId, hookId, false)).toBe(true);
      expect(getWebhook(app.db, repoId, hookId)!.active).toBe(false);
      const ev = app.bus.append({ kind: "push", repoId, actorId: user.value.id, payload: {} });
      expect(enqueueForEvent(app.db, ev)).toBe(0);
      expect(event()).toBe(0);

      expect(setWebhookActive(app.db, repoId, hookId, true)).toBe(true);
      expect(event()).toBe(0); // nothing backfilled
      const ev2 = app.bus.append({ kind: "push", repoId, actorId: user.value.id, payload: {} });
      enqueueForEvent(app.db, ev2);
      expect(event()).toBeGreaterThan(0);
    } finally {
      app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
