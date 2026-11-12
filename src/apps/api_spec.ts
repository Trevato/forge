/**
 * An app's own API description: the `/openapi.json` its production
 * environment serves, read over loopback and remembered for a minute. The
 * header asks `knownSpec` (never waits); `refreshSpec` is the one that reaches
 * the app, and what it gets is data from outside: bounded in size and time,
 * kept only when it is a JSON object with `paths`.
 */

import type { AppRecord } from "../core/apps.ts";

const TTL_MS = 60_000;
const WAIT_MS = 1500;
const MAX_BYTES = 512 * 1024;
const MAX_KEPT = 500;

interface Kept {
  readonly at: number;
  readonly doc: Record<string, unknown> | null;
}

const kept = new Map<string, Kept>();
const asking = new Set<string>();

/** Remember what an app's spec is (null: it serves none). */
export function rememberSpec(appId: string, doc: Record<string, unknown> | null, at = Date.now()): void {
  if (kept.size >= MAX_KEPT && !kept.has(appId)) kept.delete(kept.keys().next().value as string);
  kept.set(appId, { at, doc });
}

/** The spec last read, while it is fresh; undefined when not known (yet). */
export function knownSpec(appId: string, at = Date.now()): Record<string, unknown> | null | undefined {
  const hit = kept.get(appId);
  return hit === undefined || at - hit.at > TTL_MS ? undefined : hit.doc;
}

/** The body, read in chunks and abandoned past the cap, so a huge one is never held whole. */
async function boundedBody(res: Response): Promise<Uint8Array | null> {
  const reader = res.body?.getReader();
  if (reader === undefined) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** GET /openapi.json from the app listening on `port`; null when it serves none. */
export async function readSpec(port: number): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/openapi.json`, {
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(WAIT_MS),
    });
    if (res.status !== 200) return null;
    const bytes = await boundedBody(res);
    if (bytes === null) return null;
    const doc: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const paths = typeof doc === "object" && doc !== null ? (doc as Record<string, unknown>)["paths"] : undefined;
    return typeof paths === "object" && paths !== null && !Array.isArray(paths) ? (doc as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Read the spec now and remember it; one read per app at a time. */
export async function refreshSpec(record: AppRecord, port: number | undefined): Promise<Record<string, unknown> | null> {
  if (port === undefined) return null;
  if (asking.has(record.id)) return knownSpec(record.id) ?? null;
  asking.add(record.id);
  try {
    const doc = await readSpec(port);
    rememberSpec(record.id, doc);
    return doc;
  } finally {
    asking.delete(record.id);
  }
}

/** Ask in the background when nothing fresh is known, so the next page has the answer. */
export function warmSpec(record: AppRecord, port: number | undefined): void {
  if (knownSpec(record.id) === undefined) void refreshSpec(record, port);
}
