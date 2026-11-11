/**
 * The store of orders (#11138): a visitor's purchase of a forge, from the
 * name being held to the forge being made. Plain rows in, plain rows out;
 * the checkout and the spawn are in `actions/order.ts`.
 *
 * States: `pending` (name held for 30 minutes, nothing paid), `paid`
 * (money taken, forge not yet made), `spawning`, `spawned`, `failed` (paid,
 * the forge could not be made: an admin's alarm). A move is one UPDATE that
 * names the state it leaves, so two deliveries of the same payment cannot
 * both make the forge: only the one whose UPDATE changed a row goes on.
 * The buyer's ticket (a cookie) is kept as its sha256; the claim link is
 * never kept.
 */

import type { Database } from "bun:sqlite";
import { sha256 } from "../kernel/hash.ts";

export type OrderState = "pending" | "paid" | "spawning" | "spawned" | "failed";

/** The hold outlives the checkout (`CHECKOUT_MS`) so a buyer who pays at the last minute still finds the name theirs. */
export const HOLD_MS = 35 * 60_000;
/** How long the provider's checkout stays payable; Stripe's least is 30 minutes. */
export const CHECKOUT_MS = 31 * 60_000;
/** Most orders waiting for payment at once: a name-hoarder cannot hold the whole namespace. */
export const MAX_PENDING = 200;
/** Most orders one client address may have waiting at once: one stranger cannot fill the shared cap. */
export const MAX_PENDING_PER_ADDRESS = 3;

export interface Order {
  readonly id: string;
  readonly name: string;
  readonly plan: string;
  readonly email: string;
  readonly state: OrderState;
  readonly sessionId: string;
  readonly customerId: string;
  readonly subscriptionId: string;
  readonly reason: string;
  readonly createdAt: number;
  readonly holdUntil: number;
  readonly updatedAt: number;
  readonly shownAt: number | null;
  readonly resentAt: number | null;
}

interface Row {
  id: string; name: string; plan: string; email: string; state: OrderState; ticket_hash: string; session_id: string;
  customer_id: string; subscription_id: string; reason: string; created_at: number; hold_until: number; updated_at: number;
  shown_at: number | null; resent_at: number | null;
}

const fromRow = (r: Row): Order => ({
  id: r.id, name: r.name, plan: r.plan, email: r.email, state: r.state, sessionId: r.session_id, customerId: r.customer_id,
  subscriptionId: r.subscription_id, reason: r.reason, createdAt: r.created_at, holdUntil: r.hold_until, updatedAt: r.updated_at,
  shownAt: r.shown_at, resentAt: r.resent_at,
});

export const newId = (): string => `ord_${crypto.randomUUID().replace(/-/g, "")}`;
export const newTicket = (): string => Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex");

export function getOrder(db: Database, id: string): Order | undefined {
  const r = db.query<Row, [string]>("SELECT * FROM forge_order WHERE id = ?1").get(id);
  return r ? fromRow(r) : undefined;
}

export function bySession(db: Database, sessionId: string): Order | undefined {
  if (sessionId === "") return undefined;
  const r = db.query<Row, [string]>("SELECT * FROM forge_order WHERE session_id = ?1").get(sessionId);
  return r ? fromRow(r) : undefined;
}

/** True when the ticket is the one the order was made with. */
export function ticketFits(db: Database, id: string, ticket: string): boolean {
  const r = db.query<{ ticket_hash: string }, [string]>("SELECT ticket_hash FROM forge_order WHERE id = ?1").get(id);
  return r !== null && ticket !== "" && r.ticket_hash === sha256(ticket);
}

/** Whether an order other than a lapsed pending one holds `name` now. */
export function nameHeld(db: Database, name: string, now: number): boolean {
  return (
    db
      .query<{ n: number }, [string, number]>(
        "SELECT COUNT(*) AS n FROM forge_order WHERE name = ?1 AND (state != 'pending' OR hold_until > ?2)",
      )
      .get(name, now)?.n !== 0
  );
}

