/**
 * The counters this process keeps once for every App in it, as one App may
 * read them (#10517). The egress table and totals and the cell watch are
 * per process, not per App, and their labels name the parent's and every
 * hosted child's repositories and apps, private ones too. A hosted child's
 * admin is its owner, not this machine's, so a hosted child reads none of
 * them: its `/metrics`, capacity page and terminal egress screen show
 * nothing rather than its parent's and siblings' rows. The parent reads
 * them whole, as before.
 *
 * Every reader takes the counters to read, the live ones by default, so a
 * test can hand it rows without a proxy socket or a watched process.
 */

import type { App } from "../app.ts";
import { cellCounters, type CellCounter } from "../apps/contain.ts";
import {
  egressSnapshot,
  egressTotals,
  npmBytesLastHour,
  npmTopRepoLastHour,
  type EgressRow,
  type EgressTotal,
  type NpmTopRepo,
} from "../apps/egress.ts";
import { isHostedChild } from "./hosted-mark.ts";

/** Where the process-wide counters are read from. */
export interface ProcessCounters {
  readonly egressRows: () => EgressRow[];
  readonly egressTotals: (now: number) => EgressTotal[];
  readonly npmBytes: (now: number) => number;
  readonly npmTopRepo: (now: number) => NpmTopRepo | undefined;
  readonly cells: () => CellCounter[];
}

export const liveCounters: ProcessCounters = {
  egressRows: egressSnapshot,
  egressTotals,
  npmBytes: npmBytesLastHour,
  npmTopRepo: npmTopRepoLastHour,
  cells: cellCounters,
};

export const egressRowsFor = (app: App, read: ProcessCounters = liveCounters): EgressRow[] =>
  isHostedChild(app) ? [] : read.egressRows();

export const egressTotalsFor = (app: App, now = Date.now(), read: ProcessCounters = liveCounters): EgressTotal[] =>
  isHostedChild(app) ? [] : read.egressTotals(now);

export const npmBytesFor = (app: App, now = Date.now(), read: ProcessCounters = liveCounters): number =>
  isHostedChild(app) ? 0 : read.npmBytes(now);

export const npmTopRepoFor = (
  app: App,
  now = Date.now(),
  read: ProcessCounters = liveCounters,
): NpmTopRepo | undefined => (isHostedChild(app) ? undefined : read.npmTopRepo(now));

export const cellCountersFor = (app: App, read: ProcessCounters = liveCounters): CellCounter[] =>
  isHostedChild(app) ? [] : read.cells();
