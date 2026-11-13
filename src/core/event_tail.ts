/**
 * The outbox, followed. With the engine on a thread of its own (`engine/`),
 * what one thread appends the other learns by reading the next rows of
 * `event` past the last `seq` it handed on: the outbox is the one bus, and
 * `seq` the one order (migration 69: one writer at a time, so strictly
 * increasing, no gap a reader can see, nothing before the commit).
 *
 * A step costs `PRAGMA data_version` (about a microsecond; it moves only when
 * another connection commits) and, when it moved or this bus appended
 * something, one indexed read. `poke` is the wake: the other thread says it
 * appended, and the step runs now; the timer is the backstop for a wake that
 * was lost, as the outbox's contract always said (`core/events.ts`).
 *
 * The tail starts at the head: what happened before it is the reader's to
 * replay (`Last-Event-ID`), never the tail's.
 */

import type { Database } from "bun:sqlite";
import { headSeq, listEventsAfterSeq, type EventBus } from "./events.ts";
import { during } from "../perf/jobs.ts";

export interface EventTail {
  /** The `seq` last handed to the listeners. */
  seq(): number;
  /** Step now, if anything may have changed. */
  poke(): void;
  /** Hand over everything committed so far, synchronously (a stream about to subscribe). */
  catchUp(): void;
  stop(): void;
}

/** The backstop interval: a lost wake costs at most this. */
export const TAIL_BACKSTOP_MS = 50;

const BATCH = 500;

export function tailEvents(
  db: Database,
  bus: EventBus,
  everyMs = TAIL_BACKSTOP_MS,
): EventTail {
  let cursor = headSeq(db);
  let seen = dataVersion(db);
  let stopped = false;
  let queued = false;
  bus.split = true;
  const step = (): void => {
    queued = false;
    // An open transaction would show its own uncommitted rows: the timer comes back to it.
    if (stopped || db.inTransaction) return;
    const now = dataVersion(db);
    // Own commits do not move `data_version`: the bus says what it appended and has not yet heard back.
    if (now === seen && bus.pendingOwn === 0) return;
    seen = now;
    for (;;) {
      const rows = listEventsAfterSeq(db, cursor, BATCH);
      for (const event of rows) {
        cursor = event.seq ?? cursor;
        bus.deliver(event);
      }
      if (rows.length < BATCH) break;
    }
    // Read to the head: an id the bus still waits for was rolled back.
    bus.forgetPendingOwn();
  };
  const poke = (): void => {
    if (queued || stopped) return;
    queued = true;
    // After the transaction that appended has ended: bun:sqlite's are synchronous, so by a microtask it has.
    queueMicrotask(step);
  };
  bus.afterAppend = poke;
  bus.catchUp = step;
  const timer = setInterval(() => during("event-tail", step), everyMs);
  timer.unref?.();
  return {
    seq: () => cursor,
    poke,
    catchUp: step,
    stop: () => {
      stopped = true;
      clearInterval(timer);
      bus.afterAppend = undefined;
      bus.catchUp = undefined;
      bus.split = false;
    },
  };
}

function dataVersion(db: Database): number {
  return (
    db.query<{ data_version: number }, []>("PRAGMA data_version").get()
      ?.data_version ?? 0
  );
}
