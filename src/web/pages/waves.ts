/**
 * A repository's waves, as a page: `waves/*.md` on the default branch, newest
 * version first, each line linking to its file. Reading is `story/waves.ts`'s.
 *
 * Visibility is the repository's: `loadRepo` answers an outsider exactly as
 * it does for any other page of a private repository.
 */

import { notePhase, takeSessionTime, timePhase, timePhaseAsync } from "../../core/route_timing.ts";
import { repoDir } from "../../git/repos.ts";
import type { Ctx } from "../../http/context.ts";
import { VERSION } from "../../story/wave.ts";
import { readWave, readWaves } from "../../story/waves.ts";
import { loadRepo, notFoundPage, repoBase, scopeHeader } from "../chrome.ts";
import { html } from "../html.ts";
import { page } from "../layout.ts";
import { empty, listCard, row } from "../ui.ts";
import { localScope } from "../scope.ts";

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
      ? row({
          href: fileHref(e.file),
          title: e.wave.headline,
          meta: html`${e.wave.version} · ${e.wave.date}`,
        })
      : row({
          href: fileHref(e.file),
          title: e.file,
          meta: html`Not a wave: ${e.reason}`,
        }),
  );

  const body = html`${scopeHeader(ctx, scope, "code", { compact: true })}
    <div class="mt">
      ${entries.length === 0
        ? empty({ title: "No waves yet", note: "This repository has no waves/ directory." })
        : listCard(rows, { head: html`<h2>Waves</h2>` })}
    </div>`;

  const response = page({
    ctx,
    title: `Waves · ${scope.facts.name}`,
    crumbs: scope.crumbs,
    palette: scope.palette,
    body,
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

/** Only http(s) becomes a link; anything else is shown as plain text. */
export const webUrl = (s: string): boolean => /^https?:\/\//i.test(s);

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
        <h2>Pulls</h2>
        <ul>
          ${entry.wave.pulls.map((p) =>
            webUrl(p.url)
              ? html`<li><a href="${p.url}" rel="noopener noreferrer">${p.title}</a></li>`
              : html`<li>${p.title}</li>`,
          )}
        </ul>`
    : html`<h1>${entry.file}</h1>
        <p class="muted">Not a wave: ${entry.reason}</p>`;

  const body = html`${scopeHeader(ctx, scope, "code", { compact: true })}
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
