/**
 * The event outbox — the forge's one queue. Every event is a durable row
 * first; in-process listeners (SSE, webhook delivery) are woken afterwards
 * as an optimization. Consumers must tolerate replays and use the sweep,
 * never the wake-up, as their source of completeness.
 */

import type { Database } from "bun:sqlite";
import { id } from "../kernel/id.ts";
import { anyHeld, createLog, redactValues } from "../kernel/log.ts";
import { currentVia } from "./acting_via.ts";
import { repoVisible } from "./visibility.ts";

const log = createLog("events");

export interface ForgeEvent {
  readonly id: string;
  readonly kind: string;
  readonly repoId: string | null;
  readonly actorId: string | null;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
  /** Its place in the outbox; set on an event the tail read (`core/event_tail.ts`), no other. */
  readonly seq?: number;
  /** Set when the actor acted through the forge's agent: `conversation:<id>`. */
  readonly via?: string;
}

export type EventListener = (event: ForgeEvent) => void;

/**
 * When a listener hears an event. With one thread (the default) every
 * listener hears every event inside `append`, as it always did, and the mode
 * means nothing. With the engine on its own thread (`engine/`), the bus is
 * split: an `inline` listener (the default: a cache, a reactor, a screen) hears
 * its own thread's appends at once, as ever, and the other thread's from the
 * tail; a `local` one (it writes, so it must act once, where the event was
 * made) hears only its own appends; an `ordered` one (an event stream, whose
 * ids are its readers' cursors) hears everything from the tail alone, so
 * committed and in `seq` order.
 */
export type ListenerMode = "ordered" | "inline" | "local";

/** A payload with every granted secret value taken out of its strings. */
function scrubPayload(payload: Record<string, unknown>): Record<string, unknown> {
  if (!anyHeld()) return payload;
  const walk = (v: unknown): unknown =>
    typeof v === "string"
      ? redactValues(v)
      : Array.isArray(v)
        ? v.map(walk)
        : v !== null && typeof v === "object"
          ? Object.fromEntries(
              Object.entries(v).map(([k, x]) => [k, walk(x)]),
            )
          : v;
  return walk(payload) as Record<string, unknown>;
}

export class EventBus {
  private listeners = new Map<EventListener, ListenerMode>();
  /** Ids this bus appended that the tail has not yet handed back: it hears them as its own. */
  private readonly own = new Set<string>();
  /** True once the outbox is tailed (`core/event_tail.ts`): ordered listeners then wait for it. */
  split = false;
  /** Called after each append: wakes the tail, or the other thread. */
  afterAppend: (() => void) | undefined;
  /** Set by the tail: hands over what is committed, so a new listener starts exactly at the head. */
  catchUp: (() => void) | undefined;

  constructor(private readonly db: Database) {}

  /** Appended here and not yet seen by the tail. */
  get pendingOwn(): number {
    return this.own.size;
  }

  /** The tail has read everything committed: what is still pending was rolled back and will not come. */
  forgetPendingOwn(): void {
    this.own.clear();
  }

