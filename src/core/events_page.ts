import type { Database } from "bun:sqlite";
import { audienceFilter, eventForReader } from "./event_audience.ts";
import { VIA_WORDS } from "./acting_via.ts";
import { listEvents, type ForgeEvent } from "./events.ts";
import { getUsersByIds } from "./users.ts";

export const EVENTS_LIMIT_DEFAULT = 50;
export const EVENTS_LIMIT_MAX = 200;

/** Read a `limit` as the API and MCP both take it: a whole number, 1 to 200, or undefined. */
export function eventsLimit(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return EVENTS_LIMIT_DEFAULT;
  const n = typeof raw === "string" ? (/^\d{1,4}$/.test(raw) ? Number(raw) : 0) : Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= EVENTS_LIMIT_MAX ? n : undefined;
}

/** A cursor is the id of the last event of the page before. */
export const validEventsCursor = (raw: string): boolean => /^[A-Za-z0-9_-]{1,64}$/.test(raw);

/** A `kind` filter names one event kind, like `repo.settings_updated`. */
export const validEventsKind = (raw: string): boolean => /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){0,3}$/.test(raw) && raw.length <= 64;

/** Rows read per batch, and batches per request: one request reads at most 1,000 events. */
const BATCH = 200;
const BATCHES = 5;

/**
 * A repository's events as this reader is meant to see them, newest first,
 * one bounded page. The audience filter runs before the page is cut, so a
 * hidden event never shifts a page. The read is bounded too: when most of
 * the outbox is hidden from this reader, a page may come back short, with
 * a `next_cursor` that resumes after the last row scanned. `kind`, when
 * given, keeps only events of that kind, in SQL, before either cut.
 */
export function eventsPage(
  db: Database,
  repoId: string,
  viewer: Parameters<typeof audienceFilter>[1],
  limit: number,
  cursor?: string,
  kind?: string,
) {
  const toReader = eventForReader(db, viewer);
  const found: ReturnType<typeof listEvents> = [];
  let before = cursor;
  let scanned: string | undefined;
  let more = false;
  for (let n = 0; n < BATCHES && found.length <= limit; n++) {
    const batch = listEvents(db, {
      repoId,
      limit: BATCH,
      ...(before === undefined ? {} : { beforeId: before }),
      ...(kind === undefined ? {} : { kind }),
    });
    const visible = audienceFilter(db, viewer, batch);
    for (const event of batch) if (visible(event)) found.push(event);
    if (batch.length > 0) scanned = batch[batch.length - 1]!.id;
    more = batch.length === BATCH;
    if (!more) break;
    before = scanned;
  }
  const page = found.slice(0, limit);
  const next =
    found.length > limit ? page[page.length - 1]!.id : more && scanned !== undefined ? scanned : null;
  // An event made through the agent names who and how: "trevato via the forge's agent".
  const people = getUsersByIds(
    db,
    page.filter((e) => e.via !== undefined && e.actorId !== null).map((e) => e.actorId!),
  );
  const said = (event: ForgeEvent): ForgeEvent & { by?: string } => {
    const person = event.via === undefined || event.actorId === null ? undefined : people.get(event.actorId);
    return person === undefined ? event : { ...event, by: `${person.username} ${VIA_WORDS}` };
  };
  return { items: page.map(toReader).map(said), next_cursor: next };
}
