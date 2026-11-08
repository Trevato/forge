/**
 * Webhook delivery, driven by the event outbox. When an event is appended we
 * enqueue a durable delivery row per matching webhook; a background worker
 * sends them, signs each with the webhook's secret (HMAC-SHA256), and retries
 * with backoff. Delivery is decoupled from the event write, so a slow or dead
 * endpoint never blocks the action that produced the event — and a sweep
 * catches anything the fast path missed. This is the "moving data out over
 * secure channels" surface.
 */

import { eventSealed } from "./sealed.ts";
import type { Database } from "bun:sqlite";
import { defect } from "../kernel/error.ts";
import { id, secret as randomSecret } from "../kernel/id.ts";
import type { Log } from "../kernel/log.ts";
import {
  outboundFetch,
  RefusedError,
  type OutboundOptions,
} from "../kernel/outbound.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import type { ForgeEvent } from "./events.ts";

const MAX_ATTEMPTS = 6;
const DELIVER_TIMEOUT_MS = 10_000;

export interface Webhook {
  readonly id: string;
  readonly repoId: string;
  readonly url: string;
  readonly kinds: string;
  readonly active: boolean;
  readonly createdAt: string;
  /** Whether a signing secret is set — the value itself is write-only. */
  readonly hasSecret: boolean;
}

interface WebhookRow {
  id: string;
  repo_id: string;
  url: string;
  secret: string;
  kinds: string;
  active: number;
  created_at: string;
}

function toWebhook(row: WebhookRow): Webhook {
  return {
    id: row.id,
    repoId: row.repo_id,
    url: row.url,
    kinds: row.kinds,
    active: row.active === 1,
    createdAt: row.created_at,
    hasSecret: row.secret !== "",
  };
}

export type CreateWebhookError = "invalid_url";

export interface CreateWebhookInput {
  repoId: string;
  url: string;
  /** Space-separated event kinds, or "*" for all. Globs like "issue.*" match. */
  kinds?: string;
  /** If omitted, a strong secret is generated so deliveries are always signed. */
  secret?: string;
}

export function createWebhook(
  db: Database,
  input: CreateWebhookInput,
): Result<{ webhook: Webhook; secret: string }, CreateWebhookError> {
  const url = input.url.trim();
  // Only https, and never a bare/relative URL — this value is fetched.
  if (!/^https:\/\/.+/i.test(url)) return err("invalid_url");
  try {
    // eslint-disable-next-line no-new
    new URL(url);
  } catch {
    return err("invalid_url");
  }

  const webhookId = id();
  const secretValue =
    input.secret && input.secret !== "" ? input.secret : randomSecret();
  db.query(
    "INSERT INTO webhook (id, repo_id, url, secret, kinds) VALUES (?1, ?2, ?3, ?4, ?5)",
  ).run(
    webhookId,
    input.repoId,
    url,
    secretValue,
    (input.kinds ?? "*").trim() || "*",
  );
  return ok({ webhook: getWebhook(db, input.repoId, webhookId)!, secret: secretValue });
}

export function getWebhook(
  db: Database,
  repoId: string,
  webhookId: string,
): Webhook | undefined {
  const row = db
    .query<
      WebhookRow,
      [string, string]
    >("SELECT * FROM webhook WHERE id = ?1 AND repo_id = ?2")
    .get(webhookId, repoId);
  return row ? toWebhook(row) : undefined;
}

export function listWebhooks(db: Database, repoId: string): Webhook[] {
  return db
    .query<
      WebhookRow,
      [string]
    >("SELECT * FROM webhook WHERE repo_id = ?1 ORDER BY id")
    .all(repoId)
    .map(toWebhook);
}

export function deleteWebhook(
  db: Database,
  repoId: string,
  webhookId: string,
): boolean {
  return (
    db
      .query("DELETE FROM webhook WHERE id = ?1 AND repo_id = ?2")
      .run(webhookId, repoId).changes > 0
  );
}

/**
 * Pause or resume a hook. False for a hook of another repository. Nothing
 * is backfilled: events that came while paused were never enqueued.
 */
