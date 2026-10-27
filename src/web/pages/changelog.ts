/**
 * The changelog page: the releases `release/changelog.ts` reads, as rows
 * (version, date, and the pulls each carried). Public and server-rendered.
 */

import { notePhase, takeSessionTime, timePhaseAsync } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { forgeChangelog } from "../../release/changelog.ts";
import { html } from "../html.ts";
import { page } from "../layout.ts";
import { empty, listCard, row, time } from "../ui.ts";

// GET /changelog
export async function changelogPage(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const read = await timePhaseAsync(ctx.request, "releases", () => forgeChangelog(ctx.app));
  const rendering = performance.now();
  const repo = read?.repo;
  const entries = read?.entries ?? [];
  const rows = entries.map((e) =>
    row({
      id: e.version,
      href: `#${e.version}`,
      title: e.version,
      trail: time(e.date),
      meta: html`${e.pulls.length} ${e.pulls.length === 1 ? "pull" : "pulls"}`,
      children: e.pulls.map((p) =>
        row({
          href: `/${repo?.ownerName}/${repo?.name}/pulls/${p.number}`,
          title: p.title,
          trail: html`#${p.number}`,
        }),
      ),
    }),
  );
  const body = html`<div class="page-head"><h1>Changelog</h1></div>${entries.length === 0
    ? empty({ title: "No releases yet", note: "Each release lands here with its pulls." })
    : listCard(rows)}`;
  const response = page({ ctx, title: "Changelog", body });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}
