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
  latestMerges,
  mergesByDay,
  type LatestMerge,
  frontWeights,
  isWeight,
  rankFront,
  setFrontPicks,
  setFrontWeights,
  WEIGHT_MAX,
  WEIGHT_NAMES,
  type FrontWeights,
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
import { timePhase } from "../core/route_timing.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { limitValue } from "../settings/limits.ts";

/** How many public apps are read, and how many the shelf shows. */
const READ = 200;
export const SHELF = 12;
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

/** One merged change on a public repository, as the door lists it. */
export interface DoorChange {
  readonly repo: string;
  readonly title: string;
  readonly href: string;
  readonly mergedAt: string;
}

/** What the forge is doing, in public, read with the page and kept with it. */
export interface FrontPulse {
  /** Public apps whose production is running right now. */
  readonly running: number;
  /** Changes merged on the shown repositories in the last `SIGNAL_DAYS`. */
  readonly merged: number;
  /** Agents at work on the shown repositories, and at most three of their issues. */
  readonly crew: {
    readonly running: number;
    readonly issues: readonly { title: string; href: string }[];
  };
  /** The newest merged changes, at most `DOOR_CHANGES`. */
  readonly changes: readonly DoorChange[];
  /** Changes merged each day, oldest first, `PULSE_DAYS` of them, today last. */
  readonly days: readonly { readonly day: string; readonly n: number }[];
}

export interface FrontPage {
  readonly featured: (FrontEntry & { readonly crew: CrewAtWork }) | undefined;
  readonly shelf: readonly FrontEntry[];
  /** Every public app a stranger could find on `/apps`. */
  readonly total: number;
  readonly pulse: FrontPulse;
}

/** How many merged changes the door lists. */
const DOOR_CHANGES = 4;

/** How many days the door's picture of the work covers. */
const PULSE_DAYS = 90;

/**
 * Whether a thumb is one taken as a stranger: not one from before thumbs
 * were (`keepLook`), which was the owner's view. A picture's file never
 * changes under its path, so each is read once — and remembered only while
 * it is still one of the pictures the page looks at: each page drops the
 * paths it did not ask about, so the memory is never larger than the
 * current pictures, however often they are retaken (#768).
 */
const thumbChecks = new WeakMap<App, Map<string, boolean>>();

function strangersThumbs(app: App): {
  check: (look: Look) => boolean;
  /** Forget every path this page did not ask about. */
  done: () => void;
} {
  let known = thumbChecks.get(app);
  if (known === undefined) {
    known = new Map();
    thumbChecks.set(app, known);
  }
  const memo = known;
  const asked = new Set<string>();
  return {
    check: (look) => {
      asked.add(look.path);
      let keep = memo.get(look.path);
      if (keep === undefined) {
        keep = keepLook(app.config.dataDir, look);
        if (look.error === null) memo.set(look.path, keep);
      }
      return keep;
    },
    done: () => {
      for (const path of memo.keys()) if (!asked.has(path)) memo.delete(path);
    },
  };
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
  const weights = frontWeights(app.db);
  const scores: Scores = new Map(
    [...signals].map(([id, s]) => [id, { s, score: frontScore(s, now, weights) }]),
  );
  remembered.set(app, { at: now, scores });
  return scores;
}

/** Forget the remembered ranking: the picks changed. */
export function forgetFrontScores(app: App): void {
  remembered.delete(app);
  merges.delete(app);
  built.delete(app);
}

/** The newest merges, kept as long as a ranking: a write must not mean another walk of the merged pulls. */
const merges = new WeakMap<
  App,
  {
    at: number;
    rows: readonly LatestMerge[];
    days: FrontPulse["days"];
    ids: ReadonlySet<string>;
  }
>();

function newestMerges(
  app: App,
  repoIds: readonly string[],
  now: number,
): { rows: readonly LatestMerge[]; days: FrontPulse["days"] } {
  const kept = merges.get(app);
  const shown = new Set(repoIds);
  // A repository made private leaves the list at once; one made public waits its turn.
  if (kept !== undefined && now - kept.at < SCORES_MS && repoIds.every((id) => kept.ids.has(id)))
    return { rows: kept.rows.filter((r) => shown.has(r.repoId)), days: kept.days };
  const rows = latestMerges(app.db, repoIds, DOOR_CHANGES * 4);
  const dayOf = (back: number): string =>
    new Date(now - back * 86_400_000).toISOString().slice(0, 10);
  const counted = new Map(
    mergesByDay(app.db, repoIds, dayOf(PULSE_DAYS - 1)).map((d) => [d.day, d.n]),
  );
  const days = Array.from({ length: PULSE_DAYS }, (_, at) => {
    const day = dayOf(PULSE_DAYS - 1 - at);
    return { day, n: counted.get(day) ?? 0 };
  });
  merges.set(app, { at: now, rows, days, ids: shown });
  return { rows, days };
}

/** How long a built page is kept when nothing in the database changed: an app's state is not in it. */
const PAGE_MS = 3_000;