export function setWebhookActive(
  db: Database,
  repoId: string,
  webhookId: string,
  active: boolean,
): boolean {
  return (
    db
      .query("UPDATE webhook SET active = ?3 WHERE id = ?1 AND repo_id = ?2")
      .run(webhookId, repoId, active ? 1 : 0).changes > 0
  );
}

/** Does a webhook's `kinds` spec match an event kind? */
export function kindMatches(spec: string, kind: string): boolean {
  for (const pattern of spec.split(/\s+/).filter(Boolean)) {
    if (pattern === "*" || pattern === kind) return true;
    if (pattern.endsWith(".*") && kind.startsWith(pattern.slice(0, -1)))
      return true;
  }
  return false;
}

/**
 * Enqueue a durable delivery row for every active webhook that wants this
 * event. Idempotent via the (webhook_id, event_id) unique key, so the sweep
 * and the fast path can both run without double-sending.
 */
export function enqueueForEvent(db: Database, event: ForgeEvent): number {
  if (event.repoId === null) return 0;
  // A hook's URL is somewhere else: nothing about a sealed report goes
  // there, not even that it moved (`sealed.ts`).
  if (eventSealed(db, event)) return 0;
  const hooks = db
    .query<
      { id: string; kinds: string },
      [string]
    >("SELECT id, kinds FROM webhook WHERE repo_id = ?1 AND active = 1")
    .all(event.repoId);
  let queued = 0;
  const insert = db.query(
    "INSERT OR IGNORE INTO webhook_delivery (id, webhook_id, event_id) VALUES (?1, ?2, ?3)",
  );
  for (const hook of hooks) {
    if (!kindMatches(hook.kinds, event.kind)) continue;
    if (insert.run(id(), hook.id, event.id).changes > 0) queued++;
  }
  return queued;
}

/** Pings one hook may be sent in a minute. */
export const PING_LIMIT = 3;
const PING_WINDOW_MS = 60_000;

/**
 * Queue one `ping` delivery for one hook, whatever kinds it subscribes to.
 * The payload lives on the delivery row, never in the event log, so no feed,
 * stream or other hook hears of it; the request is made later by `deliverDue`, which keeps the
 * egress refusal. `retryAfter` is in seconds when the hook was pinged too
 * often.
 */
export function pingWebhook(
  db: Database,
  repoSlug: string,
  hook: Webhook,
  now = new Date(),
): Result<{ id: string }, { retryAfter: number }> {
  const since = new Date(now.getTime() - PING_WINDOW_MS).toISOString();
  const recent = db
    .query<{ n: number; first: string | null }, [string, string]>(
      `SELECT COUNT(*) AS n, MIN(created_at) AS first
       FROM webhook_ping
       WHERE webhook_id = ?1 AND created_at > ?2`,
    )
    .get(hook.id, since)!;
  if (recent.n >= PING_LIMIT) {
    const first = recent.first ? Date.parse(recent.first) : now.getTime();
    const wait = Math.ceil((first + PING_WINDOW_MS - now.getTime()) / 1000);
    return err({ retryAfter: Math.max(1, wait) });
  }
  const at = now.toISOString();
  const deliveryId = id();
  db.query(
    "INSERT INTO webhook_ping (id, webhook_id, payload, created_at) VALUES (?1, ?2, ?3, ?4)",
  ).run(
    deliveryId,
    hook.id,
    JSON.stringify({ kind: "ping", repo: repoSlug, hook: hook.id, at }),
    at,
  );
  return ok({ id: deliveryId });
}

export type RedeliverError = "not_found" | "not_failed" | "sealed";

/**
 * Send a failed delivery again: the same row goes back to `pending` with
 * its attempts reset and its claim cleared, and `deliverDue` picks it up on
 * its next pass. No new row, no new event. Only a `failed` delivery of this
 * hook moves, and in one statement, so a row a sender holds (it is
 * `pending` while claimed) is never reset under it. A sealed report's
 * delivery stays refused, as `enqueueForEvent` refuses it. The read, the
 * sealed check and the update share one immediate transaction, so a report
 * sealed in between cannot slip through.
 */
