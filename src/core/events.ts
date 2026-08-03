/**
 * The event outbox — the forge's one queue. Every event is a durable row
 * first; in-process listeners (SSE, webhook delivery) are woken afterwards
 * as an optimization. Consumers must tolerate replays and use the sweep,
 * never the wake-up, as their source of completeness.
 */

import type { Database } from "bun:sqlite";
import { id } from "../kernel/id.ts";
import { createLog } from "../kernel/log.ts";

const log = createLog("events");

export interface ForgeEvent {
  readonly id: string;
  readonly kind: string;
  readonly repoId: string | null;
  readonly actorId: string | null;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
}

export type EventListener = (event: ForgeEvent) => void;

export class EventBus {
  private listeners = new Set<EventListener>();

  constructor(private readonly db: Database) {}

  /** Durable append, then best-effort wake. Returns the stored event. */
  append(input: {
    kind: string;
    repoId?: string | undefined;
    actorId?: string | undefined;
    payload?: Record<string, unknown> | undefined;
  }): ForgeEvent {
    const event: ForgeEvent = {
      id: id(),
      kind: input.kind,
      repoId: input.repoId ?? null,
      actorId: input.actorId ?? null,
      payload: input.payload ?? {},
      createdAt: new Date().toISOString(),
    };
    this.db
      .query(
        "INSERT INTO event (id, kind, repo_id, actor_id, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      )
      .run(
        event.id,
        event.kind,
        event.repoId,
        event.actorId,
        JSON.stringify(event.payload),
        event.createdAt,
      );

    for (const listener of this.listeners) {
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
    return event;
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export interface ListEventsOptions {
  repoId?: string;
  /** Return events with id greater than this (exclusive). */
  afterId?: string;
  /** @default 100 */
  limit?: number;
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
  if (options.afterId !== undefined) {
    params.push(options.afterId);
    clauses.push(`id > ?${params.length}`);
  }
  params.push(options.limit ?? 100);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .query<
      {
        id: string;
        kind: string;
        repo_id: string | null;
        actor_id: string | null;
        payload: string;
        created_at: string;
      },
      (string | number)[]
    >(`SELECT * FROM event ${where} ORDER BY id DESC LIMIT ?${params.length}`)
    .all(...params);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    repoId: r.repo_id,
    actorId: r.actor_id,
    payload: JSON.parse(r.payload) as Record<string, unknown>,
    createdAt: r.created_at,
  }));
}