/**
 * The built page, kept for `PAGE_MS` while the database is untouched: any
 * write on this connection, or by another, changes the key, so a repository
 * made private, a pick, a picture or a suspension shows on the next request.
 */
const built = new WeakMap<App, { key: string; at: number; page: FrontPage }>();

/**
 * The shelf's data version: one row that triggers bump when a column the
 * shelf renders changes (`front_epoch`). Its size never depends on how many
 * apps there are, and a session, a heartbeat or a push does not move it.
 */
export function frontKey(app: App): string {
  const row = app.db
    .query<{ n: number }, []>("SELECT n FROM front_epoch")
    .get();
  return String(row?.n);
}

/**
 * The repositories a signed-out visitor is offered by name: the shelf's own
 * set, featured first, so the jump palette never lists more than the door.
 */
export function doorRepos(app: App): Repo[] {
  const page = frontPage(app);
  const seen = new Set<string>();
  return [...(page.featured === undefined ? [] : [page.featured]), ...page.shelf]
    .map((e) => e.repo)
    .filter((r) => !seen.has(r.id) && seen.add(r.id));
}

/** The front page as a stranger is shown it; `request` is told what the key cost. */
export function frontPage(app: App, now = Date.now(), request?: Request): FrontPage {
  const key =
    request === undefined
      ? frontKey(app)
      : timePhase(request, "key", () => frontKey(app));
  const kept = built.get(app);
  const wall = performance.now();
  if (kept !== undefined && kept.key === key && wall - kept.at < PAGE_MS)
    return kept.page;
  const page = buildFrontPage(app, now);
  built.set(app, { key, at: wall, page });
  return page;
}

function buildFrontPage(app: App, now: number): FrontPage {
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
  const thumbs = strangersThumbs(app);
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
              thumbs.check(l),
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
      score: open ? scored.score : frontScore(signals, now, frontWeights(db)),
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
      // The door shows the forge's own makers; a stranger's app is found on
      // /explore or pinned by an admin. Filtered here, before any ranking is kept.
      .filter((r) => owners.get(repos.get(r.repoId)!.ownerId)?.isAdmin === true)
      .map((r) => entry(repos.get(r.repoId)!, false))
      .filter(tileable)
      .map((e) => ({ ...e, id: e.repo.id, owner: e.repo.ownerName })),
  );
  thumbs.done();
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
  const shownRepos = new Map(
    [...pinned, ...publicApps.map((r) => repos.get(r.repoId)!)].map((r) => [r.id, r]),
  );
  return {
    featured:
      featuredEntry === undefined
        ? undefined
        : { ...featuredEntry, crew: crewAtWork(app, featuredEntry.repo) },
    shelf,
    total: publicApps.length,
    pulse: buildPulse(app, shownRepos, publicApps, scores, now),
  };
}

function buildPulse(
  app: App,
  shown: ReadonlyMap<string, Repo>,
  publicApps: readonly AppRecord[],
  scores: Scores,
  now: number,
): FrontPulse {
  const runtime = appsRuntime(app);
  const running =
    runtime === undefined
      ? 0
      : publicApps.filter(
          (r) =>
            r.access === "public" &&
            runtime.status(r).some((env) => env.env === "production" && env.state === "running"),
        ).length;
  const ids = [...shown.keys()];
  const merged = ids.reduce((sum, id) => sum + (scores.get(id)?.s.ships ?? 0), 0);
  const seen = new Set<string>();
  const changes: DoorChange[] = [];
  const { rows, days } = newestMerges(app, ids, now);
  for (const m of rows) {
    const repo = shown.get(m.repoId);
    if (repo === undefined || seen.has(m.title) || changes.length === DOOR_CHANGES) continue;
    seen.add(m.title);
    changes.push({
      repo: repo.name,
      title: m.title,
      href: `/${repo.ownerName}/${repo.name}/pulls/${m.number}`,
      mergedAt: m.mergedAt,
    });
  }
  return { running, merged, crew: crewOn(app, shown), changes, days };
}

/** The crew's runs on one readable repository right now, and their issues. */
function crewAtWork(app: App, repo: Repo): CrewAtWork {
  const { running, issues } = crewOn(app, new Map([[repo.id, repo]]));
  return { running, issues: issues.map(({ number, title }) => ({ number, title })) };
}

/** The crew's runs across readable repositories right now, and the issues they are on. */
function crewOn(
  app: App,
  repos: ReadonlyMap<string, Repo>,
): { running: number; issues: readonly { number: number; title: string; href: string }[] } {
  const running = listActiveRuns(app.db, [...repos.keys()]).filter(
    (r) => r.state === "running",
  );
  const issues = getIssuesByIds(
    app.db,
    running.flatMap((r) => (r.issueId === null ? [] : [r.issueId])),
  );
  const seen = new Set<string>();
  const on: { number: number; title: string; href: string }[] = [];
  for (const run of running) {
    const issue = run.issueId === null ? undefined : issues.get(run.issueId);
    // The front page is the stranger's view: a sealed report is not on it.
    if (issue === undefined || issue.sealed || seen.has(issue.id)) continue;
    const repo = repos.get(run.repoId);
    if (repo === undefined) continue;
    seen.add(issue.id);
    on.push({
      number: issue.number,
      title: issue.title,
      href: `/${repo.ownerName}/${repo.name}/issues/${issue.number}`,
    });
  }
  return { running: running.length, issues: on.slice(0, 3) };
}