export function redeliver(
  db: Database,
  deliveryId: string,
  webhookId: string,
): Result<true, RedeliverError> {
  return db.transaction(() => redeliverIn(db, deliveryId, webhookId)).immediate();
}

function redeliverIn(db: Database, deliveryId: string, webhookId: string): Result<true, RedeliverError> {
  const row = db
    .query<
      { state: string; repo_id: string | null; payload: string },
      [string, string]
    >(
      `SELECT d.state, e.repo_id, e.payload
       FROM webhook_delivery d JOIN event e ON e.id = d.event_id
       WHERE d.id = ?1 AND d.webhook_id = ?2`,
    )
    .get(deliveryId, webhookId);
  if (row === null) return err("not_found");
  if (row.state !== "failed") return err("not_failed");
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    // an unreadable payload is treated as not sealed (it names no issue); the
    // event table's JSON check makes this unreachable, so no test can drive it
  }
  if (eventSealed(db, { repoId: row.repo_id, payload })) return err("sealed");
  const moved = db
    .query(
      `UPDATE webhook_delivery
          SET state = 'pending', attempts = 0, next_try_at = NULL,
              last_status = NULL, last_error = NULL
        WHERE id = ?1 AND webhook_id = ?2 AND state = 'failed'`,
    )
    .run(deliveryId, webhookId);
  return moved.changes === 1 ? ok(true) : err("not_failed");
}

// ---- the worker ----

interface DueRow {
  id: string;
  webhook_id: string;
  event_id: string | null;
  /** True when the row is in `webhook_ping`, not `webhook_delivery`. */
  ping: boolean;
  attempts: number;
  url: string;
  secret: string;
  kind: string;
  repo_id: string | null;
  actor_id: string | null;
  payload: string;
  created_at: string;
}

/** Deliver all due pending deliveries. Returns how many were attempted. */
/**
 * How long a claimed delivery is its sender's before another may try it:
 * well past the longest one send may take, so a claim never lapses while
 * its sender is still waiting on the endpoint.
 */
export const CLAIM_MS = 60_000;
export { DELIVER_TIMEOUT_MS };

export async function deliverDue(
  db: Database,
  log: Log,
  now = new Date(),
  outbound: OutboundOptions = {},
): Promise<number> {
  const nowIso = now.toISOString();
  const events = db
    .query<DueRow, [string]>(
      `SELECT d.id, d.webhook_id, d.event_id, 0 AS ping, d.attempts,
              w.url, w.secret,
              e.kind, e.repo_id, e.actor_id, e.payload, e.created_at
       FROM webhook_delivery d
       JOIN webhook w ON w.id = d.webhook_id
       JOIN event e ON e.id = d.event_id
       WHERE d.state = 'pending' AND w.active = 1
         AND (d.next_try_at IS NULL OR d.next_try_at <= ?1)
       ORDER BY d.id LIMIT 50`,
    )
    .all(nowIso);
  const pings = db
    .query<DueRow, [string]>(
      `SELECT d.id, d.webhook_id, NULL AS event_id, 1 AS ping, d.attempts,
              w.url, w.secret,
              'ping' AS kind, NULL AS repo_id, NULL AS actor_id,
              d.payload, d.created_at
       FROM webhook_ping d
       JOIN webhook w ON w.id = d.webhook_id
       WHERE d.state = 'pending' AND w.active = 1
         AND (d.next_try_at IS NULL OR d.next_try_at <= ?1)
       ORDER BY d.id LIMIT 50`,
    )
    .all(nowIso);
  const due = [...events, ...pings].map((r) => ({ ...r, ping: !!r.ping }));

  for (const row of due) {
    // Claimed before it is sent: two forge processes over one database (a
    // roll) both see it pending, and only the one whose claim lands sends
    // it. A claim is a short lease on `next_try_at`, taken from the clock at
    // the moment of claiming — not the batch's start, which a slow endpoint
    // earlier in the batch may have left a minute behind. A sender that dies
    // mid-send leaves it to be tried again when the lease runs out.
    const claimAt = Date.now();
    const claimed = db
      .query(
        `UPDATE ${tableOf(row)} SET next_try_at = ?2
          WHERE id = ?1 AND state = 'pending'
            AND (next_try_at IS NULL OR next_try_at <= ?3)`,
      )
      .run(
        row.id,
        new Date(claimAt + CLAIM_MS).toISOString(),
        new Date(Math.max(claimAt, now.getTime())).toISOString(),
      );
    if (claimed.changes !== 1) continue;
    try {
      await deliverOne(db, log, row, now, outbound);
    } catch (error) {
      // One malformed delivery must not take the batch with it. Without
      // this, a single unsendable row stops every delivery behind it — and
      // stops them again on the next tick, and the next, because the queue
      // is ordered and that row is always at the head. A wedged outbox is
      // the worst failure this file has, so a surprise costs one attempt
      // and a backoff, exactly like an endpoint that answered 500.
      log.error("webhook delivery threw", {
        delivery: row.id,
        error: String(error),
      });
      backOff(db, log, row, 0, now);
    }
  }
  return due.length;
}

