/**
 * The social card on the web: GET /og/{repo,app,issue,pull,run,map}/:ref.svg
 * and GET /og/audit.svg.
 * Public by design — it is what a link preview fetches without a session —
 * so it says only what an anonymous reader may already see: a public repo
 * (`owner~name`), the public app of one (its slug), or an issue, pull or run
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
import type { App } from "../../app.ts";
import type { Run } from "../../core/runs.ts";
import { getUserById } from "../../core/users.ts";
import { getRepoRun } from "../../actions/runs.ts";
import { appsForRepos, getAppBySlug, isSlug } from "../../core/apps.ts";
import { audit } from "../../contract/audit.ts";
import { latestProbes } from "../../contract/probes.ts";
import { listActiveRuns } from "../../core/runs.ts";
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
import { getPull, type Pull } from "../../core/pulls.ts";
import { mayView, mayViewId, sealedScope } from "../../core/sealed.ts";
import { isSafeName } from "../../git/guard.ts";
import type { Ctx } from "../../http/context.ts";
import { notFound } from "../../http/respond.ts";
import { auditInput, type AuditRow } from "../og/audit.ts";
import { renderCard, type CardInput } from "../og/card.ts";
import { mapInput } from "../og/map.ts";
import { marksFor } from "./map.ts";
import { Busy, pngCache, type PngCache } from "../og/png-cache.ts";
import { rasterizer } from "../og/raster.ts";

/** What an anonymous reader may see of a repository, or nothing. */
function publicRepo(ctx: Ctx, repo: Repo | undefined): Repo | undefined {
  if (!repo || repo.visibility !== "public") return undefined;
  return canRead(ctx.app.db, repo, undefined) ? repo : undefined;
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

export type OgKind = "repo" | "app" | "issue" | "pull" | "run" | "map" | "audit";

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

function threadInput(ctx: Ctx, kind: OgKind, ref: string): CardInput | undefined {
  const at = threePart(ctx, ref);
  if (!at || !/^[1-9][0-9]{0,8}$/.test(at.rest)) return undefined;
  const n = Number(at.rest);
  const db = ctx.app.db;
  const item: Issue | Pull | undefined =
    kind === "pull" ? getPull(db, at.repo.id, n) : getIssue(db, at.repo.id, n);
  if (!item || item.kind !== kind || !mayView(db, at.repo, item, undefined))
    return undefined;
  const merged = "mergedAt" in item && item.mergedAt !== null;
  return {
    kind,
    title: item.title,
    lines: [
      `${at.repo.ownerName}/${at.repo.name}`,
      ...(kind === "issue" && item.state === "open"
        ? [waiting(ctx, at.repo, item)]
        : []),
    ],
    stat: `#${item.number} · ${item.state}${merged ? " · merged" : ""}`,
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
      stat: `${who ?? "agent"} · ${outcome(run)} · $${run.costUsd.toFixed(2)}`,
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
  const graph = repoGraph(db, repo.id, sealedScope(db, repo, undefined));
  // A run on a sealed report is not shown to who may not see the report.
  const runs = listActiveRuns(db, [repo.id]).filter((r) =>
    mayViewId(db, repo, r.issueId, undefined),
  );
  return mapInput(`${repo.ownerName}/${repo.name}`, graph, marksFor(db, repo.id, graph, runs));
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

async function resolve(ctx: Ctx, kind: OgKind, ref: string): Promise<CardInput | undefined> {
  const db = ctx.app.db;
  if (kind === "issue" || kind === "pull") return threadInput(ctx, kind, ref);
  if (kind === "run") return runInput(ctx, ref);
  if (kind === "map") return mapCardInput(ctx, ref);
  if (kind === "audit") return ref === "" ? auditCardInput(ctx) : undefined;
  if (kind === "repo") {
    const repo = twoPart(ctx, ref);
    return repo && repoInput(ctx, repo, "repo");
  }
  if (!isSlug(ref)) return undefined;
  const record = getAppBySlug(db, ref);
  if (!record || record.access !== "public") return undefined;
  const repo = publicRepo(ctx, getRepoById(db, record.repoId));
  return repo && { ...repoInput(ctx, repo, "app"), title: record.slug };
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
    const input = await resolve(ctx, kind, ctx.params.ref ?? "");
    if (!input) return notFound();
    const etag = `"${createHash("sha256").update(JSON.stringify(input)).digest("hex")}${format === "png" ? "-png" : ""}"`;
    const headers = {
      etag,
      "cache-control": "public, max-age=300",
      "content-type": format === "png" ? "image/png" : "image/svg+xml; charset=utf-8",
    };
    if (ctx.request.headers.get("if-none-match") === etag)
      return new Response(null, { status: 304, headers });
    if (format === "svg") return new Response(renderCard(input), { headers });
    try {
      return new Response(await cacheFor(ctx.app).get(input), { headers });
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
