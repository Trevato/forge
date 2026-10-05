/**
 * The front page (#686): what a stranger is shown at `/`, and the site
 * admin's say over it. The page, `/api/v1/front` and the MCP `front_page`
 * tool all answer from here, so they never disagree.
 *
 * What a stranger is shown is decided per request from what a stranger can
 * read (`canRead` with nobody), so a repository made private leaves the page
 * on the next load and a private pin never shows. Only the scores are
 * remembered between requests, for a minute: they are the expensive part,
 * and an hour-old ranking is as true as a fresh one.
 *
 * - Featured: the first pinned repository a stranger can read; with none,
 *   the best-ranked app. Shown with the crew at work on it right now.
 * - The shelf: pinned apps in the admin's order, then the public apps by
 *   score (`rankFront`) — those a stranger can open, live or waking, and
 *   only those with a picture — an app without one waits for the looks sweep, never shown as
 *   an empty box. Hidden ones never.
 */

import type { App } from "../app.ts";
import { appsRuntime, type EnvState } from "../apps/runtime.ts";
import { getAppByRepo, listPublicApps, type AppRecord } from "../core/apps.ts";
import {
  frontPicks,
  frontScore,
  frontSignals,
  rankFront,
  setFrontPicks,
  type FrontSignals,
} from "../core/front.ts";
import { getIssuesByIds } from "../core/issues.ts";
import {
  DEFAULT_PAGE,
  looksForApps,
  lookUrl,
  type Look,
} from "../core/looks.ts";
import { keepLook } from "../looks/service.ts";
import { canRead, getRepo, getReposByIds, type Repo } from "../core/repos.ts";
import { listActiveRuns } from "../core/runs.ts";
import { getUsersByIds, isActive, type User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";

/** How many public apps are read, and how many the shelf shows. */
const READ = 200;
export const SHELF = 12;
/** The most a site admin may pin, and hide. */
export const MAX_PINNED = 12;
export const MAX_HIDDEN = 200;
/** How long a ranking is kept before it is worked out again. */
const SCORES_MS = 60_000;

/** What a stranger may be shown of an app's production. */
const SHOWN: ReadonlySet<EnvState> = new Set([
  "running",
  "asleep",
  "deploying",
]);

export interface FrontEntry {
  readonly repo: Repo;
  readonly app: AppRecord | undefined;
  readonly state: EnvState | undefined;
  /** The thumb of production's home page, as a stranger sees it. */
  readonly picture: string | undefined;
  readonly pinned: boolean;
  readonly signals: FrontSignals;
  readonly score: number;
}

export interface CrewAtWork {
  /** Agent runs working on it right now. */
  readonly running: number;
  /** The issues they are on, newest first, at most three. */
  readonly issues: readonly { number: number; title: string }[];
}

export interface FrontPage {
  readonly featured: (FrontEntry & { readonly crew: CrewAtWork }) | undefined;
  readonly shelf: readonly FrontEntry[];
  /** Every public app a stranger could find on `/apps`. */
  readonly total: number;
}

/**
 * Whether a thumb is one taken as a stranger: not one from before thumbs
 * were (`keepLook`), which was the owner's view. A picture's file never
 * changes under its path, so each is read once.
 */
const kept = new Map<string, boolean>();
function strangersThumb(app: App, look: Look): boolean {
  let keep = kept.get(look.path);
  if (keep === undefined) {
    keep = keepLook(app.config.dataDir, look);
    if (look.error === null) kept.set(look.path, keep);
  }
  return keep;
}

type Scores = Map<string, { s: FrontSignals; score: number }>;

/** Each forge's ranking, remembered for `SCORES_MS`. */
const remembered = new WeakMap<App, { at: number; scores: Scores }>();

function scoresFor(app: App, repoIds: readonly string[], now: number): Scores {
  const kept = remembered.get(app);
  if (
    kept !== undefined &&
    now - kept.at < SCORES_MS &&
    repoIds.every((id) => kept.scores.has(id))
  )
    return kept.scores;
  const signals = frontSignals(app.db, repoIds, now);
  const scores: Scores = new Map(
    [...signals].map(([id, s]) => [id, { s, score: frontScore(s, now) }]),
  );
  remembered.set(app, { at: now, scores });
  return scores;
}

/** Forget the remembered ranking: the picks changed. */
export function forgetFrontScores(app: App): void {
  remembered.delete(app);
}

/** The front page as a stranger is shown it. */
export function frontPage(app: App, now = Date.now()): FrontPage {
  const db = app.db;
  const picks = frontPicks(db);
  const records = listPublicApps(db, READ);
  const pinnedRepos = getReposByIds(db, picks.pinned);
  const repos = getReposByIds(
    db,
    records.map((r) => r.repoId),
  );
  // A stranger's reading, asked of every repository, pinned or not.
  // A suspended or removed account's repositories are offered to nobody.
  const owners = getUsersByIds(db, [
    ...new Set([...pinnedRepos.values(), ...repos.values()].map((r) => r.ownerId)),
  ]);
  const readable = (repo: Repo | undefined): repo is Repo =>
    repo !== undefined &&
    canRead(db, repo, undefined) &&
    (owners.get(repo.ownerId) === undefined || isActive(owners.get(repo.ownerId)!));
  const pinned = picks.pinned
    .map((id) => pinnedRepos.get(id))
    .filter(readable)
    .filter((repo) => !picks.hidden.has(repo.id));
  const publicApps = records.filter((r) => readable(repos.get(r.repoId)));
  const appOf = new Map(publicApps.map((r) => [r.repoId, r]));
  for (const repo of pinned)
    if (!appOf.has(repo.id)) {
      const record = getAppByRepo(db, repo.id);
      if (record !== undefined) appOf.set(repo.id, record);
    }
  const ids = [
    ...new Set([
      ...pinned.map((r) => r.id),
      ...publicApps.map((r) => r.repoId),
    ]),
  ];
  const scores = scoresFor(app, ids, now);
  const looks = looksForApps(
    db,
    [...appOf.values()].map((r) => r.id),
  );
  const runtime = appsRuntime(app);
  const entry = (repo: Repo, isPinned: boolean): FrontEntry => {
    const record = appOf.get(repo.id);
    const production =
      record === undefined || runtime === undefined
        ? undefined
        : runtime.status(record).find((env) => env.env === "production");
    // An app open only to signed-in readers shows a stranger a sign-in
    // page: there is no picture of it worth showing them.
    const thumb =
      record === undefined || record.access !== "public"
        ? undefined
        : looks.find(
            (l) =>
              l.appId === record.id &&
              l.env === "production" &&
              l.commitOid === production?.commitOid &&
              l.page === DEFAULT_PAGE &&
              l.kind === "thumb" &&
              strangersThumb(app, l),
          );
    const scored = scores.get(repo.id) ?? {
      s: { awakeHours: 0, ships: 0, forks: 0, shippedAt: null },
      score: 0,
    };
    // An app only signed-in readers may open keeps how it runs to itself:
    // a stranger is told neither its state nor its hours awake (a pin can
    // name a public repository whose app is private).
    const open = record?.access === "public";
    const signals = open ? scored.s : { ...scored.s, awakeHours: 0 };
    return {
      repo,
      app: record,
      state: open ? production?.state : undefined,
      picture:
        thumb === undefined
          ? undefined
          : lookUrl(`/${repo.ownerName}/${repo.name}`, thumb),
      pinned: isPinned,
      signals,
      score: open ? scored.score : frontScore(signals, now),
    };
  };

  // A tile is a live app's picture, pinned or not: one that is down, or
  // has no picture taken as a stranger yet, waits (the looks sweep takes
  // one, waking a pinned app to do it) — never a letter in a box.
  const tileable = (e: FrontEntry): boolean =>
    e.state !== undefined && SHOWN.has(e.state) && e.picture !== undefined;
  const pinnedEntries = pinned.map((repo) => entry(repo, true));
  const pinnedIds = new Set(pinned.map((r) => r.id));
  const ranked = rankFront(
    publicApps
      .filter((r) => !pinnedIds.has(r.repoId) && !picks.hidden.has(r.repoId))
      .map((r) => entry(repos.get(r.repoId)!, false))
      .filter(tileable)
      .map((e) => ({ ...e, id: e.repo.id, owner: e.repo.ownerName })),
  );
  // Featured is a card, not a tile: the first pin may be a repository with
  // no app, or one whose app strangers cannot open (the forge itself) —
  // its crew at work is the picture. An app strangers can open that is
  // down is not featured; a private app's state is never consulted, so the
  // page does not tell a stranger whether it is up.
  const [first, ...rest] = pinnedEntries.filter(
    (e, at) => (at === 0 ? e.state === undefined || SHOWN.has(e.state) : tileable(e)),
  );
  const featuredEntry = first ?? ranked[0];
  const shelf = [
    ...(first === undefined ? [] : rest),
    ...(first === undefined ? ranked.slice(1) : ranked),
  ].slice(0, SHELF);
  return {
    featured:
      featuredEntry === undefined
        ? undefined
        : { ...featuredEntry, crew: crewAtWork(app, featuredEntry.repo) },
    shelf,
    total: publicApps.length,
  };
}

/** The crew's runs on one readable repository right now, and their issues. */
function crewAtWork(app: App, repo: Repo): CrewAtWork {
  const running = listActiveRuns(app.db, [repo.id]).filter(
    (r) => r.state === "running",
  );
  const issues = getIssuesByIds(
    app.db,
    running.flatMap((r) => (r.issueId === null ? [] : [r.issueId])),
  );
  const seen = new Set<string>();
  const on: { number: number; title: string }[] = [];
  for (const run of running) {
    const issue = run.issueId === null ? undefined : issues.get(run.issueId);
    if (issue === undefined || seen.has(issue.id)) continue;
    seen.add(issue.id);
    on.push({ number: issue.number, title: issue.title });
  }
  return { running: running.length, issues: on.slice(0, 3) };
}

/** The picks, by name, as a site admin set them — private ones included. */
export interface FrontPicksJson {
  readonly pinned: readonly string[];
  readonly hidden: readonly string[];
}

export function frontPicksJson(app: App): FrontPicksJson {
  const picks = frontPicks(app.db);
  const repos = getReposByIds(app.db, [...picks.pinned, ...picks.hidden]);
  const named = (id: string): string[] => {
    const repo = repos.get(id);
    return repo === undefined ? [] : [`${repo.ownerName}/${repo.name}`];
  };
  return {
    pinned: picks.pinned.flatMap(named),
    hidden: [...picks.hidden].flatMap(named).sort(),
  };
}

export type SetFrontError =
  | { readonly kind: "forbidden" }
  | { readonly kind: "invalid"; readonly message: string };

/**
 * Set every pick at once, by `owner/name`. A site admin's alone. A private
 * repository may be pinned — it shows once it is public — and a name that
 * is no repository is refused, as is one both pinned and hidden. A dry
 * run checks all of it and answers with the picks it would set, unsaved.
 */
export function setFront(
  app: App,
  user: User | undefined,
  input: { pinned: readonly string[]; hidden: readonly string[] },
  dryRun = false,
): Result<FrontPicksJson, SetFrontError> {
  if (user === undefined || !user.isAdmin) return err({ kind: "forbidden" });
  if (input.pinned.length > MAX_PINNED)
    return err({ kind: "invalid", message: `pin at most ${MAX_PINNED}` });
  if (input.hidden.length > MAX_HIDDEN)
    return err({ kind: "invalid", message: `hide at most ${MAX_HIDDEN}` });
  const resolve = (
    names: readonly string[],
  ): Result<Repo[], SetFrontError> => {
    const found: Repo[] = [];
    for (const name of names) {
      const [owner, repoName, ...extra] = name.trim().split("/");
      const repo =
        owner && repoName && extra.length === 0
          ? getRepo(app.db, owner, repoName)
          : undefined;
      if (repo === undefined)
        return err({
          kind: "invalid",
          message: `no repository ${name.slice(0, 100)} (owner/name)`,
        });
      if (!found.some((r) => r.id === repo.id)) found.push(repo);
    }
    return ok(found);
  };
  const pinned = resolve(input.pinned);
  if (!pinned.ok) return pinned;
  const hidden = resolve(input.hidden);
  if (!hidden.ok) return hidden;
  if (pinned.value.some((p) => hidden.value.some((h) => h.id === p.id)))
    return err({
      kind: "invalid",
      message: "a repository cannot be both pinned and hidden",
    });
  const named = (repos: Repo[]) => repos.map((r) => `${r.ownerName}/${r.name}`);
  if (dryRun)
    return ok({ pinned: named(pinned.value), hidden: named(hidden.value).sort() });
  setFrontPicks(
    app.db,
    pinned.value.map((r) => r.id),
    hidden.value.map((r) => r.id),
    user.id,
  );
  forgetFrontScores(app);
  return ok(frontPicksJson(app));
}

/**
 * `{pinned, hidden}` from a request body or tool call: each an array of
 * `owner/name` strings; one left out keeps what is set now, and a body
 * with neither is refused rather than taken for "no change".
 */
export function frontInput(
  app: App,
  input: unknown,
): { pinned: readonly string[]; hidden: readonly string[] } | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return undefined;
  const record = input as Record<string, unknown>;
  if (record["pinned"] === undefined && record["hidden"] === undefined)
    return undefined;
  const current = frontPicksJson(app);
  const names = (v: unknown, kept: readonly string[]) =>
    v === undefined
      ? kept
      : Array.isArray(v) && v.every((x) => typeof x === "string")
        ? (v as string[])
        : undefined;
  const pinned = names(record["pinned"], current.pinned);
  const hidden = names(record["hidden"], current.hidden);
  return pinned === undefined || hidden === undefined
    ? undefined
    : { pinned, hidden };
}

/** The front page as JSON: what a stranger is shown; a site admin also gets the picks. */
export function frontJson(
  app: App,
  viewer: User | undefined,
): Record<string, unknown> {
  const front = frontPage(app);
  const row = (e: FrontEntry) => ({
    repo: `${e.repo.ownerName}/${e.repo.name}`,
    description: e.repo.description,
    url: `/${e.repo.ownerName}/${e.repo.name}`,
    state: e.state ?? null,
    picture: e.picture ?? null,
    pinned: e.pinned,
    score: Math.round(e.score * 100) / 100,
    signals: e.signals,
  });
  return {
    featured:
      front.featured === undefined
        ? null
        : { ...row(front.featured), crew: front.featured.crew },
    apps: front.shelf.map(row),
    total: front.total,
    ...(viewer?.isAdmin === true ? { picks: frontPicksJson(app) } : {}),
  };
}