  /** Durable append, then best-effort wake. Returns the stored event. */
  append(input: {
    kind: string;
    repoId?: string | undefined;
    actorId?: string | undefined;
    payload?: Record<string, unknown> | undefined;
  }): ForgeEvent {
    const via = currentVia(input.actorId);
    const event: ForgeEvent = {
      id: id(),
      kind: input.kind,
      repoId: input.repoId ?? null,
      actorId: input.actorId ?? null,
      payload: scrubPayload(input.payload ?? {}),
      createdAt: new Date().toISOString(),
      ...(via === undefined ? {} : { via }),
    };
    this.db
      .query(
        "INSERT INTO event (id, kind, repo_id, actor_id, payload, created_at, via) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      )
      .run(
        event.id,
        event.kind,
        event.repoId,
        event.actorId,
        JSON.stringify(event.payload),
        event.createdAt,
        via ?? null,
      );

    if (this.split) {
      // A tail that never runs must not grow this without end.
      if (this.own.size >= OWN_KEPT) this.own.delete(this.own.values().next().value as string);
      this.own.add(event.id);
    }
    for (const [listener, mode] of this.listeners)
      if (!this.split || mode !== "ordered") this.hear(listener, event);
    this.afterAppend?.();
    return event;
  }

  /**
   * An event the tail read from the outbox, in `seq` order. Ordered listeners
   * hear all of them; inline ones those the other thread made; local ones none.
   */
  deliver(event: ForgeEvent): void {
    const mine = this.own.delete(event.id);
    for (const [listener, mode] of this.listeners)
      if (mode === "ordered" || (mode === "inline" && !mine)) this.hear(listener, event);
  }

  private hear(listener: EventListener, event: ForgeEvent): void {
    // A listener throw must never travel up into the appender's transaction.
    try {
      listener(event);
    } catch (error) {
      log.error("event listener threw", {
        kind: event.kind,
        error: String(error),
      });
    }
  }

  subscribe(listener: EventListener, mode: ListenerMode = "inline"): () => void {
    if (this.split && mode === "ordered") this.catchUp?.();
    this.listeners.set(listener, mode);
    return () => this.listeners.delete(listener);
  }
}

/** Own ids remembered while the tail catches up: far more than it is ever behind. */
const OWN_KEPT = 4096;

/**
 * Events after the one named `?n`, in the order they were written.
 *
 * An event's id is its name; its place is its `seq`, which every insert
 * takes from a trigger (migration 69), strictly increasing across every
 * connection and untouched by VACUUM.
 * Ids are made in order only within one process: during a roll two write
 * to one database (#875), and an event the other writes in the same
 * millisecond may carry the smaller id. A replay that resumed by id would
 * skip it; resumed by sequence, it misses nothing (#932). A cursor nobody
 * holds (an event pruned, or a guess) falls back to comparing ids. An
 * event a migration writes in SQL takes its `seq` from the same trigger.
 */
const afterEvent = (n: number): string =>
  `(CASE WHEN EXISTS (SELECT 1 FROM event AS c WHERE c.id = ?${n})
      THEN event.seq > (SELECT c.seq FROM event AS c WHERE c.id = ?${n})
      ELSE event.id > ?${n} END)`;

const beforeEvent = (n: number): string =>
  `(CASE WHEN EXISTS (SELECT 1 FROM event AS c WHERE c.id = ?${n})
      THEN event.seq < (SELECT c.seq FROM event AS c WHERE c.id = ?${n})
      ELSE event.id < ?${n} END)`;

export interface ListEventsOptions {
  /** Return events written before this one (exclusive; the next page of a newest-first read). */
  beforeId?: string;
  repoId?: string;
  /** Restrict to events of this kind. */
  kind?: string;
  /** Return events written after this one (exclusive; `afterEvent`). */
  afterId?: string;
  /** @default 100 */
  limit?: number;
  /**
   * Of the newest `limit` events, keep only these kinds. The window is the
   * same one an unfiltered read sees; the rows left out are never parsed,
   * which is what a busy thread's comment events would otherwise cost.
   */
  kinds?: readonly string[];
}

/**
 * The events a viewer may see, filtered in SQL.
 *
 * The activity feed used to read the newest hundred events and drop the ones
 * whose repo the viewer cannot see. On a forge with three repos that is the
 * same answer for less code. On a forge with two thousand it is a feed that
 * shows four rows, or none — because the hundred newest events belong to
 * other people's repositories, and the page has no way to ask for more
 * without reading the whole table. Pushing the filter into the query makes
 * "the twelve most recent things *you* can see" a bounded, indexed read
 * whatever else is going on.
 *
 * Events with no repo (account-level ones) are never included: they are not
 * repository activity, and a feed is about repositories.
 */
export function listEventsVisibleTo(
  db: Database,
  viewer: { id: string } | undefined,
  options: Omit<ListEventsOptions, "repoId"> = {},
): ForgeEvent[] {
  const params: (string | number)[] = [viewer?.id ?? ""];
  let where = `event.repo_id IS NOT NULL AND ${repoVisible(viewer !== undefined)}`;
  if (options.afterId !== undefined) {
    params.push(options.afterId);
    where += ` AND ${afterEvent(params.length)}`;
  }
  if (options.beforeId !== undefined) {
    params.push(options.beforeId);
    where += ` AND ${beforeEvent(params.length)}`;
  }
  params.push(options.limit ?? 100);
  return db
    .query<EventRow, (string | number)[]>(
      `SELECT event.* FROM event JOIN repo ON repo.id = event.repo_id
       WHERE ${where} ORDER BY event.seq DESC LIMIT ?${params.length}`,
    )
    .all(...params)
    .map(toEvent);
}

/**
 * The newest events of one kind addressed to a team this user is on
 * (`payload.team`), from any repository: the caller owes the read check.
 * The feed reads team waits this way (#10164) because its own window is
 * cut by owner and org access, and a crew member who reads a private
 * repository is not in it.
 */
export function listTeamEventsFor(
  db: Database,
  userId: string,
  kind: string,
  limit = 50,
): ForgeEvent[] {
  return db
    .query<EventRow, [string, string, number]>(
      `SELECT * FROM event
       WHERE kind = ?2 AND repo_id IS NOT NULL
         AND json_extract(payload, '$.team') IN (SELECT team_slug FROM crew_team_member WHERE user_id = ?1)
       ORDER BY seq DESC LIMIT ?3`,
    )
    .all(userId, kind, limit)
    .map(toEvent);
}

interface EventRow {
  id: string;
  seq?: number | null;
  kind: string;
  repo_id: string | null;
  actor_id: string | null;
  payload: string;
  created_at: string;
  via?: string | null;
}

const toEvent = (r: EventRow): ForgeEvent => ({
  id: r.id,
  kind: r.kind,
  repoId: r.repo_id,
  actorId: r.actor_id,
  payload: JSON.parse(r.payload) as Record<string, unknown>,
  createdAt: r.created_at,
  ...(r.via ? { via: r.via } : {}),
});

/** Events with a `seq` past `after`, oldest first: what the tail reads (`core/event_tail.ts`). */
export function listEventsAfterSeq(db: Database, after: number, limit = 500): ForgeEvent[] {
  return db
    .query<EventRow, [number, number]>("SELECT * FROM event WHERE seq > ?1 ORDER BY seq LIMIT ?2")
    .all(after, limit)
    .map((r) => ({ ...toEvent(r), seq: r.seq as number }));
}

/** The newest event's `seq`, or 0 for an empty outbox. */
export function headSeq(db: Database): number {
  return db.query<{ s: number | null }, []>("SELECT MAX(seq) AS s FROM event").get()?.s ?? 0;
}

/** One event by id, or undefined. No access check: the caller owes one. */
export function getEvent(db: Database, eventId: string): ForgeEvent | undefined {
  const row = db
    .query<EventRow, [string]>("SELECT * FROM event WHERE id = ?1")
    .get(eventId);
  return row ? toEvent(row) : undefined;
}

export function listEvents(
  db: Database,
  options: ListEventsOptions = {},
): ForgeEvent[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (options.repoId !== undefined) {
    params.push(options.repoId);
    clauses.push(`repo_id = ?${params.length}`);
  }
  if (options.kind !== undefined) {
    params.push(options.kind);
    clauses.push(`kind = ?${params.length}`);
  }
  if (options.afterId !== undefined) {
    params.push(options.afterId);
    clauses.push(afterEvent(params.length));
  }
  if (options.beforeId !== undefined) {
    params.push(options.beforeId);
    clauses.push(beforeEvent(params.length));
  }
  params.push(options.limit ?? 100);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = params.length;
  let sql = `SELECT * FROM event ${where} ORDER BY event.seq DESC LIMIT ?${limit}`;
  if (options.kinds !== undefined) {
    const marks = options.kinds.map((kind) => {
      params.push(kind);
      return `?${params.length}`;
    });
    sql = `SELECT * FROM (${sql}) WHERE kind IN (${marks.join(", ")}) ORDER BY seq DESC`;
  }
  return db
    .query<EventRow, (string | number)[]>(sql)
    .all(...params)
    .map(toEvent);
}
