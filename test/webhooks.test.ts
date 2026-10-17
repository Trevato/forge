import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import {
  createWebhook,
  deliverDue,
  kindMatches,
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
    const { secret } = unwrap(
      createWebhook(app.db, {
        repoId,
        url: `${receiverUrl}/ok`,
        kinds: "push",
      }),
    );
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

    const attempted = await deliverDue(app.db, app.log);
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
    createWebhook(app.db, { repoId, url: `${receiverUrl}/fail`, kinds: "tag" });
    app.bus.append({ kind: "tag", repoId, actorId: userId, payload: {} });

    // First attempt fails → row goes pending with a future next_try_at.
    await deliverDue(app.db, app.log);
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
      await deliverDue(app.db, app.log, new Date(Date.now() + i * 3_600_000));
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
    createWebhook(app.db, {
      repoId,
      url: `${receiverUrl}/flaky`,
      kinds: "flaky.*",
    });
    app.bus.append({
      kind: "flaky.event",
      repoId,
      actorId: userId,
      payload: {},
    });

    // 503, 503, then 200 — deliver repeatedly with advancing time.
    let ok = false;
    for (let i = 0; i < 5 && !ok; i++) {
      await deliverDue(app.db, app.log, new Date(Date.now() + i * 3_600_000));
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
});

function unwrap<T>(
  r: { ok: true; value: T } | { ok: false; error: unknown },
): T {
  if (!r.ok) throw new Error(`unwrap: ${String(r.error)}`);
  return r.value;
}
