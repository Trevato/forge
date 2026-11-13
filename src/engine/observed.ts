/**
 * What one thread has seen that another reads, as rows. The crew's pump and
 * its autonomy tick keep observations in memory (what the pulls touch, the
 * files warming, the pulls waiting to finish, the last pass's holds, what the
 * stale-ask sweep found), and the keeper, the clog watch and the asks ledger
 * read them. They are copies of memory, not the truth: the thread that makes
 * them publishes them whole, a changed one at a time, to `engine_observation`,
 * and a thread that reads without making them adopts the rows before it reads.
 * Never called on a forge of one thread.
 */

import type { Database } from "bun:sqlite";
import { adoptStanding, adoptStandingWide, adoptTouched, observedStanding, observedStandingWide, observedTouched } from "../crew/hot_files.ts";
import { adoptHeat, observedHeat } from "../crew/hot_history.ts";
import { adoptKnown, observedKnown } from "../crew/stale_asks.ts";
import { adoptWaiting, observedWaiting } from "../flow/conflicted.ts";
import { adoptPass, observedPass } from "../runs/held.ts";
import { quietly } from "../core/write_clock.ts";

interface Kind {
  readonly kind: string;
  /** Scope -> plain data, as this thread holds it now. */
  read(db: Database): Map<string, unknown>;
  /** Take a scope's data in; `undefined` means it is gone. */
  adopt(db: Database, scope: string, value: unknown): void;
}

const KINDS: readonly Kind[] = [
  { kind: "touched", read: () => observedTouched(), adopt: (_, s, v) => adoptTouched(s, v) },
  { kind: "standing_wide", read: () => observedStandingWide(), adopt: (_, s, v) => adoptStandingWide(s, v) },
  { kind: "standing", read: () => observedStanding(), adopt: (_, s, v) => adoptStanding(s, v) },
  { kind: "heat", read: () => observedHeat(), adopt: (_, s, v) => adoptHeat(s, v) },
  { kind: "waiting", read: (db) => observedWaiting(db), adopt: (db, s, v) => adoptWaiting(db, s, v) },
  { kind: "held", read: (db) => observedPass(db), adopt: (db, _, v) => adoptPass(db, v) },
  { kind: "known", read: (db) => observedKnown(db), adopt: (db, _, v) => adoptKnown(db, v) },
];

/** The body last written (by this thread) or adopted (by it), per kind and scope: what a pass skips. */
const last = new WeakMap<Database, Map<string, string>>();
const lastOf = (db: Database): Map<string, string> => {
  let m = last.get(db);
  if (m === undefined) last.set(db, (m = new Map()));
  return m;
};

/** Write what changed since the last call, and remove what is gone. How many rows moved. */
export function publishObserved(db: Database, now = Date.now()): number {
  const seen = lastOf(db);
  const writes: [string, string, string][] = [];
  const gone: [string, string][] = [];
  for (const k of KINDS) {
    const current = k.read(db);
    for (const [scope, value] of current) {
      const body = JSON.stringify(value);
      if (seen.get(`${k.kind}\0${scope}`) !== body) writes.push([k.kind, scope, body]);
    }
    for (const key of seen.keys())
      if (key.startsWith(`${k.kind}\0`) && !current.has(key.slice(k.kind.length + 1))) gone.push([k.kind, key.slice(k.kind.length + 1)]);
  }
  if (writes.length === 0 && gone.length === 0) return 0;
  // Bookkeeping no cached page is built from: left out of this connection's write clock.
  quietly(db, () =>
    db.transaction(() => {
      for (const [kind, scope, body] of writes)
        db.query("INSERT INTO engine_observation (kind, scope, at, body) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (kind, scope) DO UPDATE SET at = ?3, body = ?4").run(kind, scope, now, body);
      for (const [kind, scope] of gone) db.query("DELETE FROM engine_observation WHERE kind = ?1 AND scope = ?2").run(kind, scope);
    }).immediate(),
  );
  for (const [kind, scope, body] of writes) seen.set(`${kind}\0${scope}`, body);
  for (const [kind, scope] of gone) seen.delete(`${kind}\0${scope}`);
  return writes.length + gone.length;
}

/** Take in what another thread published since the last call. How many scopes changed. */
export function adoptObserved(db: Database): number {
  const seen = lastOf(db);
  const rows = db.query<{ kind: string; scope: string; body: string }, []>("SELECT kind, scope, body FROM engine_observation").all();
  const live = new Set<string>();
  let changed = 0;
  for (const row of rows) {
    const key = `${row.kind}\0${row.scope}`;
    live.add(key);
    if (seen.get(key) === row.body) continue;
    KINDS.find((k) => k.kind === row.kind)?.adopt(db, row.scope, JSON.parse(row.body));
    seen.set(key, row.body);
    changed++;
  }
  for (const key of [...seen.keys()]) {
    if (live.has(key)) continue;
    const at = key.indexOf("\0");
    KINDS.find((k) => k.kind === key.slice(0, at))?.adopt(db, key.slice(at + 1), undefined);
    seen.delete(key);
    changed++;
  }
  return changed;
}
