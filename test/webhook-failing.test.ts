/**
 * A hook that fails three deliveries in a row is said once, to the people who
 * can write the repository: one `webhook.failing` per streak, ended by a
 * success, never shown to readers, and never trusted as markup.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { audienceFilter } from "../src/core/event_audience.ts";
import { listEvents } from "../src/core/events.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { id } from "../src/kernel/id.ts";
import { createWebhook, deliverDue, enqueueForEvent } from "../src/core/webhooks.ts";
import { noteFailure } from "../src/core/webhook_streak.ts";
import { readFeed } from "../src/feed/feed.ts";
import { feedCard } from "../src/web/studio/feed.ts";
import { getUserById } from "../src/core/users.ts";
import { canWrite, getRepoById } from "../src/core/repos.ts";
import { candidatesFor } from "../src/feed/items.ts";
import { noChips } from "../src/core/feed_chips.ts";
import { createLog } from "../src/kernel/log.ts";
import { promote } from "./helpers/members.ts";

describe("a failing webhook", () => {
  let dir: string;
  let app: App;
  let alice: User;
  let bob: User;
  let repo: Repo;
  let hookId: string;

  const mk = async (username: string, first = false) => {
    const r = await createUser(app.db, {
      origin: "seed", trusted: true, username, email: `${username}@forge.local`,
      password: "a-good-passphrase", adminIfFirst: first,
    });
    if (!r.ok) throw new Error(r.error);
    promote(app.db, r.value);
    return r.value;
  };
  const hook = (url: string): string => {
    const r = createWebhook(app.db, { repoId: repo.id, url, kinds: "*", secret: "s3cret-signing-key-0123456789" });
    if (!r.ok) throw new Error(r.error);
    return r.value.webhook.id;
  };
  /** A delivery that has ended in `state`, ids in the order made. */
  const ended = (webhookId: string, state: "ok" | "failed"): string => {
    const ev = app.bus.append({ kind: "push", repoId: repo.id, actorId: alice.id, payload: {} });
    // The bus has already queued it for every matching hook; settle that row.
    app.db.run(
      `INSERT INTO webhook_delivery (id, webhook_id, event_id, state, attempts) VALUES (?1, ?2, ?3, ?4, 6)
       ON CONFLICT (webhook_id, event_id) DO UPDATE SET state = ?4, attempts = 6`,
      [id(), webhookId, ev.id, state],
    );
    const did = app.db
      .query<{ id: string }, [string, string]>("SELECT id FROM webhook_delivery WHERE webhook_id = ?1 AND event_id = ?2")
      .get(webhookId, ev.id)!.id;
    return did;
  };
  const failing = () => listEvents(app.db, { kinds: ["webhook.failing"] }).filter((e) => e.repoId === repo.id);
  const fail = (webhookId: string, reason = "answered HTTP 500") => {
    ended(webhookId, "failed");
    noteFailure(app.db, app.bus, webhookId, reason);
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-hookfail-"));
    app = createApp({ dataDir: dir, port: 0 });
    alice = await mk("alice", true);
    bob = await mk("bob");
    const made = await createRepo(app, alice, { name: "open", visibility: "public" });
    if (!made.ok) throw new Error(made.error);
    repo = made.value;
    hookId = hook("https://hooks.example.test/services/s3cr3t-in-the-path");
  });
  afterAll(async () => {
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("says nothing before the third failure, then once, and not again on a fourth", () => {
    fail(hookId);
    fail(hookId);
    expect(failing()).toHaveLength(0);
    fail(hookId, "answered HTTP 502");
    expect(failing()).toHaveLength(1);
    const [event] = failing();
    expect(event!.payload.host).toBe("hooks.example.test");
    expect(event!.payload.reason).toBe("answered HTTP 502");
    expect(JSON.stringify(event!.payload)).not.toContain("s3cr3t");
    fail(hookId);
    fail(hookId);
    expect(failing()).toHaveLength(1);
  });

  test("the news is not queued as a delivery to any hook", () => {
    const [event] = failing();
    const queued = app.db
      .query<{ n: number }, [string]>("SELECT count(*) n FROM webhook_delivery WHERE event_id = ?1")
      .get(event!.id)!.n;
    expect(queued).toBe(0);
  });

  test("a success ends the streak, and three more failures are a new one", () => {
    ended(hookId, "ok");
    fail(hookId);
    fail(hookId);
    expect(failing()).toHaveLength(1);
    fail(hookId);
    expect(failing()).toHaveLength(2);
  });

  test("the worker reports a refused delivery's reason on the third", async () => {
    const other = hook("https://hooks.example.test/other");
    // A private address is refused at once, with its reason, and never retried.
    app.db.run("UPDATE webhook SET url = 'http://127.0.0.1/x' WHERE id = ?1", [other]);
    const before = failing().length;
    for (let i = 0; i < 3; i++) {
      const ev = app.bus.append({ kind: "push", repoId: repo.id, actorId: alice.id, payload: {} });
      enqueueForEvent(app.db, ev);
    }
    await deliverDue(app.db, createLog("test"), new Date(), {}, app.bus);
    const now = failing();
    expect(now.length).toBe(before + 1);
    expect(now[0]!.payload.host).toBe("127.0.0.1");
    expect(String(now[0]!.payload.reason)).toContain("refused");
  });

  test("writers hear it, readers do not", () => {
    const event = failing()[0]!;
    expect(audienceFilter(app.db, alice)(event)).toBe(true);
    expect(audienceFilter(app.db, bob)(event)).toBe(false);
    expect(audienceFilter(app.db, undefined)(event)).toBe(false);
  });

  test("the line links to the repository and says an admin acts; readers get none", () => {
    const evil = hook("https://hooks.example.test/evil");
    for (let i = 0; i < 3; i++) fail(evil, '<img src=x onerror="alert(1)">');
    const lines = candidatesFor(app.db, alice, Date.now(), noChips).filter((c) => c.what.startsWith("Webhook to "));
    const line = lines.find((c) => c.what.includes("<img"))!;
    expect(line.what).toStartWith('Webhook to hooks.example.test failed 3 times: <img src=x');
    expect(line.what).toContain("a repository admin can redeliver or pause it in Settings › Webhooks");
    expect(line.link).toBe(`/${repo.ownerName}/${repo.name}/settings/hooks`);
    expect(candidatesFor(app.db, bob, Date.now(), noChips).some((c) => c.what.startsWith("Webhook to "))).toBe(false);
  });

  test("the rendered card escapes the reason and the host", () => {
    const evil = hook("https://hooks.example.test/evil2");
    for (let i = 0; i < 3; i++) fail(evil, '<img src=x onerror="alert(1)">');
    // A host cannot hold markup once parsed, but a payload is only data: forge one.
    app.bus.append({
      kind: "webhook.failing",
      repoId: repo.id,
      payload: { webhookId: "w", since: "s", host: "<b>evil</b>.test", reason: "<script>x()</script>", failures: 3 },
    });
    const cards = readFeed(app.db, alice, { now: Date.now(), limit: 100 })
      .items.filter((c) => c.what.startsWith("Webhook to "))
      .map((c) => feedCard(c).text);
    expect(cards.length).toBeGreaterThanOrEqual(2);
    const all = cards.join("\n");
    expect(all).toContain("&lt;img src=x onerror=");
    expect(all).toContain("&lt;b&gt;evil&lt;/b&gt;.test");
    expect(all).toContain("&lt;script&gt;");
    expect(all).not.toContain("<img src=x");
    expect(all).not.toContain("<b>evil");
    expect(all).not.toContain("<script>");
  });

  test("a suspended writer hears nothing", () => {
    const event = failing()[0]!;
    expect(audienceFilter(app.db, alice)(event)).toBe(true);
    app.db.run("UPDATE user SET suspended_at = ?2 WHERE id = ?1", [bob.id, new Date().toISOString()]);
    // Bob owns a repository of his own with a hook of his own.
    const suspended = getUserById(app.db, bob.id)!;
    app.db.run("UPDATE repo SET owner_id = ?2 WHERE id = ?1", [repo.id, bob.id]);
    const ownerRepo = getRepoById(app.db, repo.id)!;
    expect(canWrite(app.db, ownerRepo, suspended)).toBe(true);
    expect(audienceFilter(app.db, suspended)(event)).toBe(false);
    app.db.run("UPDATE repo SET owner_id = ?2 WHERE id = ?1", [repo.id, alice.id]);
    app.db.run("UPDATE user SET suspended_at = NULL WHERE id = ?1", [bob.id]);
  });
});
