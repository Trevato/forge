import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createIssue } from "../src/core/issues.ts";
import { createRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { createWebhook, enqueueForEvent, recentDeliveries, redeliver } from "../src/core/webhooks.ts";

let dir: string;
let app: App;
let repoId: string;
let userId: string;

const hook = (url: string): string => {
  const r = createWebhook(app.db, { repoId, url, kinds: "*", secret: "s3cret-signing-key-0123456789" });
  if (!r.ok) throw new Error(r.error);
  return r.value.webhook.id;
};
const queue = (webhookId: string, state: string): string => {
  const ev = app.bus.append({ kind: "push", repoId, actorId: userId, payload: {} });
  enqueueForEvent(app.db, ev);
  const row = app.db
    .query<{ id: string }, [string, string]>("SELECT id FROM webhook_delivery WHERE webhook_id = ?1 AND event_id = ?2")
    .get(webhookId, ev.id)!;
  app.db.run(
    "UPDATE webhook_delivery SET state = ?2, attempts = 6, last_status = 500, next_try_at = '2999-01-01T00:00:00.000Z' WHERE id = ?1",
    [row.id, state],
  );
  return row.id;
};
const row = (id: string) =>
  app.db
    .query<{ state: string; attempts: number; next_try_at: string | null }, [string]>(
      "SELECT state, attempts, next_try_at FROM webhook_delivery WHERE id = ?1",
    )
    .get(id)!;
const count = (): number => app.db.query<{ n: number }, []>("SELECT count(*) n FROM webhook_delivery").get()!.n;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-redeliver-"));
  app = createApp({ dataDir: dir, port: 0 });
  const u = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  userId = u.value.id;
  const r = await createRepo(app.db, app.reposRoot, { ownerId: userId, name: "lobby" });
  if (!r.ok) throw new Error(r.error);
  repoId = r.value.id;
});
afterAll(async () => {
  app.db.close();
  await rm(dir, { recursive: true, force: true });
});

test("a failed delivery goes back to pending, attempts 0, claim cleared, same row", () => {
  const w = hook("https://example.com/a");
  const d = queue(w, "failed");
  const before = count();
  expect(redeliver(app.db, d, w).ok).toBe(true);
  expect(row(d)).toEqual({ state: "pending", attempts: 0, next_try_at: null });
  expect(count()).toBe(before);
  expect(recentDeliveries(app.db, w)[0]!.state).toBe("pending");
});

test("ok, pending and another hook's delivery are refused and unchanged", () => {
  const w = hook("https://example.com/b");
  const other = hook("https://example.com/c");
  for (const state of ["ok", "pending"]) {
    const d = queue(w, state);
    expect(redeliver(app.db, d, w)).toEqual({ ok: false, error: "not_failed" });
    expect(row(d).attempts).toBe(6);
  }
  const d = queue(w, "failed");
  expect(redeliver(app.db, d, other)).toEqual({ ok: false, error: "not_found" });
  expect(redeliver(app.db, "nope", w)).toEqual({ ok: false, error: "not_found" });
  expect(row(d).state).toBe("failed");
});

test("a sealed report's delivery stays refused", () => {
  const w = hook("https://example.com/d");
  const issue = createIssue(app.db, { repoId, authorId: userId, title: "Hole", body: "x", sealed: true });
  if (!issue.ok) throw new Error(issue.error);
  const ev = app.bus.append({
    kind: "issue.opened", repoId, actorId: userId, payload: { number: issue.value.number },
  });
  app.db.run("INSERT INTO webhook_delivery (id, webhook_id, event_id, state) VALUES ('sealed1', ?1, ?2, 'failed')", [w, ev.id]);
  expect(redeliver(app.db, "sealed1", w)).toEqual({ ok: false, error: "sealed" });
  expect(row("sealed1").state).toBe("failed");
});
