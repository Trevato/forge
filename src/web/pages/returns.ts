/**
 * `/board/returns`: the board's tokens line, opened — what the window's
 * dollars bought. Spent and landed first, then what did not land and why,
 * then the issues that cost the most with what came of each. Owner facts
 * only (`actions/returns.ts`); `?apps=` narrows as on the board, `?days=`
 * widens the window.
 */

import { readReturns, returnsRepos } from "../../actions/returns.ts";
import type { Money } from "../../core/returns.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { getReposByIds } from "../../core/repos.ts";
import type { Ctx } from "../../http/context.ts";
import { notFoundPage, signInFirst } from "../chrome.ts";
import { html, type Html } from "../html.ts";
import { page } from "../layout.ts";
import { row } from "../ui.ts";
import { usd } from "../../core/money.ts";

const runs = (m: Money): string => `${m.runs} ${m.runs === 1 ? "run" : "runs"}`;

const line = (title: string, m: Money, note?: string): Html =>
  row({
    title,
    meta: html`${runs(m)}${note === undefined ? "" : ` · ${note}`}`,
    trail: html`<b>${usd(m.usd)}</b>`,
  });

/** A plain section under its own h2, rows in a list; no card (#9896). */
const section = (id: string, heading: string, rows: Html[], note?: string): Html =>
  html`<section class="stack" aria-labelledby="${id}">
    <h2 id="${id}">${heading}</h2>
    ${note === undefined ? null : html`<p class="muted small">${note}</p>`}
    <ul class="list">
      ${rows}
    </ul>
  </section>`;

/** GET /board/returns */
export function returnsPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const user = ctx.auth.user;
  if (!user) return signInFirst(ctx);
  const q = ctx.url.searchParams;
  const days = q.has("days") ? Number(q.get("days")) : undefined;
  // `?apps=` is the board's: one app narrows to it, as the board does.
  const apps = (q.get("apps") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const mine = timePhase(ctx.request, "repos", () => returnsRepos(ctx.app, user));
  const named =
    apps.length === 1
      ? (mine.find(
          (r) =>
            `${r.ownerName}/${r.name}`.toLowerCase() ===
              apps[0]!.toLowerCase() ||
            r.name.toLowerCase() === apps[0]!.toLowerCase(),
        ) ?? null)
      : undefined;
  if (named === null) return notFoundPage(ctx);
  const read = timePhase(ctx.request, "returns", () =>
    readReturns(ctx.app, user, {
      ...(days === undefined ? {} : { days }),
      ...(named === undefined
        ? {}
        : { repo: `${named.ownerName}/${named.name}` }),
    }),
  );
  if (!read.ok) return notFoundPage(ctx);
  const r = read.value;
  const span = days ?? 7;
  const repos = timePhase(ctx.request, "names", () =>
    getReposByIds(
      ctx.app.db,
      r.costliest.map((c) => c.repoId),
    ),
  );
  const rendering = performance.now();
  const nothing = r.landedNothing;
  const body = html`<h1 id="returns-title">
      What the tokens bought, ${span} days
    </h1>
    <p class="muted">
      ${usd(r.spent.usd)} over ${runs(r.spent)} · ${r.landed} changes landed ·
      ${r.onLanded.perChange.changes === 0
        ? null
        : html`${usd(r.onLanded.perChange.median)} a landed change (median),
            ${usd(r.onLanded.usd)} in all ·`}
      ${usd(nothing.closed.usd)} closed with nothing · ${usd(nothing.open.usd)} still open
    </p>
    <div class="stack">
      ${section(
        "returns-where",
        "Where it went",
        [
          line(
            "On work that landed",
            r.onLanded,
            `${r.onLanded.perChange.changes} changes`,
          ),
          line("On work closed without a merge", nothing.closed),
          line("On work still open, nothing merged yet", nothing.open),
        ],
      )}
      ${section(
        "returns-not-landed",
        "What did not land, and why",
        [
          line("Runs that failed", nothing.failed),
          // Reasons are a part of "Runs that failed", not beside it: said so.
          ...nothing.topFailures.map((f) => line(`of which: ${f.reason}`, f)),
          line("Runs cancelled", nothing.cancelled),
        ],
      )}
      ${r.byPillar.length === 0
        ? null
        : section(
            "returns-by-pillar",
            "By pillar",
            r.byPillar.map((b) =>
              row({
                title: b.pillar,
                meta: html`${runs(b)} · ${b.changes}
                ${b.changes === 1 ? "change" : "changes"} landed${b.changes === 0
                  ? ""
                  : ` · ${usd(b.perChange)} a change`} ·
                ${usd(b.closed.usd)} closed with nothing · ${usd(b.open.usd)} still open`,
                trail: html`<b>${usd(b.usd)}</b>`,
              }),
            ),
          )}
      ${section(
        "returns-costliest",
        "What cost the most",
        r.costliest.map((c) => {
          const repo = repos.get(c.repoId);
          const slug = repo ? `${repo.ownerName}/${repo.name}` : "";
          return row({
            href: `/${slug}/issues/${c.number}`,
            title: html`#${c.number} ${c.title}`,
            meta: html`${slug} · ${runs(c)} ·
            ${c.outcome === "landed"
              ? "landed"
              : c.outcome === "closed"
                ? "closed with nothing merged"
                : "nothing merged yet"}`,
            trail: html`<b>${usd(c.usd)}</b>`,
          });
        }),
      )}
      ${r.outside.length === 0
        ? null
        : section(
            "returns-outside",
            "Reported from outside",
            r.outside.map((o) =>
              row({
                title: o.who,
                meta: html`${o.reports} ${o.reports === 1 ? "report" : "reports"} ·
                  ${(o.tokensIn + o.tokensOut).toLocaleString("en-US")} tokens`,
                trail: html`<b>${usd(o.usd)}</b>`,
              }),
            ),
            "what sessions the forge did not run say they spent; not in the figures above",
          )}
      <section class="stack" aria-labelledby="returns-run">
        <h2 id="returns-run">A run</h2>
        <p>
          A run that finished well costs ${usd(r.okRun.usd.median)} and takes
          ${r.okRun.minutes.median} minutes (median); one in ten costs over
          ${usd(r.okRun.usd.p90)} or runs over ${r.okRun.minutes.p90} minutes.
        </p>
      </section>
    </div>`;
  const response = page({ ctx, title: "What the tokens bought", body });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}
