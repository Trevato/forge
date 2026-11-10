/**
 * "Running" is proven from outside (#7959). A child forge's process being up
 * inside its cell says nothing about whether a visitor reaches it: Starck's
 * pages said "App · running" for days while every public address answered
 * 404. So the parent asks the way a visitor does — its own public address
 * for the child's home and for each app (`<app>--<child>--<parentHost>`) —
 * and keeps what came back, per URL, under `<data>/reach/<child>.json`.
 *
 * A probe asserts the *answer*, not the status: the platform's wildcard
 * standby page answers 200 for a mistyped `<app>--<child>.<apex>`, so a
 * 200 proves nothing. The child's home must answer its own `/api/v1/forge`
 * (a JSON `claimed`), and an app must carry the `x-forge-app: <slug>` the
 * proxy writes on everything it carries back.
 *
 * A child that stays unreachable raises an alarm: `forge.child_unreachable`
 * on the outbox and an `unreachable` flow alarm the notifier pages the
 * owner with (`crew/notify.ts`); `forge.child_reachable` ends it.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { childDirOf, listChildren, type Child } from "../actions/spawn.ts";
import type { App } from "../app.ts";
import { isSlug, slugFor } from "../core/apps.ts";
import type { FiredAlarm } from "../flow/alarms.ts";
import { childPublicUrl, parentOrigin } from "./placement.ts";
import { during } from "../perf/jobs.ts";

export const APP_HEADER = "x-forge-app";

const PROBE_MS = 3000;
/** How often the parent re-proves every child; the schedule is `startReachWatch`. */
export const REACH_EVERY_MS = 5 * 60_000;
/** A new child gets this long to come up before its failure is an alarm. */
export const SETTLE_MS = 3 * 60_000;
const SETTLE_POLL_MS = 3000;
/** A failing sweep is confirmed once more after this, so one dropped request pages nobody. */
const CONFIRM_MS = 5000;
const BATCH = 4;

/** One public address and what came back from it. */
export interface Proof {
  /** `home`, or the app's slug. */
  readonly label: string;
  readonly url: string;
  readonly ok: boolean;
  /** The HTTP status; null when nothing answered. */
  readonly status: number | null;
  /** One sentence: what was asked and what is wrong, or "answered". */
  readonly says: string;
}

