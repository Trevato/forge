/**
 * Flows (#9434): `/:owner/:name/flows` is one picture per repository — what
 * flows in (origin, followed sources, pinned packages with their newest
 * release) on one side and what flows out (forks, mirrors) on the other,
 * each with its state and when it last moved. An admin can ask the radar to
 * read upstream now. Server-rendered, no script; the read is from state the
 * forge keeps, so it answers without the network or a model.
 */

import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { readRadar } from "../../flows/radar.ts";
import { pinsOf } from "../../flows/run.ts";
import { probeLinks } from "../../flows/probe.ts";
import { mayStartRadar, startRadar } from "../../flows/start.ts";
import { readFlows, type FlowAction, type FlowLine, type Health } from "../../flows/view.ts";
import type { Ctx } from "../../http/context.ts";
import { crumbsFor, loadRepo, notFoundPage, pageHead, repoBase, repoHeader, repoPalette } from "../chrome.ts";
import { readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { badge, btn, type Tone, card, listCard, row, time } from "../ui.ts";

const lineRow = (l: FlowLine): Html =>
  row({
    ...(l.href === "" ? {} : { href: l.href }),
    title: html`${l.label}`,
    meta: html`${l.at === null ? "never moved" : time(l.at)}`,
    trail: badge(l.state, { tone: TONE[l.health] }),
  });

/** A link's tone from its health: `attn` and `danger` are Tone values the badge already has. */
const TONE: Record<Health, Tone> = {
  ok: "default", behind: "attn", diverged: "danger", unread: "danger", stale: "attn", off: "default", none: "default",
};

const actionForm = (a: FlowAction): Html =>
  a.post
    ? html`<form method="post" action="${a.href}" class="mt">${btn(a.label, { variant: "secondary" })}</form>`
    : html`<p class="mt">${btn(a.label, { variant: "secondary", href: a.href })}</p>`;

function side(title: string, lines: readonly Html[], empty: string): Html {
  return card(lines.length === 0 ? html`<p class="muted">${empty}</p>` : listCard([...lines]), { head: html`${title}`, pad: lines.length === 0 });
}

// GET /:owner/:name/flows
export async function flowsPage(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const rendering = performance.now();
  const flows = readFlows(ctx.app.db, repo, ctx.auth.user);
  const deps = readRadar(ctx.app.db, repo.id, await pinsOf(ctx.app, repo));
  const admin = mayStartRadar(ctx.app, repo, ctx.auth.user);
  const actions = flows.inbound.flatMap((l) => (l.action ? [actionForm(l.action)] : []));
  const depRows = deps.map((d) =>
    row({
      title: html`${d.name}`,
      meta: html`${d.pinned === "" ? d.range : `pinned ${d.pinned}`}${d.latest === "" ? "" : ` · newest ${d.latest}`}${d.checkedAt === null ? "" : html` · read ${time(d.checkedAt)}`}`,
      trail: badge(d.error !== "" ? "not read" : d.gap === "none" ? (d.checkedAt === null ? "not read yet" : "current") : `${d.gap} update`, {
        tone: d.error !== "" || d.gap === "major" ? "danger" : d.gap === "none" ? "default" : "attn",
      }),
    }),
  );
  const body = html`${repoHeader(ctx, repo, "flows")}
    ${pageHead("Flows", { sub: "What comes in on the left, what goes out on the right." })}
    <div class="split">
      <div>
        ${side("Flows in", flows.inbound.map(lineRow), "Nothing flows in: no origin and no followed source.")}
        ${actions}
        ${side("Packages", depRows, "No pinned packages.")}
      </div>
      <div>${side("Flows out", flows.outbound.map(lineRow), "Nothing flows out: no forks and no mirror.")}</div>
    </div>
    ${admin
      ? html`<form method="post" action="${repoBase(repo)}/flows/probe" class="mt">${btn("Compare heads now", { variant: "secondary" })}</form>
        <form method="post" action="${repoBase(repo)}/flows/check" class="mt">${btn("Read upstream releases now", { variant: "secondary" })}</form>`
      : null}`;
  const response = page({ ctx, title: `Flows · ${repo.name}`, crumbs: crumbsFor(repo), palette: repoPalette(ctx, repo), body });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

// POST /:owner/:name/flows/check
export async function flowsCheck(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const back = `${repoBase(repo)}/flows`;
  const started = await startRadar(ctx.app, repo, ctx.auth.user);
  if (!started.ok) return flashTo(ctx, back, { tone: "danger", message: started.why });
  const n = started.read;
  return flashTo(ctx, back, { message: n === 0 ? "No exact pins to read." : `Read upstream for ${n} ${n === 1 ? "package" : "packages"}.` });
}

// POST /:owner/:name/flows/probe
export async function flowsProbe(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const back = `${repoBase(repo)}/flows`;
  const probed = await probeLinks(ctx.app, repo, ctx.auth.user);
  if (!probed.ok) return flashTo(ctx, back, { tone: "danger", message: probed.why });
  const n = probed.read;
  return flashTo(ctx, back, { message: n === 0 ? "No link could be compared." : `Compared ${n} ${n === 1 ? "link" : "links"}.` });
}
