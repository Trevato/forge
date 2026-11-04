/**
 * A display: a page of demos, defined by `display.json` at a repository's
 * root and read from its default branch, so git is the record. A display
 * adds no primitive: it is a view over pins (`git/builds.ts`). `builds`,
 * when present, is the display's chosen builds in their order, showcased
 * or not; when absent, the display holds every showcased pin in `sources`,
 * in `order`. `sources` stays the pool the page lists either way.
 *
 * ```json
 * {
 *   "title": "Arcade",
 *   "layout": "shelf",
 *   "sources": ["jmoran", "common-arcade/kart-live"],
 *   "order": ["common-arcade/kart-live:fiesta-1.0"],
 *   "builds": ["common-arcade/kart-live:fiesta-1.0", "jmoran/nova-moves:iter-5-brawl"],
 *   "demos": { "jmoran/nova-moves:iter-5-brawl": { "launch": "file" } },
 *   "shelf": { "producer": "jbox" }
 * }
 * ```
 *
 * Parsing fails closed: an unknown key, a wrong type or a bad value is an
 * error naming what is wrong, and the display page shows that error rather
 * than a guess.
 */

import type { App } from "../app.ts";
import type { Repo } from "../core/repos.ts";
import { exactRefOid } from "../git/branches.ts";
import { isLaunch, isPinLabel, type Launch } from "../git/builds.ts";
import { readFileAt } from "../apps/checkout.ts";
import { repoDir } from "../git/repos.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export const DISPLAY_FILE = "display.json";

export const LAYOUTS = ["shelf", "grid", "graph"] as const;
export type Layout = (typeof LAYOUTS)[number];

/** Where a display's demos come from: every repository an owner has, or one repository. */
export type DisplaySource =
  | { readonly kind: "owner"; readonly owner: string }
  | { readonly kind: "repo"; readonly owner: string; readonly name: string };

export interface DisplayConfig {
  readonly title: string;
  readonly layout: Layout;
  readonly sources: readonly DisplaySource[];
  /** Demo keys, `owner/name:label`, placed first in this order. */
  readonly order: readonly string[];
  /** The display's chosen builds, `owner/name:label`, in order; undefined when the file names none. */
  readonly builds?: readonly string[] | undefined;
  /** Per-demo overrides, by key. */
  readonly demos: ReadonlyMap<string, { readonly launch?: Launch }>;
  /** The `shelf` layout's options. */
  readonly shelf: { readonly producer?: string };
}

/** The most sources, ordered keys and overrides one file may name. */
export const SOURCES_MAX = 50;
export const ORDER_MAX = 500;
/** The largest `display.json` read. */
export const DISPLAY_FILE_MAX = 64 * 1024;

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** A demo's key: `owner/name:label`. */
export const demoKey = (owner: string, name: string, label: string): string => `${owner}/${name}:${label}`;

/** Whether `key` is `owner/name:label`. */
export function isDemoKey(key: string): boolean {
  const at = key.lastIndexOf(":");
  if (at === -1) return false;
  const [owner, name, extra] = key.slice(0, at).split("/");
  return owner !== undefined && name !== undefined && extra === undefined && NAME.test(owner) && NAME.test(name) && isPinLabel(key.slice(at + 1));
}

const isLine = (s: unknown, max: number): s is string =>
  typeof s === "string" && s.length > 0 && s.length <= max && !/[\x00-\x1f\x7f<>]/.test(s) && s.trim() === s;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const TOP_KEYS = new Set(["title", "layout", "sources", "order", "builds", "demos", ...LAYOUTS]);