/** Where a due row lives: a ping has its own table, never the event log's. */
function tableOf(row: DueRow): "webhook_ping" | "webhook_delivery" {
  return row.ping ? "webhook_ping" : "webhook_delivery";
}

async function deliverOne(
  db: Database,
  log: Log,
  row: DueRow,
  now: Date,
  outbound: OutboundOptions,
): Promise<void> {
  // A ping's body is its payload as it stands: { kind, repo, hook, at }.
  const body =
    row.ping
      ? row.payload
      : JSON.stringify({
          id: row.event_id,
          kind: row.kind,
          repo_id: row.repo_id,
          actor_id: row.actor_id,
          payload: JSON.parse(row.payload),
          created_at: row.created_at,
        });
  const signature = await sign(row.secret, body);
  const attempt = row.attempts + 1;

  let status = 0;
  try {
    const response = await outboundFetch(
      row.url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "forge-webhook",
          "x-forge-event": row.kind,
          "x-forge-delivery": row.id,
          ...(signature === ""
            ? {}
            : { "x-forge-signature-256": `sha256=${signature}` }),
        },
        body,
        signal: AbortSignal.timeout(DELIVER_TIMEOUT_MS),
        redirect: "manual",
      },
      outbound,
    );
    status = response.status;
  } catch (error) {
    if (error instanceof RefusedError) {
      // A private address or a plain-http URL will not mend itself in
      // seconds, so there is nothing to retry: fail it now, with the reason.
      log.warn("webhook delivery refused", { delivery: row.id });
      db.query(
        `UPDATE ${tableOf(row)} SET state = 'failed', attempts = ?1, last_status = NULL, last_error = ?2 WHERE id = ?3`,
      ).run(attempt, error.message, row.id);
      return;
    }
    log.warn("webhook delivery error", {
      delivery: row.id,
      error: String(error),
    });
  }

  const ok2xx = status >= 200 && status < 300;
  if (ok2xx) {
    db.query(
      `UPDATE ${tableOf(row)} SET state = 'ok', attempts = ?1, last_status = ?2, last_error = NULL WHERE id = ?3`,
    ).run(attempt, status, row.id);
    return;
  }
  backOff(db, log, row, status, now);
}

/** Record an attempt and schedule the next one — or give up. */
function backOff(
  db: Database,
  log: Log,
  row: DueRow,
  status: number,
  now: Date,
): void {
  const attempt = row.attempts + 1;
  if (attempt >= MAX_ATTEMPTS) {
    db.query(
      `UPDATE ${tableOf(row)} SET state = 'failed', attempts = ?1, last_status = ?2 WHERE id = ?3`,
    ).run(attempt, status, row.id);
    log.warn("webhook delivery gave up", {
      delivery: row.id,
      attempts: attempt,
      status,
    });
    return;
  }
  // Exponential backoff: ~10s, 40s, 90s, … capped implicitly by attempt count.
  const delayMs = attempt * attempt * 10_000;
  const nextTry = new Date(now.getTime() + delayMs).toISOString();
  db.query(
    `UPDATE ${tableOf(row)} SET attempts = ?1, last_status = ?2, next_try_at = ?3 WHERE id = ?4`,
  ).run(attempt, status, nextTry, row.id);
}