/** The picks, by name, as a site admin set them — private ones included. */
export interface FrontPicksJson {
  readonly pinned: readonly string[];
  readonly hidden: readonly string[];
  /** How the page ranks: what forks, ships, use and freshness count for. */
  readonly weights: FrontWeights;
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
    weights: frontWeights(app.db),
  };
}

export type SetFrontError =
  | { readonly kind: "forbidden" }
  | { readonly kind: "invalid"; readonly message: string };

/**
 * Set every pick at once, by `owner/name`. A site admin's alone. A private
 * repository may be pinned — it shows once it is public — and a name that
 * is no repository is refused, as is one both pinned and hidden. The
 * weights (#767) are each a number from 0 to `WEIGHT_MAX`. A dry run checks
 * all of it and answers with what it would set, unsaved.
 */
export function setFront(
  app: App,
  user: User | undefined,
  input: {
    pinned: readonly string[];
    hidden: readonly string[];
    weights?: Record<string, unknown>;
  },
  dryRun = false,
): Result<FrontPicksJson, SetFrontError> {
  if (user === undefined || !user.isAdmin) return err({ kind: "forbidden" });
  const weights = input.weights ?? frontWeights(app.db);
  if (!WEIGHT_NAMES.every((k) => isWeight(weights[k])))
    return err({
      kind: "invalid",
      message: `each weight (${WEIGHT_NAMES.join(", ")}) is a number from 0 to ${WEIGHT_MAX}`,
    });
  const weighed: FrontWeights = {
    forks: weights["forks"] as number,
    ships: weights["ships"] as number,
    use: weights["use"] as number,
    fresh: weights["fresh"] as number,
  };
  if (input.pinned.length > limitValue(app.db, "front.pinned_max"))
    return err({ kind: "invalid", message: `pin at most ${limitValue(app.db, "front.pinned_max")}` });
  if (input.hidden.length > limitValue(app.db, "front.hidden_max"))
    return err({ kind: "invalid", message: `hide at most ${limitValue(app.db, "front.hidden_max")}` });
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
    return ok({
      pinned: named(pinned.value),
      hidden: named(hidden.value).sort(),
      weights: weighed,
    });
  setFrontPicks(
    app.db,
    pinned.value.map((r) => r.id),
    hidden.value.map((r) => r.id),
    user.id,
  );
  setFrontWeights(app.db, weighed, user.id);
  forgetFrontScores(app);
  return ok(frontPicksJson(app));
}

/**
 * `{pinned, hidden, weights}` from a request body or tool call: pinned and
 * hidden each an array of `owner/name` strings, weights an object of some
 * of `forks ships use fresh`; anything left out keeps what is set now, and
 * a body with none of them is refused rather than taken for "no change".
 */
export function frontInput(
  app: App,
  input: unknown,
):
  | {
      pinned: readonly string[];
      hidden: readonly string[];
      weights: Record<string, unknown>;
    }
  | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return undefined;
  const record = input as Record<string, unknown>;
  if (
    record["pinned"] === undefined &&
    record["hidden"] === undefined &&
    record["weights"] === undefined
  )
    return undefined;
  const given = record["weights"];
  if (given !== undefined && (typeof given !== "object" || given === null || Array.isArray(given)))
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
  if (pinned === undefined || hidden === undefined) return undefined;
  const weights: Record<string, unknown> = { ...current.weights };
  for (const k of WEIGHT_NAMES)
    if (given !== undefined && k in (given as object))
      weights[k] = (given as Record<string, unknown>)[k];
  return { pinned, hidden, weights };
}

/** One app on the front page as JSON. */
export type FrontRowJson = {
  readonly repo: string;
  readonly description: string;
  readonly url: string;
  readonly state: EnvState | null;
  readonly picture: string | null;
  readonly pinned: boolean;
  readonly score: number;
  readonly signals: FrontSignals;
};

/** The front page as JSON, as `frontJson` answers it. */
export type FrontJson = {
  readonly featured: (FrontRowJson & { readonly crew: CrewAtWork }) | null;
  readonly apps: readonly FrontRowJson[];
  readonly total: number;
  readonly picks?: FrontPicksJson;
};

/** The front page as JSON: what a stranger is shown; a site admin also gets the picks. */
export function frontJson(app: App, viewer: User | undefined): FrontJson {
  const front = frontPage(app);
  const row = (e: FrontEntry): FrontRowJson => ({
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
