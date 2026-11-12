/**
 * Forge down (#7556): the health check fails twice in a row from two vantage points. One bad
 * vantage is a bad network, not an outage. The keeper writes an event and does nothing else; the
 * release keeper owns rollback.
 */

import type { Database } from "bun:sqlite";
import { note } from "./record.ts";

export interface Vantage {
  readonly name: string;
  /** True when the forge answered health from here. Never throws. */
  readonly ok: () => Promise<boolean>;
}

/** Failures in a row, per vantage, per database. */
const fails = new WeakMap<Database, Map<string, number>>();

/** Vantages from `FORGE_HEALTH_VANTAGES`: `name=https://url,name=https://url`. Fewer than two means none can confirm. */
export function vantagesFromEnv(env: string | undefined = process.env.FORGE_HEALTH_VANTAGES): Vantage[] {
  const out: Vantage[] = [];
  for (const part of (env ?? "").split(",")) {
    const [name, url] = part.trim().split(/=(.*)/s);
    if (!name || !url || !/^https?:\/\//.test(url)) continue;
    out.push({
      name,
      ok: async () => {
        try {
          return (await fetch(url, { signal: AbortSignal.timeout(5_000), redirect: "manual" })).ok;
        } catch {
          return false;
        }
      },
    });
  }
  return out.length >= 2 ? out : [];
}

function downNow(db: Database): boolean {
  const last = db
    .query<{ kind: string }, []>("SELECT kind FROM event WHERE kind IN ('forge_down','forge_up') ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .get();
  return last?.kind === "forge_down";
}

/** One sampling: every vantage asked at once; the line to report when an event was written. */
export async function sampleHealth(db: Database, vantages: readonly Vantage[]): Promise<string | undefined> {
  if (vantages.length < 2) return undefined;
  let mine = fails.get(db);
  if (mine === undefined) fails.set(db, (mine = new Map()));
  const answers = await Promise.all(vantages.map(async (v) => [v.name, await v.ok().catch(() => false)] as const));
  for (const [name, ok] of answers) mine.set(name, ok ? 0 : (mine.get(name) ?? 0) + 1);
  const failing = vantages.filter((v) => (mine.get(v.name) ?? 0) >= 2).map((v) => v.name);
  const down = downNow(db);
  if (failing.length >= 2 && !down) {
    note(db, "forge_down", undefined, { vantages: failing });
    return `forge down: health failed twice from ${failing.join(" and ")}; alarm only`;
  }
  if (down && answers.every(([, ok]) => ok)) {
    note(db, "forge_up", undefined, {});
    return "forge answers health again from every vantage";
  }
  return undefined;
}
