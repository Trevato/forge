/**
 * The social card on the web: GET /og/repo/:ref.svg and /og/app/:ref.svg.
 * Public by design — it is what a link preview fetches without a session —
 * so it says only what an anonymous reader may already see: a public repo
 * (`owner~name`) or the public app of one (its slug). Anything else, or a
 * ref that is not shaped like one, is the same 404. The ETag is the sha256
 * of the card's inputs, so a changed repo is a new card and an unchanged
 * one is a 304.
 */

import { createHash } from "node:crypto";
import { getAppBySlug, isSlug } from "../../core/apps.ts";
import {
  canRead,
  countsForRepos,
  getRepo,
  getRepoById,
  type Repo,
} from "../../core/repos.ts";
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

function resolve(ctx: Ctx, kind: string, ref: string): CardInput | undefined {
  const db = ctx.app.db;
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

export function ogCard(kind: "repo" | "app") {
  return (ctx: Ctx): Response => {
    const input = resolve(ctx, kind, ctx.params.ref ?? "");
    if (!input) return notFound();
    const etag = `"${createHash("sha256").update(JSON.stringify(input)).digest("hex")}"`;
    const headers = {
      etag,
      "cache-control": "public, max-age=300",
      "content-type": "image/svg+xml; charset=utf-8",
      "x-content-type-options": "nosniff",
      "referrer-policy": "same-origin",
      "content-security-policy":
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; style-src 'unsafe-inline'",
    };
    if (ctx.request.headers.get("if-none-match") === etag)
      return new Response(null, { status: 304, headers });
    return new Response(renderCard(input), { headers });
  };
}
