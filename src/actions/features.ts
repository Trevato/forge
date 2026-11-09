/**
 * Absorb: an app becomes one of the forge's features without a line of
 * its code moving into the forge. It keeps its repository, its cell, its data
 * and its deploys; the forge gives it a place in its nav and keeps its
 * settings, typed by what the app declares in `forge.json` (`apps/feature.ts`).
 *
 * The rules, each held by a test:
 * - Absorbing and un-absorbing are a site admin's acts, and each is an event.
 * - Declaring a `feature` does nothing on its own: a repository cannot
 *   promote itself.
 * - A value is checked against its declaration at the door; a bad one is
 *   refused with the setting named, and nothing is kept.
 * - Un-absorbing keeps the values, so absorbing again is the same feature.
 * - Who may see the feature is who may read the app's repository: absorbing
 *   widens nothing.
 * - The forge never runs the app's code: a change reaches the app as
 *   `FORGE_SETTING_*` in a new process, the same way an env var does.
 */

import { lastFires, type Fired } from "../core/feature_fires.ts";
import type { App } from "../app.ts";
import { readFileAt } from "../apps/checkout.ts";
import { checkSetting, featureEnv, parseFeature, settingEnvName, type FeatureSpec } from "../apps/feature.ts";
import { keptSettings as openSettings, sealSetting } from "../apps/feature_env.ts";
import type { ToolSpec } from "../apps/feature_tools.ts";
import { appsRuntime } from "../apps/runtime.ts";
import { getAppByRepo, getAppById, getAppBySlug, listApps, type AppRecord } from "../core/apps.ts";
import {
  absorb,
  clearFeatureSettings,
  keepDeclaration,
  featureSettings,
  getAbsorbed,
  listAbsorbed,
  setFeatureSettings as keepSettings,
  unabsorb,
} from "../core/features.ts";
import { canRead, getRepo, getRepoById, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { readFeedPage } from "../feed/feed.ts";
import type { FeedItem } from "../feed/rank.ts";
import { resolveOid } from "../git/merge.ts";
import { commitLog } from "../git/read.ts";
import { repoDir } from "../git/repos.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export type FeatureError =
  /** No such app, or one the actor may not see. */
  | "not_found"
  /** Only a site admin absorbs, un-absorbs or changes settings. */
  | "forbidden"
  /** The app's forge.json declares no feature (or declares it wrongly). */
  | "not_a_feature"
  /** The app is not absorbed: its settings are not the forge's to change. */
  | "not_absorbed"
  /** A value that does not fit its declaration; `message` names it. */
  | "invalid_setting"
  /** What the admin reviewed is not what the app declares now: review again. */
  | "declaration_changed";

export interface SettingView {
  readonly key: string;
  readonly type: string;
  readonly label: string;
  readonly help: string | null;
  readonly value: string;
  readonly default: string;
  readonly set: boolean;
  readonly min: number | null;
  readonly max: number | null;
  readonly choices: readonly string[] | null;
  /** What the app's process reads it as. */
  readonly env: string;
}

export interface FeatureView {
  readonly slug: string;
  readonly repo: string;
  readonly name: string;
  readonly summary: string | null;
  readonly page: string;
  /** The name and page the app declares now, when they differ from the absorbed ones: waits for an admin. */
  readonly pending: { readonly name: string; readonly page: string; readonly summary: string | null } | null;
  readonly absorbed: boolean;
  readonly absorbedBy: string | null;
  readonly absorbedAt: string | null;
  /** Why the declaration is not usable, when it is not; `settings` is then empty. */
  readonly problem: string | null;
  readonly settings: readonly SettingView[];
  /** The MCP tools the app declares; the `features` tool calls them while it is absorbed. */
  readonly tools: readonly ToolSpec[];
  /** How the forge's last call of each scheduled tool went; empty when none has fired. */
  readonly fires: readonly Fired[];
  /** Where the app comes from: the upstream only when the reader may read it. */
  readonly provenance: Provenance;
}

/**
 * Who stands behind an app's declaration: its repository, the repository it
 * was forked from, and who last changed forge.json.
 */
export interface Provenance {
  readonly repo: string;
  readonly upstream: string | null;
  readonly changedBy: string | null;
  readonly changedAt: string | null;
}

/** The last change by tip. Bounded on its own, apart from the declarations': cleared whole when full. */
const changed = new Map<string, { by: string; at: string } | null>();
const CHANGED_MAX = 500;

/**
 * The facts a door shows for a provenance, label and value, in the order
 * shown. The repository is not one: the row's title has it.
 */
export function provenanceFacts(p: Provenance): { label: string; value: string }[] {
  const facts: { label: string; value: string }[] = [];
  if (p.upstream !== null) facts.push({ label: "Fork of", value: p.upstream });
  if (p.changedBy !== null) {
    const on = p.changedAt === null ? "" : `, ${p.changedAt.slice(0, 10)}`;
    facts.push({ label: "Last changed by", value: `${p.changedBy}${on}` });
  }
  return facts;
}

/**
 * The latest commit at or under `tip` that touched forge.json: its author and
 * date. A commit never changes, so it is read from git once per tip and kept;
 * `read` is git's log, or a stand-in that counts.
 */
export async function lastChange(
  dir: string,
  tip: string,
  read: typeof commitLog = commitLog,
): Promise<{ by: string; at: string } | null> {
  if (changed.has(tip)) return changed.get(tip) ?? null;
  const log = await read(dir, tip, { limit: 1, path: "forge.json" });
  const c = log.ok ? log.value[0] : undefined;
  const last = c === undefined ? null : { by: c.author, at: c.date };
  if (changed.size >= CHANGED_MAX) changed.clear();
  changed.set(tip, last);
  return last;
}

/**
 * The repository's provenance as the actor may see it: the upstream is named
 * only to one who may read it, so a fork does not leak a private parent's name.
 * The last change is the default branch's latest commit touching forge.json, kept by tip.
 */
async function provenanceOf(app: App, actor: User | undefined, repo: Repo): Promise<Provenance> {
  const found = repo.forkParentId === null ? undefined : getRepoById(app.db, repo.forkParentId);
  const parent = found !== undefined && canRead(app.db, found, actor) ? found : undefined;
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const tip = await resolveOid(dir, `refs/heads/${repo.defaultBranch}`);
  const last = tip === undefined ? null : await lastChange(dir, tip);
  return {
    repo: `${repo.ownerName}/${repo.name}`,
    upstream: parent === undefined ? null : `${parent.ownerName}/${parent.name}`,
    changedBy: last?.by ?? null,
    changedAt: last?.at ?? null,
  };
}

const siteAdmin = (actor: User | undefined): actor is User =>
  actor !== undefined && actor.isAdmin && actor.kind !== "agent";

/**
 * The parsed declaration by commit oid. A commit never changes, so what its
 * forge.json declares never does: only an app whose tip moved reads git again.
 * Bounded by clearing whole when full; a refill costs one read per app.
 */
const declared = new Map<string, Result<FeatureSpec | undefined, string>>();
const DECLARED_MAX = 2000;

/** The feature an app's default branch declares, as `forge.json` says it at the tip. */
export async function declaredFeature(app: App, repo: Repo): Promise<Result<FeatureSpec | undefined, string>> {
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const tip = await resolveOid(dir, `refs/heads/${repo.defaultBranch}`);
  if (tip === undefined) return ok(undefined);
  const known = declared.get(tip);
  if (known !== undefined) return known;
  const read = await readDeclaration(dir, tip);
  if (declared.size >= DECLARED_MAX) declared.clear();
  declared.set(tip, read);
  return read;
}

async function readDeclaration(dir: string, tip: string): Promise<Result<FeatureSpec | undefined, string>> {
  const text = await readFileAt(dir, tip, "forge.json");
  if (text === undefined) return ok(undefined);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return ok(undefined); // a broken forge.json is the deploy's to report, not this
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return ok(undefined);
  return parseFeature(parsed as Record<string, unknown>);
}

/**
 * Whether the link to an app's feature shows on its page: the app is absorbed
 * or its default branch declares a feature, a site admin's only, and read through `declaredFeature`'s cache by
 * commit, so a page view costs a git read only the first time a tip is seen.
 */
export async function declaresFeature(app: App, actor: User | undefined, repo: Repo): Promise<boolean> {
  if (!siteAdmin(actor)) return false;
  const record = getAppByRepo(app.db, repo.id);
  if (record !== undefined && getAbsorbed(app.db, record.id) !== undefined) return true;
  const read = await declaredFeature(app, repo);
  return read.ok && read.value !== undefined;
}

function viewOf(
  record: AppRecord,
  repo: Repo,
  app: App,
  spec: FeatureSpec | undefined,
  problem: string | null,
  provenance: Provenance,
): FeatureView {
  const kept = spec === undefined ? featureSettings(app.db, record.id) : openSettings(app.db, app.config.dataDir, record.id, spec);
  const absorbed = getAbsorbed(app.db, record.id);
  const env = spec === undefined ? {} : featureEnv(spec, kept);
  return {
    slug: record.slug,
    repo: `${repo.ownerName}/${repo.name}`,
    name: absorbed?.name ?? spec?.name ?? record.slug,
    summary: spec?.summary ?? null,
    page: absorbed?.page ?? spec?.page ?? "/",
    pending:
      absorbed !== undefined &&
      spec !== undefined &&
      (spec.name !== absorbed.name || spec.page !== absorbed.page || (spec.summary ?? null) !== absorbed.summary)
        ? { name: spec.name, page: spec.page, summary: spec.summary ?? null }
        : null,
    absorbed: absorbed !== undefined,
    absorbedBy: absorbed?.absorbedBy ?? null,
    absorbedAt: absorbed?.absorbedAt ?? null,
    problem,
    provenance,
    tools: spec?.tools ?? [],
    fires: absorbed === undefined ? [] : lastFires(app.db, record.id),
    settings: (spec?.settings ?? []).map((s) => {
      const name = settingEnvName(s.key);
      return {
        key: s.key,
        type: s.type,
        label: s.label,
        help: s.help ?? null,
        // A secret is never shown again: only whether one is kept.
        value: s.type === "secret" ? "" : (env[name] ?? s.default),
        default: s.default,
        set: kept.has(s.key),
        min: s.min ?? null,
        max: s.max ?? null,
        choices: s.choices ?? null,
        env: name,
      };
    }),
  };
}

/** The app behind a slug, if the actor may read its repository. */
export function readable(app: App, actor: User | undefined, slug: string): { record: AppRecord; repo: Repo } | undefined {
  const record = getAppBySlug(app.db, slug);
  if (record === undefined) return undefined;
  const repo = getRepoById(app.db, record.repoId);
  if (repo === undefined || !canRead(app.db, repo, actor)) return undefined;
  return { record, repo };
}

/**
 * Every app that declares a feature, absorbed or not, for a site admin's
 * settings page. Reads each app's forge.json at its tip: a handful of apps,
 * on an admin page.
 */
export async function listFeatures(app: App, actor: User | undefined): Promise<Result<FeatureView[], FeatureError>> {
  if (!siteAdmin(actor)) return err("not_found");
  const out: FeatureView[] = [];
  for (const record of listApps(app.db)) {
    const repo = getRepoById(app.db, record.repoId);
    if (repo === undefined) continue;
    const declared = await declaredFeature(app, repo);
    if (declared.ok && declared.value === undefined && getAbsorbed(app.db, record.id) === undefined) continue;
    const spec = declared.ok ? declared.value : undefined;
    const provenance = await provenanceOf(app, actor, repo);
    out.push(viewOf(record, repo, app, spec, declared.ok ? null : declared.error, provenance));
  }
  return ok(out.sort((a, b) => Number(b.absorbed) - Number(a.absorbed) || a.name.localeCompare(b.name)));
}

export interface NavFeature {
  readonly appId: string;
  readonly slug: string;
  /** `owner/name`, for a link to the app's own page. */
  readonly repo: string;
  readonly name: string;
  /** The app path to open: the feature's page. */
  readonly page: string;
  /** The declared summary as last kept; the menu entry's title. */
  readonly summary: string | null;
  /** The app record already read, so the menu does not fetch it again. */
  readonly record: AppRecord;
}

/** Absorbed apps the actor may read, for the forge's nav. Cheap enough for every page: no git reads. */
export function absorbedForNav(app: App, actor: User | undefined): NavFeature[] {
  const out: NavFeature[] = [];
  for (const row of listAbsorbed(app.db)) {
    const record = getAppById(app.db, row.appId);
    if (record === undefined) continue;
    const repo = getRepoById(app.db, record.repoId);
    if (repo === undefined || !canRead(app.db, repo, actor)) continue;
    out.push({ appId: record.id, slug: record.slug, repo: `${repo.ownerName}/${repo.name}`, name: row.name, page: row.page, summary: row.summary, record });
  }
  return out;
}

/** One feature, for whoever may read the app; settings changes are a site admin's. */
export async function getFeature(app: App, actor: User | undefined, slug: string): Promise<Result<FeatureView, FeatureError>> {
  const found = readable(app, actor, slug);
  if (found === undefined) return err("not_found");
  const declared = await declaredFeature(app, found.repo);
  if (declared.ok && declared.value === undefined && getAbsorbed(app.db, found.record.id) === undefined)
    return err("not_a_feature");
  const spec = declared.ok ? declared.value : undefined;
  const provenance = await provenanceOf(app, actor, found.repo);
  return ok(viewOf(found.record, found.repo, app, spec, declared.ok ? null : declared.error, provenance));
}

/**
 * An app's own feed items, for a feature `getFeature` already returned (so
 * its reader was checked there, once): what the viewer's feed holds about its
 * repository, ranked as the feed ranks them. A guest has no feed, so none.
 */
export function feedOf(app: App, actor: User | undefined, view: FeatureView, limit = 20): FeedItem[] {
  if (actor === undefined) return [];
  const [owner = "", name = ""] = view.repo.split("/");
  const repo = getRepo(app.db, owner, name);
  return repo === undefined ? [] : readFeedPage(app.db, actor, { limit, repoId: repo.id }).items;
}

/** The same, from a slug, for the door that has not read the feature yet. */
export async function featureFeed(app: App, actor: User | undefined, slug: string, limit = 20): Promise<Result<readonly FeedItem[], FeatureError>> {
  const found = await getFeature(app, actor, slug);
  return found.ok ? ok(feedOf(app, actor, found.value, limit)) : found;
}

async function redeployAll(app: App, record: AppRecord, repo: Repo): Promise<void> {
  await appsRuntime(app)?.reconcileApp(record, repo, "redeploy");
}

/** Absorb an app that declares a feature. Absorbing one already absorbed changes nothing. */
export async function absorbApp(app: App, actor: User | undefined, slug: string): Promise<Result<FeatureView, FeatureError>> {
  const found = readable(app, actor, slug);
  if (found === undefined) return err("not_found");
  if (!siteAdmin(actor)) return err("forbidden");
  const declared = await declaredFeature(app, found.repo);
  if (!declared.ok || declared.value === undefined) return err("not_a_feature");
  if (absorb(app.db, found.record.id, actor.id, declared.value.name, declared.value.page, declared.value.summary ?? null)) {
    app.bus.append({ kind: "app.absorbed", repoId: found.repo.id, actorId: actor.id, payload: { slug, name: declared.value.name } });
    await redeployAll(app, found.record, found.repo);
  }
  return ok(viewOf(found.record, found.repo, app, declared.value, null, await provenanceOf(app, actor, found.repo)));
}

/**
 * Accept the name and page the admin reviewed as the menu's. Refused with
 * `declaration_changed` when the app declares something else by now, so an
 * admin never accepts values they did not see. An admin's act, and an event.
 */
export async function acceptDeclaration(
  app: App,
  actor: User | undefined,
  slug: string,
  reviewed: { readonly name: string; readonly page: string },
): Promise<Result<FeatureView, FeatureError>> {
  const found = readable(app, actor, slug);
  if (found === undefined) return err("not_found");
  if (!siteAdmin(actor)) return err("forbidden");
  const before = getAbsorbed(app.db, found.record.id);
  if (before === undefined) return err("not_absorbed");
  const declared = await declaredFeature(app, found.repo);
  if (!declared.ok || declared.value === undefined) return err("not_a_feature");
  const { name, page } = declared.value;
  const summary = declared.value.summary ?? null;
  if (name !== reviewed.name || page !== reviewed.page) return err("declaration_changed");
  if (name !== before.name || page !== before.page || summary !== before.summary) {
    keepDeclaration(app.db, found.record.id, name, page, summary);
    app.bus.append({
      kind: "app.feature_declared",
      repoId: found.repo.id,
      actorId: actor.id,
      payload: { slug, name, page, was: { name: before.name, page: before.page } },
    });
  }
  return ok(viewOf(found.record, found.repo, app, declared.value, null, await provenanceOf(app, actor, found.repo)));
}

/** Put an absorbed app back as an ordinary app. Its settings are kept for the next absorb. */
export async function unabsorbApp(app: App, actor: User | undefined, slug: string): Promise<Result<FeatureView, FeatureError>> {
  const found = readable(app, actor, slug);
  if (found === undefined) return err("not_found");
  if (!siteAdmin(actor)) return err("forbidden");
  if (!unabsorb(app.db, found.record.id)) return err("not_absorbed");
  app.bus.append({ kind: "app.unabsorbed", repoId: found.repo.id, actorId: actor.id, payload: { slug } });
  await redeployAll(app, found.record, found.repo);
  const declared = await declaredFeature(app, found.repo);
  const spec = declared.ok ? declared.value : undefined;
  const provenance = await provenanceOf(app, actor, found.repo);
  return ok(viewOf(found.record, found.repo, app, spec, declared.ok ? null : declared.error, provenance));
}

/**
 * Change some of an absorbed app's settings. Every value is checked against
 * its declaration first; one that does not fit refuses the whole change,
 * naming it. Kept values go to the app in a new process, as an env change does.
 */
export async function changeFeatureSettings(
  app: App,
  actor: User | undefined,
  slug: string,
  values: Readonly<Record<string, unknown>>,
): Promise<Result<FeatureView, { error: FeatureError; message: string; key?: string }>> {
  const refuse = (error: FeatureError, message: string, key?: string) => err(key === undefined ? { error, message } : { error, message, key });
  const found = readable(app, actor, slug);
  if (found === undefined) return refuse("not_found", "No such app.");
  if (!siteAdmin(actor)) return refuse("forbidden", "Only a site admin changes a feature's settings.");
  if (getAbsorbed(app.db, found.record.id) === undefined) return refuse("not_absorbed", "Absorb the app first.");
  const declared = await declaredFeature(app, found.repo);
  if (!declared.ok || declared.value === undefined) return refuse("not_a_feature", "The app no longer declares a feature.");
  const changes = new Map<string, string>();
  for (const [key, raw] of Object.entries(values)) {
    const spec = declared.value.settings.find((s) => s.key === key);
    if (spec === undefined) return refuse("invalid_setting", `${key} is not one of this feature's settings.`);
    const checked = checkSetting(spec, raw);
    if (!checked.ok) return refuse("invalid_setting", `${spec.label} ${checked.error}.`, key);
    changes.set(key, checked.value);
  }
  const before = openSettings(app.db, app.config.dataDir, found.record.id, declared.value);
  const changed = [...changes].filter(([k, v]) => (before.get(k) ?? declared.value!.settings.find((s) => s.key === k)!.default) !== v);
  const isSecret = (k: string): boolean => declared.value!.settings.find((s) => s.key === k)?.type === "secret";
  // A blank secret clears it: the row goes, so `set` says not set rather than a sealed empty string.
  const cleared = [...changes].filter(([k, v]) => v === "" && isSecret(k)).map(([k]) => k);
  const stored = new Map<string, string>();
  for (const [k, v] of changes) if (!cleared.includes(k)) stored.set(k, isSecret(k) ? sealSetting(app.config.dataDir, found.record.id, k, v) : v);
  if (stored.size > 0) keepSettings(app.db, found.record.id, stored, actor.id);
  if (cleared.length > 0) clearFeatureSettings(app.db, found.record.id, cleared);
  if (changed.length > 0) {
    app.bus.append({
      kind: "app.feature_settings",
      repoId: found.repo.id,
      actorId: actor.id,
      payload: { slug, keys: changed.map(([k]) => k) },
    });
    await redeployAll(app, found.record, found.repo);
  }
  return ok(viewOf(found.record, found.repo, app, declared.value, null, await provenanceOf(app, actor, found.repo)));
}