export interface ChildReach {
  readonly name: string;
  /** When it was last proved, ISO. */
  readonly at: string;
  readonly ok: boolean;
  /** When it first failed in the run of failures it is in, ISO; null while it is reachable. */
  readonly since: string | null;
  /** Whether the owner has been told it is unreachable; false while a new child is still settling. */
  readonly alarmed: boolean;
  readonly proofs: readonly Proof[];
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface Options {
  /** True where there is no public network to prove through (a test suite); an injected `fetch` still works. */
  readonly off?: boolean;
  readonly fetch?: FetchLike;
  readonly settleMs?: number;
  readonly pollMs?: number;
  readonly confirmMs?: number;
}

const options = new WeakMap<App, Options>();

/** Tests swap how public addresses are asked, and how long a settle waits. */
export function useReach(app: App, o: Options): void {
  options.set(app, o);
}

let fallback: Options = {};

/** What every app without its own `useReach` does; the test preload turns proving off. */
export function useReachByDefault(o: Options): void {
  fallback = o;
}

const optionsOf = (app: App): Options => options.get(app) ?? fallback;
const off = (app: App): boolean => optionsOf(app).fetch === undefined && optionsOf(app).off === true;

export const homeUrlOf = (child: Pick<Child, "url">): string => `${child.url}/api/v1/forge`;

/** An app of a child, at the address a visitor types: `<app>--<child>--<parentHost>`. */
export const appUrlOf = (app: App, child: Pick<Child, "name">, slug: string): string =>
  `${childPublicUrl(`${slug}--${child.name}`, parentOrigin(app.config))}/`;

/**
 * The slugs of a child's public apps: those it was given (the repositories
 * in the ledger, which a child makes apps of on its first boot) and any its
 * own database holds since (it sits in this forge's data directory, read-only).
 */
export function slugsOf(app: App, child: Child): string[] {
  const slugs = new Set(child.apps.map((ref) => slugFor(ref.split("/")[1] ?? ref)));
  try {
    const db = new Database(join(childDirOf(app, child.bodyId), "forge.db"), { readonly: true });
    try {
      // The child's database is the child's to write: a slug that is not the forge's slug rule
      // would steer this fetch to another host (`evil.example#`, `u@host`), so it is dropped.
      for (const r of db.query<{ slug: string }, []>("SELECT slug FROM app WHERE access = 'public'").all()) if (typeof r.slug === "string" && isSlug(r.slug)) slugs.add(r.slug);
    } finally {
      db.close();
    }
  } catch {
    // Not yet a database to read: the ledger's repositories are what is known.
  }
  return [...slugs].sort();
}

async function ask(fetcher: FetchLike, url: string): Promise<{ status: number; headers: Headers; body: string } | string> {
  try {
    const res = await fetcher(url, { redirect: "manual", signal: AbortSignal.timeout(PROBE_MS), headers: { accept: "*/*" } });
    const body = res.headers.get("content-type")?.includes("json") ? await res.text() : (await res.body?.cancel(), "");
    return { status: res.status, headers: res.headers, body: body.slice(0, 4096) };
  } catch (error) {
    return String(error instanceof Error ? error.message : error).slice(0, 120);
  }
}

/** The child's home answers as the forge it is. */
export async function proveHome(fetcher: FetchLike, child: Pick<Child, "url">): Promise<Proof> {
  const url = homeUrlOf(child);
  const got = await ask(fetcher, url);
  if (typeof got === "string") return { label: "home", url, ok: false, status: null, says: `no answer (${got})` };
  let claimed = false;
  try {
    claimed = typeof (JSON.parse(got.body) as { claimed?: unknown }).claimed === "boolean";
  } catch {
    claimed = false;
  }
  if (got.status === 200 && claimed) return { label: "home", url, ok: true, status: 200, says: "answered 200" };
  return { label: "home", url, ok: false, status: got.status, says: `answered ${got.status}, not by the forge` };
}

/** An app answers as itself: not a 5xx, and carrying the proxy's `x-forge-app` for this slug. */
export async function proveApp(fetcher: FetchLike, url: string, slug: string): Promise<Proof> {
  const got = await ask(fetcher, url);
  if (typeof got === "string") return { label: slug, url, ok: false, status: null, says: `no answer (${got})` };
  if (got.headers.get(APP_HEADER) !== slug)
    return { label: slug, url, ok: false, status: got.status, says: `answered ${got.status}, not by the app` };
  if (got.status >= 500) return { label: slug, url, ok: false, status: got.status, says: `the app answered ${got.status}` };
  return { label: slug, url, ok: true, status: got.status, says: `answered ${got.status}` };
}

/** Ask every public address of a child, as a visitor does. Nothing is kept. */
export async function proveChild(app: App, child: Child): Promise<ChildReach> {
  const fetcher = optionsOf(app).fetch ?? fetch;
  const proofs = await Promise.all([
    proveHome(fetcher, child),
    ...slugsOf(app, child).map((slug) => proveApp(fetcher, appUrlOf(app, child, slug), slug)),
  ]);
  return { name: child.name, at: new Date().toISOString(), ok: proofs.every((p) => p.ok), since: null, alarmed: false, proofs };
}

// ---- what was last proved ----

const dirOf = (app: App): string => join(app.config.dataDir, "reach");

/** What was last proved of a child; undefined before it was ever asked. */
export function reachOf(app: App, name: string): ChildReach | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(dirOf(app), `${name}.json`), "utf8")) as ChildReach;
    return Array.isArray(raw.proofs) && typeof raw.ok === "boolean" ? raw : undefined;
  } catch {
    return undefined;
  }
}

function keep(app: App, reach: ChildReach): void {
  try {
    mkdirSync(dirOf(app), { recursive: true });
    const path = join(dirOf(app), `${reach.name}.json`);
    writeFileSync(`${path}.tmp`, JSON.stringify(reach));
    renameSync(`${path}.tmp`, path);
  } catch (error) {
    app.log.error("could not keep the reach", { name: reach.name, error: String(error) });
  }
}

/** The failing proofs in a sentence a person can read, or null when all are fine. */
export function reachWords(reach: ChildReach | null | undefined): string | null {
  if (reach === null || reach === undefined || reach.ok) return null;
  const bad = reach.proofs.filter((p) => !p.ok).map((p) => `${p.label} ${p.says}`);
  return `Running, not reachable: ${bad.join("; ")}`;
}

/**
 * Keep a proof, carrying `since` from the run of failures it continues, and
 * put the change on the outbox: unreachable once when the owner is first
 * told, reachable once when that ends. `alarm` is false while a new child
 * is still settling.
 */