/** Orders waiting for payment from one client address (`http/peer.ts` `clientBucket`, never a header). */
export const pendingFrom = (db: Database, address: string, now: number): number =>
  db.query<{ n: number }, [string, number]>("SELECT COUNT(*) AS n FROM forge_order WHERE state = 'pending' AND hold_until > ?2 AND address = ?1").get(address, now)?.n ?? 0;

export const pendingCount = (db: Database, now: number): number =>
  db.query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM forge_order WHERE state = 'pending' AND hold_until > ?1").get(now)?.n ?? 0;

/** Write a new pending order. The hold is checked and the row written in one transaction. False when the name is held. */
export function holdName(db: Database, o: { id: string; name: string; plan: string; email: string; ticket: string; address: string }, now: number): boolean {
  return db.transaction(() => {
    if (nameHeld(db, o.name, now)) return false;
    db.query(
      `INSERT INTO forge_order (id, name, plan, email, state, ticket_hash, created_at, hold_until, updated_at, address)
       VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?7, ?6, ?8)`,
    ).run(o.id, o.name, o.plan, o.email, sha256(o.ticket), now, now + HOLD_MS, o.address);
    return true;
  })();
}

export function setSession(db: Database, id: string, sessionId: string): void {
  db.query("UPDATE forge_order SET session_id = ?2 WHERE id = ?1").run(id, sessionId);
}

/** Drop a pending order whose checkout could not be made: its name is free again. */
export function dropPending(db: Database, id: string): void {
  db.query("DELETE FROM forge_order WHERE id = ?1 AND state = 'pending'").run(id);
}

/** Move `from` to `to`; true only for the caller whose statement changed the row. */
export function move(db: Database, id: string, from: OrderState, to: OrderState, now: number, extra: { reason?: string; customerId?: string; subscriptionId?: string } = {}): boolean {
  return (
    db
      .query(
        `UPDATE forge_order SET state = ?3, updated_at = ?4, reason = ?5,
           customer_id = CASE WHEN ?6 = '' THEN customer_id ELSE ?6 END,
           subscription_id = CASE WHEN ?7 = '' THEN subscription_id ELSE ?7 END
         WHERE id = ?1 AND state = ?2`,
      )
      .run(id, from, to, now, extra.reason ?? "", extra.customerId ?? "", extra.subscriptionId ?? "").changes === 1
  );
}

/** The buyer has been shown the link: true once, for the caller that marks it. */
export function markShown(db: Database, id: string, now: number): boolean {
  return db.query("UPDATE forge_order SET shown_at = ?2 WHERE id = ?1 AND shown_at IS NULL").run(id, now).changes === 1;
}

/** Give the link back: a mint that failed leaves the buyer able to see it on the next visit. */
export function unmarkShown(db: Database, id: string): void {
  db.query("UPDATE forge_order SET shown_at = NULL WHERE id = ?1").run(id);
}

export function markResent(db: Database, id: string, now: number): void {
  db.query("UPDATE forge_order SET resent_at = ?2 WHERE id = ?1").run(id, now);
}

/** The newest spawned order for a name and email, for a re-send. */
export function spawnedFor(db: Database, name: string, email: string): Order | undefined {
  const r = db
    .query<Row, [string, string]>("SELECT * FROM forge_order WHERE name = ?1 AND lower(email) = ?2 AND state = 'spawned' ORDER BY created_at DESC LIMIT 1")
    .get(name, email.toLowerCase());
  return r ? fromRow(r) : undefined;
}

/** Orders an admin must look at: paid and not made. Newest first. */
export function failedOrders(db: Database): Order[] {
  return db.query<Row, []>("SELECT * FROM forge_order WHERE state = 'failed' ORDER BY updated_at DESC LIMIT 50").all().map(fromRow);
}

export function recentOrders(db: Database, limit = 20): Order[] {
  return db.query<Row, [number]>("SELECT * FROM forge_order WHERE state != 'pending' ORDER BY updated_at DESC LIMIT ?1").all(limit).map(fromRow);
}
