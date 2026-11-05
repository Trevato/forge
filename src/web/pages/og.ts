/**
 * The social card on the web: GET /og/{repo,app,issue,pull,run,map}/:ref.svg
 * and GET /og/audit.svg and /og/site.svg (the card of every page without its own).
 * Public by design — it is what a link preview fetches without a session —
 * so it says only what an anonymous reader may already see: a public repo
 * (`owner~name`; any other repo, private or not, is a title and the word
 * "private", and a signed-in reader who may read it gets the full card), the public app of one (its slug), or an issue, pull or run
 * of a public repo (`owner~name~number`, `owner~name~runid`) that an
 * anonymous reader could open (not sealed, runs readable); a public repo's
 * map (`owner~name`) drawn from only the issues and runs it may see; or the
 * audit of the public apps. Anything else, or a
 * ref that is not shaped like one, is the same 404. The ETag is the sha256
 * of the card's inputs, so a changed repo is a new card and an unchanged
 * one is a 304. The `.png` twin is the same card rasterized once per input
 * hash and kept under the data directory; if the rasterizer is unavailable it
 * answers 503 and nothing else is affected.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { Fresh } from "../../kernel/fresh.ts";
import type { App } from "../../app.ts";
import type { Run } from "../../core/runs.ts";
import { getUserById } from "../../core/users.ts";
import { getRepoRun } from "../../actions/runs.ts";
import { appsForRepos, getAppByRepo, getAppBySlug, isSlug } from "../../core/apps.ts";
import { audit } from "../../contract/audit.ts";
import { latestProbes } from "../../contract/probes.ts";
import { checkSummary, listActiveRuns } from "../../core/runs.ts";
import {
  canRead,
  countsForRepos,
  getRepo,
  getRepoById,
  listReposVisibleTo,
  type Repo,
} from "../../core/repos.ts";
import { dependenciesOf, repoGraph, readyNow } from "../../core/dependencies.ts";
import { getIssue, getIssueById, type Issue } from "../../core/issues.ts";
import { mergerOf } from "../../core/merges.ts";
import { getPull, type Pull } from "../../core/pulls.ts";
import { mayView, mayViewId, sealedScope } from "../../core/sealed.ts";
import { isSafeName } from "../../git/guard.ts";
import type { Ctx } from "../../http/context.ts";
import { notFound } from "../../http/respond.ts";
import { notePhase, takeSessionTime, timePhase, timePhaseAsync } from "../../core/route_timing.ts";
import { auditInput, type AuditRow } from "../og/audit.ts";
import { renderCard, signature, type CardInput } from "../og/card.ts";
import { appImages, embedShots, pullImages } from "../og/looks.ts";
import { mapInput } from "../og/map.ts";
import { marksFor } from "./map.ts";
import { Busy, pngCache, type PngCache } from "../og/png-cache.ts";
import { rasterizer } from "../og/raster.ts";

/** What an anonymous reader may see of a repository, or nothing. */
function publicRepo(ctx: Ctx, repo: Repo | undefined): Repo | undefined {
  if (!repo || repo.visibility !== "public") return undefined;
  return canRead(ctx.app.db, repo, undefined) ? repo : undefined;
}

/** At most this many crew members are named on an app card. */
const NAMED_CREW = 3;

/**
 * The app as stored runs say it is, never probed: "deploying" while a
 * production deploy is open and not yet swapped in, "up" once one has
 * served, "down" otherwise; and when production last started serving.
 */
function liveState(
  ctx: Ctx,
  repo: Repo,
): { state: "up" | "down" | "deploying"; since: string | null } {
  const row = ctx.app.db
    .query<{ open: number; since: string | null }, [string]>(
      `SELECT EXISTS (SELECT 1 FROM run WHERE repo_id = ?1 AND kind = 'deploy'
                       AND env = 'production' AND state IN ('queued','running')
                       AND serving_at IS NULL) AS open,
              (SELECT MAX(serving_at) FROM run WHERE repo_id = ?1 AND kind = 'deploy'
                AND env = 'production') AS since`,
    )
    .get(repo.id);
  const since = row?.since ?? null;
  return { state: row?.open ? "deploying" : since ? "up" : "down", since };
}