function record(app: App, proved: ChildReach, alarm: boolean): ChildReach {
  const before = reachOf(app, proved.name);
  const since = proved.ok ? null : (before?.ok === false ? before.since : null) ?? proved.at;
  const raise = alarm && !proved.ok && before?.alarmed !== true;
  const end = proved.ok && before?.alarmed === true;
  const reach: ChildReach = { ...proved, since, alarmed: proved.ok ? false : raise || before?.alarmed === true };
  keep(app, reach);
  if (raise) app.bus.append({ kind: "forge.child_unreachable", payload: { name: reach.name, says: reachWords(reach) ?? "", since } });
  else if (end) app.bus.append({ kind: "forge.child_reachable", payload: { name: reach.name } });
  return reach;
}

/**
 * Prove a child once and say what came back. A new child is the caller's
 * to settle (`settleChild`); a failure here is kept without an alarm.
 */
export async function firstProof(app: App, name: string): Promise<ChildReach | undefined> {
  if (off(app)) return undefined;
  const child = (await listChildren(app)).find((c) => c.name === name);
  if (child === undefined || !child.done) return undefined;
  return record(app, await proveChild(app, child), false);
}

/**
 * Keep proving a new child until all of it answers or `SETTLE_MS` passes;
 * if it never does, that is the alarm. Never throws.
 */
export async function settleChild(app: App, name: string): Promise<void> {
  if (off(app)) return;
  const o = optionsOf(app);
  const until = Date.now() + (o?.settleMs ?? SETTLE_MS);
  try {
    for (;;) {
      const child = (await listChildren(app)).find((c) => c.name === name);
      if (child === undefined || app.closing.signal.aborted) return;
      const proved = await proveChild(app, child);
      const last = Date.now() >= until;
      const reach = record(app, proved, last);
      if (reach.ok || last) return;
      await new Promise<void>((done) => {
        const t = setTimeout(done, o?.pollMs ?? SETTLE_POLL_MS);
        app.closing.signal.addEventListener("abort", () => (clearTimeout(t), done()), { once: true });
      });
    }
  } catch (error) {
    app.log.error("could not settle a new child's reach", { name, error: String(error) });
  }
}

/**
 * One pass over every finished child: prove, confirm a failure once, keep, alarm on a change.
 * A child `asleep` is passed over and keeps its last proof: asking its address wakes it, and
 * a probe every five minutes woke every sleeping child, booting each anew every quarter hour.
 */
export async function sweepReach(app: App, asleep: (name: string) => boolean = () => false): Promise<void> {
  if (off(app)) return;
  const confirmMs = optionsOf(app).confirmMs ?? CONFIRM_MS;
  const children = (await listChildren(app)).filter((c) => c.done && !asleep(c.name));
  for (let i = 0; i < children.length; i += BATCH) {
    await Promise.all(
      children.slice(i, i + BATCH).map(async (child) => {
        try {
          let proved = await proveChild(app, child);
          if (!proved.ok) {
            await Bun.sleep(confirmMs);
            proved = await proveChild(app, child);
          }
          record(app, proved, true);
        } catch (error) {
          app.log.error("could not prove a child's reach", { name: child.name, error: String(error) });
        }
      }),
    );
  }
}

/** Re-prove every child on a schedule, the first pass soon after boot. Returns the timer to clear. */
export function startReachWatch(
  app: App,
  everyMs = REACH_EVERY_MS,
  asleep: (name: string) => boolean = () => false,
): ReturnType<typeof setInterval> {
  const first = setTimeout(() => void during("reach", () => sweepReach(app, asleep)), 30_000);
  const timer = setInterval(() => void during("reach", () => sweepReach(app, asleep)), everyMs);
  app.closing.signal.addEventListener("abort", () => clearTimeout(first), { once: true });
  return timer;
}

/** The children that are unreachable now, as flow alarms the notifier pages the owner with. */
export function reachAlarms(app: App): FiredAlarm[] {
  let files: string[] = [];
  try {
    files = readdirSync(dirOf(app));
  } catch {
    return [];
  }
  const out: FiredAlarm[] = [];
  for (const f of files.filter((f) => f.endsWith(".json")).sort()) {
    const reach = reachOf(app, f.slice(0, -".json".length));
    if (reach === undefined || reach.ok || !reach.alarmed || reach.since === null) continue;
    out.push({ key: "unreachable", says: `${reach.name} is ${reachWords(reach)?.toLowerCase() ?? "not reachable"}`, since: reach.since, href: "/forges" });
  }
  return out;
}
