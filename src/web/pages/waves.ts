/**
 * A repository's waves, as a page: `waves/*.md` on the default branch, newest
 * version first, each line linking to its file. Reading is `story/waves.ts`'s.
 *
 * Visibility is the repository's: `loadRepo` answers an outsider exactly as
 * it does for any other page of a private repository.
 */

import { canAdmin, canRead, getRepo } from "../../core/repos.ts";
import { notFound } from "../../http/respond.ts";
import { holds, stamp, xml } from "../feeds.ts";
import { STARTED } from "../started.ts";
import { notePhase, takeSessionTime, timePhase, timePhaseAsync } from "../../core/route_timing.ts";
import { repoDir } from "../../git/repos.ts";
import type { Ctx } from "../../http/context.ts";
import { VERSION, type Wave } from "../../story/wave.ts";
import { movedForViewer } from "../../story/wave_moved.ts";
import { carriedPulls, pullPath } from "../../story/wave_pulls.ts";
import { fromWave, pullRefs, readWave, readWaves } from "../../story/waves.ts";
import { NO_WAVES } from "../../story/words.ts";
import { loadRepo, notFoundPage, repoBase, scopeHeader } from "../chrome.ts";
import { escapeHtml, html } from "../html.ts";
import { page } from "../layout.ts";
import { btn, empty, listCard, pill, row } from "../ui.ts";
import { localScope } from "../scope.ts";
import { milestoneHref, planFor, progress } from "./milestones.ts";

/**
 * A wave's headline is the writer's words, so a row lets it wrap (a long word
 * breaks anywhere) instead of the list's one-line ellipsis, and the page
 * never scrolls sideways at 390 px. Scoped to `[data-waves]`; no new class.
 */
export const WAVES_CSS = `[data-waves] { overflow-wrap: anywhere; }
[data-waves] .row-title, [data-waves] .row-meta { white-space: normal; overflow: visible; text-overflow: clip; }
[data-waves] .row { align-items: flex-start; }`;

const WHAT_A_WAVE =
  "A wave is a release note in waves/<version>.md that names its highlights and the pulls merged since the last one.";

/** A wave's row title: `<version> · <date> · <headline> · N pulls`, N being the pulls this viewer can see. */
export function waveLine(w: Wave, visible: number): string {
  return `${w.version} · ${w.date} · ${w.headline} · ${visible} ${visible === 1 ? "pull" : "pulls"}`;
}

/** One wave on the list: its headline, the first highlight's why as the one sentence under it, and version, date and pull count as a muted trail. */
export function waveRow(w: Wave, href: string, visible: number) {
  const why = w.highlights[0]?.why;
  return row({
    href,
    nav: true,
    title: w.headline,
    ...(why === undefined || why === "" ? {} : { meta: html`${why}` }),
    trail: html`<span class="muted small">${w.version} · ${w.date} · ${visible} ${visible === 1 ? "pull" : "pulls"}</span>`,
  });
}

