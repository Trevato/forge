/**
 * The flow keeper (#7556): what the steward's unstick, lull-watch and alarm scripts did by hand.
 * Once a minute it reads the open pulls and acts: re-assigns conflicted approved pulls to a
 * builder who can push, lifts holds whose reason is gone, reports pulls closed or handed to a
 * person, samples for lulls and for the forge being down, and answers each flow alarm with what it
 * did. A person's hold is never touched. Each part is a module under `../keeper/`.
 */

import type { Database } from "bun:sqlite";
import { firedAlarms } from "../../flow/alarms.ts";
import { conflictedPulls } from "../../flow/conflicted.ts";
import type { Duty, Finding } from "../duty.ts";
import { sampleHealth, vantagesFromEnv, type Vantage } from "../keeper/down.ts";
import { liftStale } from "../keeper/holds.ts";
import { reportHanded } from "../keeper/handed.ts";
import { readBuilders, readChecks, sample, type Reading } from "../keeper/lull.ts";
import { nameOf, openPulls } from "../keeper/pulls.ts";
import { rebasePass } from "../keeper/rebase.ts";
import { probe } from "../keeper/record.ts";
import { stuckPulls } from "../keeper/stuck.ts";
import { sentence } from "../keeper/words.ts";

export interface Deps {
  /** `owner/name#N` of each pull main has moved out from under; default: the conflicted readings the crew keeps. */
  readonly conflicted?: (db: Database) => ReadonlySet<string>;
  readonly vantages?: () => readonly Vantage[];
  /** The builders' reading; default asks the running forge. */
  readonly builders?: (now: Date) => Reading | undefined;
}

const fromRuns = (db: Database): ReadonlySet<string> => new Set(conflictedPulls(db).map((p) => `${p.repo}#${p.number}`));

export function flowKeeper(deps: Deps = {}): Duty {
  return {
    name: "flow-keeper",
    intervalMs: 60_000,
    async run({ db, now, app }) {
      const findings: Finding[] = [];
      const actions: string[] = [];
      const at = now.toISOString();
      const pulls = openPulls(db);
      const conflicted = (deps.conflicted ?? fromRuns)(db);

      const stuck = stuckPulls(db, now, pulls, conflicted);
      for (const s of stuck) {
        findings.push({
          summary: `${nameOf(s.pull)} is approved and stuck: ${s.why}, quiet for ${Math.round(s.quietMs / 60_000)} min`,
          probe: probe("minutes since the pull's last run, review or push", Math.round(s.quietMs / 60_000), now),
        });
      }

      const moves = rebasePass(db, pulls, conflicted);
      for (const m of moves.reassigned) actions.push(`re-assigned ${m}`);
      for (const m of moves.stopped) actions.push(`stopped re-assigning ${m}: the head did not move; said on the pull`);
      if (moves.waiting.length > 0) {
        findings.push({
          summary: `${moves.waiting.length} conflicted ${moves.waiting.length === 1 ? "pull waits" : "pulls wait"} for the next run (cap per run)`,
          probe: probe("conflicted approved pulls past the per-run cap", moves.waiting.length, now),
        });
      }

      const lifted = liftStale(db, now, pulls);
      for (const line of lifted) actions.push(line);
      for (const line of reportHanded(db, now)) actions.push(line);

      const readings: Reading[] = [];
      const builders = deps.builders ? deps.builders(now) : app ? readBuilders(app, now) : undefined;
      if (builders) readings.push(builders);
      readings.push(readChecks(db, pulls));
      for (const r of readings) {
        const line = sample(db, r);
        if (line !== undefined) {
          actions.push(line);
          findings.push({ summary: line, probe: probe(`${r.kind} waiting while idle`, r.waiting, now) });
        }
      }

      const down = await sampleHealth(db, (deps.vantages ?? vantagesFromEnv)());
      if (down !== undefined) {
        actions.push(down);
        findings.push({ summary: down, probe: probe("health vantages failing twice", 2, now) });
      }

      // Each alarm gets a response: what the keeper did about it, or that it only reports.
      let fired: ReturnType<typeof firedAlarms> = [];
      try {
        fired = firedAlarms(db, now, { dataDir: null });
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        findings.push({ summary: `alarms unreadable: ${why}`, probe: probe("flow alarms that could not be read", 1, now) });
      }
      for (const a of fired) {
        const did = sentence(a.key, { stuck: stuck.length, reassigned: moves.reassigned.length, lifted: lifted.length, down: down !== undefined });
        findings.push({ summary: `alarm ${a.key}: ${a.says}`, probe: { kind: "measurement", what: `alarm ${a.key} firing since ${a.since}`, number: 1, at } });
        actions.push(`alarm ${a.key}: ${did}`);
      }
      return { findings, actions };
    },
  };
}

export const duty: Duty = flowKeeper();