/** Who has an agent run going on the repo now, visible runs only, at most three. */
function crewNow(ctx: Ctx, repo: Repo): string {
  const db = ctx.app.db;
  const names: string[] = [];
  for (const run of listActiveRuns(db, [repo.id])) {
    if (!mayViewId(db, repo, run.issueId, undefined)) continue;
    const who = run.actorId === null ? undefined : getUserById(db, run.actorId)?.username;
    if (who && !names.includes(who)) names.push(who);
  }
  if (names.length === 0) return "crew: idle";
  const more = names.length - NAMED_CREW;
  return `crew: ${names.slice(0, NAMED_CREW).join(", ")}${more > 0 ? ` +${more}` : ""}`;
}

function repoInput(ctx: Ctx, repo: Repo, kind: "repo" | "app"): CardInput {
  const n = countsForRepos(ctx.app.db, [repo.id]).get(repo.id);
  return {
    kind,
    title: `${repo.ownerName}/${repo.name}`,
    stat: `${n?.openIssues ?? 0} issues · ${n?.openPulls ?? 0} pulls`,
    lines: [
      ...(repo.description ? [repo.description] : []),
      ...(kind === "repo" ? [standing(ctx, repo)] : []),
    ],
  };
}

/**
 * How the open issues an anonymous reader sees stand: how many are ready,
 * how many wait on an open issue. Readiness is judged on the whole graph,
 * sealed issues included, so a sealed blocker still holds its dependent;
 * only the visible issues are counted.
 */
function standing(ctx: Ctx, repo: Repo): string {
  const graph = repoGraph(ctx.app.db, repo.id, { sealed: true });
  const visible = new Set(
    graph.issues.filter((i) => i.state === "open" && !i.sealed).map((i) => i.id),
  );
  const open = new Set(
    graph.issues.filter((i) => i.state === "open").map((i) => i.id),
  );
  const ready = readyNow(graph).filter((r) => visible.has(r.issue.id)).length;
  const blocked = new Set<string>();
  for (const e of graph.edges)
    if (visible.has(e.issueId) && open.has(e.blockedById)) blocked.add(e.issueId);
  for (const h of graph.held) if (visible.has(h.issueId)) blocked.add(h.issueId);
  return `${ready} ready now · ${blocked.size} blocked`;
}

/** At most this many blockers are named on an issue card. */
const NAMED_BLOCKERS = 3;

/** "ready", or "waits on #A, #B, #C +N": sealed blockers are only counted. */
function waiting(ctx: Ctx, repo: Repo, issue: Issue): string {
  const db = ctx.app.db;
  const open = dependenciesOf(db, issue.id).blockedBy.filter(
    (b) => b.state === "open",
  );
  if (open.length === 0) return "ready";
  const named = open.filter((b) => mayView(db, repo, b, undefined));
  const shown = named.slice(0, NAMED_BLOCKERS).map((b) => `#${b.number}`);
  const more = open.length - shown.length;
  if (shown.length === 0) return `waits on ${more} hidden`;
  return `waits on ${shown.join(", ")}${more > 0 ? ` +${more}` : ""}`;
}

export type OgKind = "repo" | "app" | "issue" | "pull" | "run" | "map" | "audit" | "site";

/** The card for any page without a card of its own: it says only what the forge is. */
const SITE_CARD: CardInput = {
  kind: "page",
  title: "Software for what you're building.",
  lines: ["Yours to keep. Your own forge, with a private AI crew. Open source."],
};

/** The audit page's own bound. */
const AUDIT_LIMIT = 200;

const RUN_ID = /^[0-9a-z]{1,40}$/;