// GET /:owner/:name/waves
export async function wavesPage(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const repo = timePhase(ctx.request, "repo", () => loadRepo(ctx));
  if (!repo) return notFoundPage(ctx);
  const scope = localScope(ctx, repo);
  const branch = repo.defaultBranch;
  const entries = await timePhaseAsync(ctx.request, "waves", () =>
    readWaves(repoDir(ctx.app.reposRoot, repo.ownerName, repo.name), branch),
  );
  const rendering = performance.now();
  const fileHref = (file: string): string =>
    VERSION.test(file.slice(0, -3))
      ? `${repoBase(repo)}/waves/${encodeURIComponent(file.slice(0, -3))}`
      : `${repoBase(repo)}/blob/${encodeURIComponent(branch)}/waves/${encodeURIComponent(file)}`;

  const rows = entries.map((e) =>
    e.ok
      ? waveRow(
          e.wave,
          fileHref(e.file),
          // The wave's own page lists these same pulls, so the two agree.
          carriedPulls(ctx.app.db, pullRefs(e.wave), ctx.auth.user).length,
        )
      : row({
          href: fileHref(e.file),
          nav: true,
          title: e.file,
          meta: html`Not a wave: ${e.reason}`,
        }),
  );

  const body = html`${scopeHeader(ctx, scope, "none", { compact: true })}
    <div class="mt" data-waves>
      <h1 class="sr-only">Waves</h1>
      ${entries.length === 0
        ? empty({
            title: "No waves yet",
            note: `${WHAT_A_WAVE} ${NO_WAVES}`,
            ...(canAdmin(ctx.app.db, repo, ctx.auth.user)
              ? {
                  action: html`<form method="post" action="${repoBase(repo)}/settings/wave">
                    ${btn("Cut a wave", { variant: "primary" })}
                  </form>`,
                }
              : {}),
          })
        : html`<ul class="list">
            ${rows}
          </ul>`}
    </div>`;

  const response = page({
    ctx,
    title: `Waves · ${scope.facts.name}`,
    crumbs: scope.crumbs,
    palette: scope.palette,
    body,
    styleCss: WAVES_CSS,
    feed: {
      href: `${repoBase(repo)}/waves.atom`,
      title: `${repo.ownerName}/${repo.name} waves`,
    },
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

const FEED_ENTRIES = 50;

// GET /:owner/:name/waves.atom
export async function wavesAtom(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const repo = getRepo(ctx.app.db, ctx.params["owner"]!, ctx.params["name"]!);
  if (!repo || !canRead(ctx.app.db, repo, ctx.auth.user)) return notFound();
  const waves = (
    await timePhaseAsync(ctx.request, "waves", () =>
      readWaves(repoDir(ctx.app.reposRoot, repo.ownerName, repo.name), repo.defaultBranch),
    )
  )
    .flatMap((e) => (e.ok ? [e.wave] : []))
    .slice(0, FEED_ENTRIES);
  const base = `${ctx.url.origin}/${repo.ownerName}/${repo.name}`;
  const updatedAt = (date: string): string => stamp(`${date}T00:00:00`);
  // The newest wave names the tag; the content hash covers edits to it.
  const newest = waves[0];
  const shown = Bun.hash(JSON.stringify([repo.ownerName, repo.name, repo.description, waves]))
    .toString(36);
  const etag = `W/"${newest?.version ?? "none"}.${shown}"`;
  const cacheControl = repo.visibility === "public" ? "public, max-age=300" : "private, no-store";
  const vary = "authorization, cookie";
  if (holds(ctx.request.headers.get("if-none-match"), etag))
    return new Response(null, { status: 304, headers: { etag, "cache-control": cacheControl, vary } });
  const renderStart = performance.now();
  const entries = waves.map((w) => {
    const summary = `<ul>${w.highlights
      .map((h) => `<li><strong>${escapeHtml(h.title)}</strong> — ${escapeHtml(h.why)}</li>`)
      .join("")}</ul>`;
    const link = `${base}/waves/${encodeURIComponent(w.version)}`;
    return `  <entry>
    <id>urn:forge:wave:${xml(repo.id)}:${xml(w.version)}</id>
    <title>${xml(w.headline)}</title>
    <updated>${xml(updatedAt(w.date))}</updated>
    <link rel="alternate" type="text/html" href="${xml(link)}"/>
    <summary type="html">${xml(summary)}</summary>
  </entry>`;
  });
  const body = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${xml(base)}/waves.atom</id>
  <title>${xml(`${repo.ownerName}/${repo.name} waves`)}</title>
  <subtitle>${xml(repo.description === "" ? "Waves" : repo.description)}</subtitle>
  <updated>${xml(newest ? updatedAt(newest.date) : STARTED)}</updated>
  <link rel="self" type="application/atom+xml" href="${xml(base)}/waves.atom"/>
  <link rel="alternate" type="text/html" href="${xml(base)}/waves"/>
  <generator>forge</generator>
${entries.join("\n")}
</feed>
`;
  notePhase(ctx.request, "render", performance.now() - renderStart);
  return new Response(body, {
    headers: {
      "content-type": "application/atom+xml; charset=utf-8",
      "cache-control": cacheControl,
      etag,
      vary,
    },
  });
}

// GET /:owner/:name/waves/:version
export async function wavePage(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const repo = timePhase(ctx.request, "repo", () => loadRepo(ctx));
  if (!repo) return notFoundPage(ctx);
  const entry = await timePhaseAsync(ctx.request, "wave", () =>
    readWave(
      repoDir(ctx.app.reposRoot, repo.ownerName, repo.name),
      repo.defaultBranch,
      ctx.params.version ?? "",
    ),
  );
  if (!entry) return notFoundPage(ctx);
  const carried = entry.ok
    ? timePhase(ctx.request, "pulls", () =>
        carriedPulls(ctx.app.db, pullRefs(entry.wave), ctx.auth.user),
      )
    : [];
  const moved = entry.ok
    ? timePhase(ctx.request, "moved", () =>
        movedForViewer({
          db: ctx.app.db,
          repo,
          refs: pullRefs(entry.wave),
          viewer: ctx.auth.user,
          plan: () => planFor(ctx, repo, false, new Date()),
        }),
      )
    : [];
  const rendering = performance.now();
  const scope = localScope(ctx, repo);
  const back = html`<a href="${repoBase(repo)}/waves">All waves</a>`;

  const content = entry.ok
    ? html`<h1>${entry.wave.headline}</h1>
        <p class="muted">${entry.wave.version} · ${entry.wave.date}</p>
        <h2>Highlights</h2>
        <ul>
          ${entry.wave.highlights.map(
            (h) => html`<li><strong>${h.title}</strong> — ${h.why}</li>`,
          )}
        </ul>
        ${moved.length === 0
          ? ""
          : listCard(
              moved.map((m) =>
                row({
                  href: milestoneHref(repoBase(repo), m.number),
                  title: m.title,
                  meta: progress(m.done, m.total, `${m.done} of ${m.total} done`),
                  trail: pill(`${m.done} of ${m.total} done`),
                }),
              ),
              { head: html`<h2>Moved</h2>` },
            )}
        ${carried.length === 0
          ? html`<p class="muted">No pulls to show here.</p>`
          : listCard(
              carried.map((p) =>
                row({
                  href: `${pullPath(p)}${fromWave(repo.ownerName, repo.name, entry.wave.version)}`,
                  title: html`#${p.number} ${p.title}`,
                  meta: html`${p.mergedAt === null ? p.state : `merged ${p.mergedAt.slice(0, 10)}`}`,
                  state: p.mergedAt === null ? p.state : ("merged" as const),
                }),
              ),
              { head: html`<h2>Pulls</h2>` },
            )}`
    : html`<h1>${entry.file}</h1>
        <p class="muted">Not a wave: ${entry.reason}</p>`;

  const body = html`${scopeHeader(ctx, scope, "none", { compact: true })}
    <div class="mt">${content}<p>${back}</p></div>`;

  const response = page({
    ctx,
    title: `${entry.ok ? entry.wave.version : entry.file} · Waves · ${scope.facts.name}`,
    crumbs: scope.crumbs,
    palette: scope.palette,
    body,
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}
