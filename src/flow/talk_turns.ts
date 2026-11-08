/** How /talk's turns ended (#8860): a stop is a choice, so it is counted apart from failures. */

import type { Database } from "bun:sqlite";

export interface TalkTurns {
  readonly ok: number;
  readonly failed: number;
  readonly stopped: number;
  /** Failed over answered plus failed; stopped turns are in neither. 0 with none. */
  readonly failureRate: number;
}

export function readTalkTurns(db: Database): TalkTurns {
  const row = db
    .query<{ ok: number | null; failed: number | null; stopped: number | null }, []>(
      `SELECT SUM(state = 'ok') AS ok, SUM(state = 'failed') AS failed, SUM(state = 'stopped') AS stopped
         FROM conversation_run`,
    )
    .get();
  const ok = row?.ok ?? 0;
  const failed = row?.failed ?? 0;
  return { ok, failed, stopped: row?.stopped ?? 0, failureRate: ok + failed === 0 ? 0 : failed / (ok + failed) };
}

/** `Talk: 2 turns failed, 1 stopped by the person`; empty when none failed or was stopped. */
export function talkTurnsWords(t: TalkTurns): string {
  if (t.failed + t.stopped === 0) return "";
  return `Talk: ${t.failed} ${t.failed === 1 ? "turn" : "turns"} failed, ${t.stopped} stopped by the person`;
}
