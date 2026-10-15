/**
 * The social card on the web: GET /og/{repo,app,issue,pull,run}/:ref.svg.
 * Public by design — it is what a link preview fetches without a session —
 * so it says only what an anonymous reader may already see: a public repo
 * (`owner~name`), the public app of one (its slug), or an issue, pull or run
 * of a public repo (`owner~name~number`, `owner~name~runid`) that an
 * anonymous reader could open (not sealed, runs readable). Anything else, or a
 * ref that is not shaped like one, is the same 404. The ETag is the sha256
 * of the card's inputs, so a changed repo is a new card and an unchanged
 * one is a 304.
 */

import { createHash } from "node:crypto";
import { getRepoRun } from "../../actions/runs.ts";
import { getAppBySlug, isSlug } from "../../core/apps.ts";
import {
  canRead,
  countsForRepos,
  getRepo,
  getRepoById,
  type Repo,
} from "../../core/repos.ts";
import { getIssue, type Issue } from "../../core/issues.ts";
import { getPull, type Pull } from "../../core/pulls.ts";
import { mayView } from "../../core/sealed.ts";
import { isSafeName } from "../../git/guard.ts";
import type { Ctx } from "../../http/context.ts";
import { notFound } from "../../http/respond.ts";
import { renderCard, type CardInput } from "../og/card.ts";

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
    lines: repo.description ? [repo.description] : [],
    stat: `${n?.openIssues ?? 0} issues · ${n?.openPulls ?? 0} pulls`,
  };
}

export type OgKind = "repo" | "app" | "issue" | "pull" | "run";

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
    lines: [`${at.repo.ownerName}/${at.repo.name}`],
    stat: `#${item.number} · ${item.state}${merged ? " · merged" : ""}`,
  };
}

function runInput(ctx: Ctx, ref: string): CardInput | undefined {
  const at = threePart(ctx, ref);
  if (!at || !RUN_ID.test(at.rest)) return undefined;
  const found = getRepoRun(ctx.app, undefined, at.repo, at.rest);
  if (!found.ok) return undefined;
  const run = found.value;
  return {
    kind: "run",
    title: run.summary || `${run.kind} run`,
    lines: [`${at.repo.ownerName}/${at.repo.name}`],
    stat: `${run.kind} · ${run.state}`,
  };
}

function resolve(ctx: Ctx, kind: OgKind, ref: string): CardInput | undefined {
  const db = ctx.app.db;
  if (kind === "issue" || kind === "pull") return threadInput(ctx, kind, ref);
  if (kind === "run") return runInput(ctx, ref);
  if (kind === "repo") {
    const [owner, name, extra] = ref.split("~");
    if (extra !== undefined || !owner || !name) return undefined;
    if (!isSafeName(owner) || !isSafeName(name)) return undefined;
    const repo = publicRepo(ctx, getRepo(db, owner, name));
    return repo && repoInput(ctx, repo, "repo");
  }
  if (!isSlug(ref)) return undefined;
  const record = getAppBySlug(db, ref);
  if (!record || record.access !== "public") return undefined;
  const repo = publicRepo(ctx, getRepoById(db, record.repoId));
  return repo && { ...repoInput(ctx, repo, "app"), title: record.slug };
}

export function ogCard(kind: OgKind) {
  return (ctx: Ctx): Response => {
    const input = resolve(ctx, kind, ctx.params.ref ?? "");
    if (!input) return notFound();
    const etag = `"${createHash("sha256").update(JSON.stringify(input)).digest("hex")}"`;
    const headers = {
      etag,
      "cache-control": "public, max-age=300",
      "content-type": "image/svg+xml; charset=utf-8",
    };
    if (ctx.request.headers.get("if-none-match") === etag)
      return new Response(null, { status: 304, headers });
    return new Response(renderCard(input), { headers });
  };
}