/** `owner~name~rest` → its public repo and the rest, or nothing. */
function threePart(
  ctx: Ctx,
  ref: string,
): { repo: Repo; rest: string } | undefined {
  const [owner, name, rest, extra] = ref.split("~");
  if (extra !== undefined || !owner || !name || !rest) return undefined;
  if (!isSafeName(owner) || !isSafeName(name)) return undefined;
  const repo = publicRepo(ctx, getRepo(ctx.app.db, owner, name));
  return repo && { repo, rest };
}

type Verdict = "green" | "red" | "running" | "cancelled" | "none";

/**
 * The check verdict a pull page shows, in a word. Read at the head recorded
 * on the pull, not the live git head the page resolves: the card does no git
 * work, so it can briefly disagree with the page after a push.
 */
function verdict(ctx: Ctx, pull: Pull): Verdict {
  const { state } = checkSummary(ctx.app.db, pull.id, pull.headOid);
  if (state === "ok") return "green";
  if (state === "failed") return "red";
  if (state === "queued" || state === "running") return "running";
  // A check that was stopped is not the absence of one.
  if (state === "cancelled") return "cancelled";
  return "none";
}

function pullInput(ctx: Ctx, repo: Repo, pull: Pull): CardInput {
  const merged = pull.mergedAt !== null;
  const mergedBy = merged ? mergerOf(ctx.app.db, pull.id) : null;
  return {
    kind: "pull",
    title: pull.title,
    lines: [
      `${repo.ownerName}/${repo.name}`,
      `by ${pull.originAuthor ?? pull.authorName}`,
      ...(pull.mergedAt
        ? [`merged ${pull.mergedAt.slice(0, 10)}${mergedBy ? ` by ${mergedBy}` : ""}`]
        : []),
    ],
    stat: `#${pull.number} · ${pull.state}${merged ? " · merged" : ""} · check ${verdict(ctx, pull)}`,
  };
}

function threadInput(ctx: Ctx, kind: OgKind, ref: string): CardInput | undefined {
  const at = threePart(ctx, ref);
  if (!at || !/^[1-9][0-9]{0,8}$/.test(at.rest)) return undefined;
  const n = Number(at.rest);
  const db = ctx.app.db;
  const item: Issue | Pull | undefined =
    kind === "pull" ? getPull(db, at.repo.id, n) : getIssue(db, at.repo.id, n);
  if (!item || item.kind !== kind || !mayView(db, at.repo, item, undefined))
    return undefined;
  if (kind === "pull") {
    const input = pullInput(ctx, at.repo, item as Pull);
    const record = getAppByRepo(db, at.repo.id);
    const images = record ? pullImages(ctx.app, record, at.repo.id, n) : [];
    return images.length ? { ...input, images } : input;
  }
  return {
    kind,
    title: item.title,
    lines: [
      `${at.repo.ownerName}/${at.repo.name}`,
      ...(kind === "issue" && item.state === "open"
        ? [waiting(ctx, at.repo, item)]
        : []),
    ],
    stat: `#${item.number} · ${item.state}`,
  };
}