async function sign(secret: string, body: string): Promise<string> {
  // WebCrypto refuses a zero-length HMAC key, and a webhook row can carry
  // one: the column defaults to empty, and a hook restored or inserted
  // outside `createWebhook` has never been given a secret. An unsigned hook
  // is a choice somebody made, not a reason to throw inside the worker —
  // so it goes out with no signature header at all rather than a broken one.
  if (secret === "") return "";
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  return Array.from(new Uint8Array(mac), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** Verify a delivery signature — exported so consumers (and tests) can check. */
export async function verifySignature(
  secret: string,
  body: string,
  header: string,
): Promise<boolean> {
  const expected = `sha256=${await sign(secret, body)}`;
  // Constant-time-ish compare on equal-length strings.
  if (header.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < header.length; i++)
    diff |= header.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export interface DeliveryInfo {
  readonly id: string;
  readonly state: "pending" | "ok" | "failed";
  readonly attempts: number;
  readonly lastStatus: number | null;
  /** Why nothing was sent ("refused: private address"), when nothing was. */
  readonly lastError: string | null;
  readonly kind: string;
}

export function recentDeliveries(
  db: Database,
  webhookId: string,
  limit = 20,
): DeliveryInfo[] {
  const rows = db
    .query<
      {
        id: string;
        state: "pending" | "ok" | "failed";
        attempts: number;
        last_status: number | null;
        last_error: string | null;
        kind: string;
      },
      [string, number]
    >(
      `SELECT id, state, attempts, last_status, last_error, kind FROM (
         SELECT d.id, d.state, d.attempts, d.last_status, d.last_error, e.kind
         FROM webhook_delivery d JOIN event e ON e.id = d.event_id
         WHERE d.webhook_id = ?1
         UNION ALL
         SELECT id, state, attempts, last_status, last_error, 'ping' AS kind
         FROM webhook_ping WHERE webhook_id = ?1
       ) ORDER BY id DESC LIMIT ?2`,
    )
    .all(webhookId, limit);
  return rows.map((r) => ({
    id: r.id,
    state: r.state,
    attempts: r.attempts,
    lastStatus: r.last_status,
    lastError: r.last_error,
    kind: r.kind,
  }));
}

/**
 * One batch at a time, per forge.
 *
 * The timer fires every five seconds; a batch of fifty deliveries to a slow
 * endpoint takes longer than that, and without this guard the next tick
 * starts a second batch over the *same* rows — the deliveries are attempted
 * twice, the backoff arithmetic races, and the queue gets deeper the further
 * behind it falls. Single-flight turns a slow endpoint into a slow queue
 * instead of a runaway one.
 *
 * Keyed by the database rather than held in a module flag, because one
 * process can run several forges (every test file does) and one forge's slow
 * endpoint must not silence another's queue.
 */
const delivering = new WeakSet<Database>();

/** For tests and for anyone who wants to know why nothing is being sent. */
export const deliveryBusy = (db: Database): boolean => delivering.has(db);

/** A never-throwing wrapper for the worker loop's fire-and-forget calls. */
export function runDelivery(db: Database, log: Log): void {
  if (delivering.has(db)) return;
  delivering.add(db);
  deliverDue(db, log)
    .catch((error) => {
      // The worker must survive any delivery batch failing — a thrown rejection
      // here would take the process down (a lesson paid for elsewhere).
      if (!log) defect("webhook.no_log", "delivery worker missing log");
      log.error("delivery batch failed", { error: String(error) });
    })
    .finally(() => {
      delivering.delete(db);
    });
}
