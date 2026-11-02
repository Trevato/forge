/**
 * A client's first screen (#1812): signed in on a forge that was made for
 * them, the home is their apps, each in one plain sentence and one more that
 * says whether its agents are working or waiting. No map, board or settings
 * until asked (`/?all=1` is the whole home). Words only a developer knows
 * stay off it; `test/client-home.test.ts` holds the list.
 */

import { notePhase, takeSessionTime, timePhase, timePhaseAsync } from "../../core/route_timing.ts";
import { clientAppRows, clientDoings, clientFinished, doingLine, finishedLine } from "../../core/client-apps.ts";
import type { User } from "../../core/users.ts";
import type { Ctx } from "../../http/context.ts";
import { mayDirectCrew } from "../../crew/direct.ts";
import { repoBase } from "../chrome.ts";
import { html, type Html } from "../html.ts";
import { btn, card } from "../ui.ts";

/** The sentence about the agents, from how many are going and how many are lined up. */
export function agentsLine(working: number, queued: number): string {
  if (working > 0)
    return working === 1
      ? "One agent is working on it now."
      : `${working} agents are working on it now.`;
  if (queued > 0) return "Its agents are about to start.";
  return "Its agents are waiting for something to do.";
}

/** The card of apps; an empty one says they will appear. The caller decides who is a client. */
export async function clientApps(ctx: Ctx, user: User): Promise<Html> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const apps = await timePhaseAsync(ctx.request, "apps", () => clientAppRows(ctx.app, user));
  const now = new Date();
  const doings = timePhase(ctx.request, "doing", () =>
    clientDoings(ctx.app.db, apps.map((a) => a.repo.id)),
  );
  const finished = timePhase(ctx.request, "finished", () =>
    clientFinished(ctx.app.db, apps.map((a) => a.repo.id)),
  );
  const rendering = performance.now();
  const rows = apps.map(({ repo, working, queued, live }) => {
    const doing = doingLine(doings.get(repo.id));
    const done = finishedLine(finished.get(repo.id), now.getTime());
    const about = repo.description !== "" ? repo.description : "An app of yours.";
    // The tell form with this app chosen; it sends the person back to `/`.
    const ask = mayDirectCrew(ctx.app.db, repo, user)
      ? btn("Ask for something", {
          href: `${repoBase(repo)}/tell?from=/&ask=1`,
          variant: "outline",
        })
      : null;
    // The running app, by the way the apps page opens it; an app that is not up offers nothing.
    const open =
      live === undefined
        ? null
        : btn("Open", { href: `${repoBase(repo)}/app/production/open`, variant: "outline" });
    return html`<li class="client-app">
      <div class="bar">
        <a href="${repoBase(repo)}"><b>${repo.name}</b></a> ${open} ${ask}
      </div>
      <span class="client-app-about">${about}</span>
      <span class="client-app-agents muted" data-agents="${working > 0 ? "working" : "waiting"}"
        >${agentsLine(working, queued)}</span
      >
      ${done !== "" ? html`<span class="client-app-finished muted">${done}</span>` : ""}
      ${doing !== "" ? html`<span class="client-app-doing muted">${doing}</span>` : ""}
    </li>`;
  });
  const shown = card(
    rows.length === 0
      ? html`<p class="muted">Your apps will appear here.</p>`
      : html`<ul class="list client-apps">
          ${rows}
        </ul>`,
    {
      id: "client-apps",
      head: html`<h2>Your apps</h2>`,
      attrs: html`data-live="run.*" data-live-src="/live/client-apps"`,
    },
  );
  notePhase(ctx.request, "render", performance.now() - rendering);
  return shown;
}
