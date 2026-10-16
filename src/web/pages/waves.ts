/**
 * A repository's waves, as a page: `waves/*.md` on the default branch, newest
 * version first, each line linking to its file. Reading is `story/waves.ts`'s.
 *
 * Visibility is the repository's: `loadRepo` answers an outsider exactly as
 * it does for any other page of a private repository.
 */

import { repoDir } from "../../git/repos.ts";
import type { Ctx } from "../../http/context.ts";
import { readWaves } from "../../story/waves.ts";
import { loadRepo, notFoundPage, repoBase, scopeHeader } from "../chrome.ts";
import { html } from "../html.ts";
import { page } from "../layout.ts";
import { empty, listCard, row } from "../ui.ts";
import { localScope } from "../scope.ts";

// GET /:owner/:name/waves
export async function wavesPage(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const scope = localScope(ctx, repo);
  const branch = repo.defaultBranch;
  const entries = await readWaves(
    repoDir(ctx.app.reposRoot, repo.ownerName, repo.name),
    branch,
  );
  const fileHref = (file: string): string =>
    `${repoBase(repo)}/blob/${encodeURIComponent(branch)}/waves/${encodeURIComponent(file)}`;

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

  return page({
    ctx,
    title: `Waves · ${scope.facts.name}`,
    crumbs: scope.crumbs,
    palette: scope.palette,
    body,
  });
}