/** The outcome of an agent run in a word, read from its state and last words. */
function outcome(run: Run): string {
  if (run.state === "queued") return "queued";
  if (run.state === "running") return "working";
  if (run.state === "cancelled") return "cancelled";
  if (/opened pull #|updated pull #/.test(run.summary)) return "landed a pull";
  if (/\bdeclined:/i.test(run.summary)) return "declined";
  return run.state === "ok" ? "done" : "failed";
}

function runInput(ctx: Ctx, ref: string): CardInput | undefined {
  const at = threePart(ctx, ref);
  if (!at || !RUN_ID.test(at.rest)) return undefined;
  // getRepoRun already seals: a run on a sealed thread is the same 404.
  const found = getRepoRun(ctx.app, undefined, at.repo, at.rest);
  if (!found.ok) return undefined;
  const run = found.value;
  const db = ctx.app.db;
  const who =
    run.actorId === null ? undefined : getUserById(db, run.actorId)?.username;
  const repoName = `${at.repo.ownerName}/${at.repo.name}`;
  if (run.kind === "agent") {
    const about = run.issueId === null ? undefined : getIssueById(db, run.issueId);
    const thread = about ? `#${about.number} ${about.title}` : undefined;
    return {
      kind: "run",
      title: run.summary || "agent run",
      lines: [repoName, ...(thread ? [thread] : [])],
      // The card is drawn for anyone a link is pasted to, so it says no
      // cost: that is the owner's fact (`runForReader`, #2917).
      stat: `${who ?? "agent"} · ${outcome(run)}`,
    };
  }
  return {
    kind: "run",
    title: run.summary || `${run.kind} run`,
    lines: [repoName, ...(who ? [`by ${who}`] : [])],
    stat: `${run.kind}${run.env ? ` · ${run.env}` : ""} · ${run.state}`,
  };
}

/** `owner~name` → its public repo, or nothing. */
function twoPart(ctx: Ctx, ref: string): Repo | undefined {
  const [owner, name, extra] = ref.split("~");
  if (extra !== undefined || !owner || !name) return undefined;
  if (!isSafeName(owner) || !isSafeName(name)) return undefined;
  return publicRepo(ctx, getRepo(ctx.app.db, owner, name));
}

/** The map as the map page draws it for someone signed out. */
function mapCardInput(ctx: Ctx, ref: string): CardInput | undefined {
  const repo = twoPart(ctx, ref);
  if (!repo) return undefined;
  const db = ctx.app.db;
  const stretch = <T>(name: string, work: () => T): T => timePhase(ctx.request, name, work);
  const graph = stretch("graph", () => repoGraph(db, repo.id, sealedScope(db, repo, undefined)));
  const marks = stretch("marks", () => {
    // A run on a sealed report is not shown to who may not see the report.
    const runs = listActiveRuns(db, [repo.id]).filter((r) =>
      mayViewId(db, repo, r.issueId, undefined),
    );
    return marksFor(db, repo.id, graph, runs);
  });
  return mapInput(`${repo.ownerName}/${repo.name}`, graph, marks, stretch);
}

/** The public apps, read the way the audit page reads them for someone signed out. */
async function auditCardInput(ctx: Ctx): Promise<CardInput> {
  const db = ctx.app.db;
  const repos = listReposVisibleTo(db, undefined, { limit: AUDIT_LIMIT });
  const records = appsForRepos(
    db,
    repos.map((r) => r.id),
  );
  const apps = repos.filter((r) => records.has(r.id));
  const audited = await Promise.all(apps.map((repo) => audit(ctx.app.reposRoot, repo)));
  const appId = (repoId: string): string => records.get(repoId)!.id;
  const probed = latestProbes(
    db,
    audited.filter((a) => a.standing.kind === "sound").map((a) => appId(a.repo.id)),
  );
  const rows: AuditRow[] = audited.map((a) => ({
    name: `${a.repo.ownerName}/${a.repo.name}`,
    standing: a.standing.kind,
    open: a.standing.kind === "sound" ? a.standing.open.length : 0,
    problems: a.standing.kind === "unsound" ? a.standing.problems : [],
    disobeys:
      a.standing.kind === "sound" && probed.get(appId(a.repo.id))?.verdict === "mismatch",
  }));
  return auditInput(rows);
}

/**
 * A repository's card. The public repo, or one the signed-in viewer may read,
 * gets the full card; any other well-formed ref gets a card of its title and
 * the word "private" — the same for a private repo and a name nobody has
 * taken, so the card cannot be used to find out which exist.
 */
function repoCard(ctx: Ctx, ref: string): CardInput | undefined {
  const [owner, name, extra] = ref.split("~");
  if (extra !== undefined || !owner || !name) return undefined;
  if (!isSafeName(owner) || !isSafeName(name)) return undefined;
  const repo = getRepo(ctx.app.db, owner, name);
  if (repo && canRead(ctx.app.db, repo, ctx.auth.user))
    return repoInput(ctx, repo, "repo");
  return { kind: "repo", title: `${owner}/${name}`, stat: "private" };
}

/** Whether this response is for the signed-in viewer alone, not for a shared cache. */
function personal(ctx: Ctx, kind: OgKind, ref: string): boolean {
  if (kind !== "repo" || ctx.auth.user === undefined) return false;
  const [owner, name] = ref.split("~");
  if (!owner || !name || !isSafeName(owner) || !isSafeName(name)) return false;
  const repo = getRepo(ctx.app.db, owner, name);
  return repo !== undefined && repo.visibility !== "public";
}

async function resolve(ctx: Ctx, kind: OgKind, ref: string): Promise<CardInput | undefined> {
  const db = ctx.app.db;
  if (kind === "issue" || kind === "pull") return threadInput(ctx, kind, ref);
  if (kind === "run") return runInput(ctx, ref);
  if (kind === "map") return mapCardInput(ctx, ref);
  if (kind === "audit") return ref === "" ? auditCards(ctx.app).get("", () => auditCardInput(ctx)) : undefined;
  if (kind === "site") return ref === "" ? SITE_CARD : undefined;
  if (kind === "repo") return repoCard(ctx, ref);
  if (!isSlug(ref)) return undefined;
  const record = getAppBySlug(db, ref);
  if (!record || record.access !== "public") return undefined;
  const repo = publicRepo(ctx, getRepoById(db, record.repoId));
  if (!repo) return undefined;
  const live = liveState(ctx, repo);
  const base = repoInput(ctx, repo, "app");
  const images = appImages(ctx.app, record, repo.id);
  return {
    ...base,
    ...(images.length ? { images } : {}),
    title: record.slug,
    lines: [
      ...(base.lines ?? []),
      `${live.state}${live.since ? ` · deployed ${live.since.slice(0, 10)}` : ""}`,
      crewNow(ctx, repo),
    ],
  };
}

/**
 * The audit card reads every public app's repository with git; anyone may
 * ask for it, so it is made once per AUDIT_CARD_MS however many do.
 */
const AUDIT_CARD_MS = 45_000;
const auditCache = new WeakMap<App, Fresh<Promise<CardInput>>>();
function auditCards(app: App): Fresh<Promise<CardInput>> {
  let kept = auditCache.get(app);
  if (kept === undefined) {
    kept = new Fresh(AUDIT_CARD_MS, 1);
    auditCache.set(app, kept);
  }
  return kept;
}

const caches = new WeakMap<App, PngCache>();

function cacheFor(app: App): PngCache {
  let c = caches.get(app);
  if (!c) {
    c = pngCache({
      dir: join(app.config.dataDir, "og-png"),
      raster: rasterizer,
      svg: renderCard,
    });
    caches.set(app, c);
  }
  return c;
}

export function ogCard(kind: OgKind, format: "svg" | "png" = "svg") {
  return async (ctx: Ctx): Promise<Response> => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const input = await timePhaseAsync(ctx.request, "resolve", () =>
      resolve(ctx, kind, ctx.params.ref ?? ""),
    );
    if (!input) return notFound();
    const etag = `"${createHash("sha256").update(signature(input)).digest("hex")}${format === "png" ? "-png" : ""}"`;
    const headers = {
      etag,
      "cache-control": personal(ctx, kind, ctx.params.ref ?? "")
        ? "private, max-age=300"
        : "public, max-age=300",
      ...(kind === "repo" ? { vary: "cookie" } : {}),
      "content-type": format === "png" ? "image/png" : "image/svg+xml; charset=utf-8",
    };
    if (ctx.request.headers.get("if-none-match") === etag)
      return new Response(null, { status: 304, headers });
    if (format === "svg")
      return new Response(
        timePhase(ctx.request, "render", () => renderCard(embedShots(input))),
        { headers },
      );
    try {
      const png = await timePhaseAsync(ctx.request, "raster", () =>
        cacheFor(ctx.app).get(embedShots(input)),
      );
      return new Response(png, { headers });
    } catch (error) {
      if (!(error instanceof Busy))
        ctx.app.log.error("og card could not be rasterized", { kind, error: String(error) });
      return new Response("card unavailable\n", {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "30" },
      });
    }
  };
}