/** `display.json`'s text, checked. Every error starts with the file's name. */
export function parseDisplay(text: string): Result<DisplayConfig, string> {
  const bad = (why: string) => err(`${DISPLAY_FILE}: ${why}`);
  if (text.length > DISPLAY_FILE_MAX) return bad(`larger than ${DISPLAY_FILE_MAX / 1024} KB`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return bad(`not valid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!isObject(raw)) return bad("must be a JSON object");
  for (const key of Object.keys(raw)) if (!TOP_KEYS.has(key)) return bad(`unknown key "${key.slice(0, 40)}"`);
  if (!isLine(raw.title, 80)) return bad("title is required: one line, at most 80 characters");
  if (typeof raw.layout !== "string" || !(LAYOUTS as readonly string[]).includes(raw.layout))
    return bad("layout must be shelf, grid or graph");
  const layout = raw.layout as Layout;

  if (!Array.isArray(raw.sources) || raw.sources.length === 0) return bad("sources must be a list of owners or owner/name repositories");
  if (raw.sources.length > SOURCES_MAX) return bad(`sources names at most ${SOURCES_MAX} entries`);
  const sources: DisplaySource[] = [];
  for (const s of raw.sources) {
    const parts = typeof s === "string" ? s.split("/") : [];
    if (parts.length === 1 && NAME.test(parts[0]!)) sources.push({ kind: "owner", owner: parts[0]! });
    else if (parts.length === 2 && NAME.test(parts[0]!) && NAME.test(parts[1]!))
      sources.push({ kind: "repo", owner: parts[0]!, name: parts[1]! });
    else return bad(`source ${JSON.stringify(s).slice(0, 60)} is not an owner or owner/name`);
  }

  const order: string[] = [];
  if (raw.order !== undefined) {
    if (!Array.isArray(raw.order)) return bad("order must be a list of owner/name:label");
    if (raw.order.length > ORDER_MAX) return bad(`order names at most ${ORDER_MAX} demos`);
    for (const k of raw.order) {
      if (typeof k !== "string" || !isDemoKey(k)) return bad(`order entry ${JSON.stringify(k).slice(0, 60)} is not owner/name:label`);
      if (!order.includes(k)) order.push(k);
    }
  }

  const builds = parseBuilds(raw.builds);
  if (!builds.ok) return bad(builds.error);

  const demos = new Map<string, { launch?: Launch }>();
  if (raw.demos !== undefined) {
    if (!isObject(raw.demos)) return bad("demos must be an object keyed by owner/name:label");
    const keys = Object.keys(raw.demos);
    if (keys.length > ORDER_MAX) return bad(`demos names at most ${ORDER_MAX} demos`);
    for (const k of keys) {
      if (!isDemoKey(k)) return bad(`demos key ${JSON.stringify(k).slice(0, 60)} is not owner/name:label`);
      const v = raw.demos[k];
      if (!isObject(v)) return bad(`demos ${k} must be an object`);
      for (const f of Object.keys(v)) if (f !== "launch") return bad(`demos ${k}: unknown key "${f.slice(0, 40)}"`);
      if (v.launch !== undefined && !isLaunch(v.launch)) return bad(`demos ${k}: launch must be file, env or shots`);
      demos.set(k, isLaunch(v.launch) ? { launch: v.launch } : {});
    }
  }

  let shelf: { producer?: string } = {};
  for (const name of LAYOUTS) {
    const options = raw[name];
    if (options === undefined) continue;
    if (!isObject(options)) return bad(`${name} must be an object of the ${name} layout's options`);
    for (const f of Object.keys(options))
      if (!(name === "shelf" && f === "producer")) return bad(`${name}: unknown option "${f.slice(0, 40)}"`);
    if (name === "shelf" && options.producer !== undefined) {
      if (!isLine(options.producer, 40)) return bad("shelf.producer must be one line, at most 40 characters");
      shelf = { producer: options.producer };
    }
  }
  return ok({ title: raw.title, layout, sources, order, ...(builds.value === undefined ? {} : { builds: builds.value }), demos, shelf });
}

/**
 * `builds`, checked: absent, or a list of distinct `owner/name:label`, at
 * most `ORDER_MAX`. A repeated key is an error, not a quiet merge: the list
 * is an order a person chose.
 */
export function parseBuilds(raw: unknown): Result<readonly string[] | undefined, string> {
  if (raw === undefined) return ok(undefined);
  if (!Array.isArray(raw)) return err("builds must be a list of owner/name:label");
  if (raw.length > ORDER_MAX) return err(`builds names at most ${ORDER_MAX} builds`);
  const out: string[] = [];
  for (const k of raw) {
    if (typeof k !== "string" || !isDemoKey(k)) return err(`builds entry ${JSON.stringify(k).slice(0, 60)} is not owner/name:label`);
    if (out.includes(k)) return err(`builds names ${k} twice`);
    out.push(k);
  }
  return ok(out);
}

/**
 * A repository's display, read from the tip of its default branch:
 * undefined when it has no `display.json`, an error when the file is bad.
 */
export async function readDisplay(app: App, repo: Repo): Promise<Result<DisplayConfig, string> | undefined> {
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const tip = await exactRefOid(dir, `refs/heads/${repo.defaultBranch}`);
  if (tip === undefined) return undefined;
  const text = await readFileAt(dir, tip, DISPLAY_FILE);
  if (text === undefined) return undefined;
  return parseDisplay(text);
}

/**
 * Whether a repository has a display, as last read: a repository header
 * asks on every page and must not wait on git, so the answer is read in
 * the background and kept a short while (`hasDisplay`).
 */
const KNOWN_TTL_MS = 15_000;
const KNOWN_MAX = 2000;
const known = new Map<string, { has: boolean; at: number }>();

function remember(repo: Repo, has: boolean): void {
  known.delete(repo.id);
  known.set(repo.id, { has, at: Date.now() });
  if (known.size > KNOWN_MAX) known.delete(known.keys().next().value!);
}

/** Read whether `repo` has a display now, and remember it. */
export async function checkDisplay(app: App, repo: Repo): Promise<boolean> {
  const has = (await readDisplay(app, repo)) !== undefined;
  remember(repo, has);
  return has;
}

/** Whether `repo` had a display when last read; a stale answer is read again in the background. */
export function hasDisplay(app: App, repo: Repo): boolean {
  const seen = known.get(repo.id);
  if (seen === undefined || Date.now() - seen.at > KNOWN_TTL_MS) {
    // Held as known until the read answers, so one page does not start many.
    remember(repo, seen?.has ?? false);
    void checkDisplay(app, repo).catch(() => undefined);
  }
  return seen?.has ?? false;
}
