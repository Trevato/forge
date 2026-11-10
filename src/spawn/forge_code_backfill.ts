/**
 * The one-shot backfill of #10989: the children that exist the first time
 * this runs, and were born before every child came with its own source, get
 * `<org>/forge` too. The run is recorded in `forge-code-backfill.json` under
 * the parent's data directory: the children it covers, and what became of
 * each. A later boot reads that one file and, once every child is settled,
 * opens nothing. Children born afterwards are never in it (they are made
 * with their source).
 *
 * Opening a child's database writes (migrations, WAL), so a child that is
 * awake, open here or running in a cell, is not touched: it stays unsettled
 * and is tried on the next boot. A child whose `parent.json` already records
 * its source is settled without opening its database.
 */

import { rename } from "node:fs/promises";
import { join } from "node:path";
import type { App } from "../app.ts";
import { createApp } from "../app.ts";
import { childDirOf, listChildren } from "../actions/spawn.ts";
import { backfillForgeCode, type Backfilled } from "./forge_code.ts";
import { childAwake } from "./host.ts";

export type Outcome = Backfilled | { error: string };
interface Record_ {
  readonly considered: string[];
  readonly done: Record<string, Outcome>;
}

const recordPath = (app: App): string => join(app.config.dataDir, "forge-code-backfill.json");

async function readRecord(app: App): Promise<Record_ | undefined> {
  try {
    const doc = (await Bun.file(recordPath(app)).json()) as Partial<Record_>;
    if (!Array.isArray(doc.considered) || typeof doc.done !== "object" || doc.done === null) return undefined;
    return { considered: doc.considered.filter((n) => typeof n === "string"), done: doc.done };
  } catch {
    return undefined;
  }
}

async function writeRecord(app: App, rec: Record_): Promise<void> {
  const tmp = `${recordPath(app)}.tmp`;
  await Bun.write(tmp, JSON.stringify(rec));
  await rename(tmp, recordPath(app));
}

const settled = (o: Outcome | undefined): boolean => o !== undefined && typeof o === "string";

async function recordsSource(dir: string): Promise<boolean> {
  try {
    const doc = (await Bun.file(join(dir, "parent.json")).json()) as Record<string, unknown>;
    return doc["forgeCode"] !== undefined && doc["forgeCode"] !== null;
  } catch {
    return false;
  }
}

/** Returns what happened to the children it tried this boot. */
export async function backfillChildren(app: App): Promise<Record<string, Outcome>> {
  const children = (await listChildren(app)).filter((c) => c.done);
  let rec = await readRecord(app);
  if (rec === undefined) {
    rec = { considered: children.map((c) => c.name), done: {} };
    await writeRecord(app, rec);
  }
  const tried: Record<string, Outcome> = {};
  for (const c of children) {
    if (!rec.considered.includes(c.name) || settled(rec.done[c.name])) continue;
    const dir = childDirOf(app, c.bodyId);
    if (await recordsSource(dir)) {
      rec.done[c.name] = "already";
      continue;
    }
    if (childAwake(app, c.name)) continue;
    let child: App | undefined;
    try {
      child = createApp({ dataDir: dir });
      const r = await backfillForgeCode(app, child, dir);
      tried[c.name] = rec.done[c.name] = r.ok ? r.value : { error: r.error };
    } catch (e) {
      tried[c.name] = rec.done[c.name] = { error: String(e) };
    } finally {
      child?.close();
    }
  }
  await writeRecord(app, rec);
  return tried;
}
