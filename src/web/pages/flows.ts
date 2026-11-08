/**
 * Flows (#9434): `/:owner/:name/flows` is one picture per repository — what
 * flows in (origin, followed sources, pinned packages with their newest
 * release) on one side and what flows out (forks, mirrors) on the other,
 * each with its state and when it last moved. An admin can ask the radar to
 * read upstream now. Server-rendered, no script; the read is from state the
 * forge keeps, so it answers without the network or a model.
 */

import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { canWrite } from "../../core/repos.ts";
import { askUpdate, worthTaking } from "../../flows/file.ts";
import { depState, readRadar } from "../../flows/radar.ts";
import { pinsOf } from "../../flows/run.ts";
import { probeLinks } from "../../flows/probe.ts";
import { mayStartRadar, startRadar } from "../../flows/start.ts";
import { readFlows, type FlowAction, type FlowLine, type Health } from "../../flows/view.ts";
import type { Ctx } from "../../http/context.ts";
import { crumbsFor, loadRepo, notFoundPage, pageHead, repoBase, repoHeader, repoPalette } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { badge, btn, type Tone, card, listCard, row, time } from "../ui.ts";

const lineRow = (l: FlowLine): Html =>
  row({
    ...(l.action ? { after: actionForm(l.action) } : {}),
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
    ? html`<form method="post" action="${a.href}" class="inline">${Object.entries(a.fields ?? {}).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}" />`)}${btn(a.label, { size: "sm", variant: "secondary" })}</form>`
    : html`${btn(a.label, { size: "sm", variant: "secondary", href: a.href })}`;

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
  const writer = ctx.auth.user !== undefined && ctx.auth.user.kind !== "agent" && canWrite(ctx.app.db, repo, ctx.auth.user);
  const depRows = deps.map((d) =>
    row({
      title: html`${d.name}`,
      meta: html`${d.pinned === "" ? d.range : `pinned ${d.pinned}`}${d.latest === "" ? "" : ` · newest ${d.latest}`}${d.checkedAt === null ? "" : html` · read ${time(d.checkedAt)}`}${d.advisory === "" ? "" : html` · advisory: ${d.advisory}`}`,
      trail: badge(depState(d).label, { tone: depState(d).tone }),
      ...(writer && worthTaking(d)
        ? { after: actionForm({ label: "Update this dependency", href: `${repoBase(repo)}/flows/update`, post: true, fields: { name: d.name } }) }
        : {}),
    }),
  );
  const body = html`${repoHeader(ctx, repo, "flows")}
    ${pageHead("Flows", { sub: "What comes in on the left, what goes out on the right." })}
    <div class="split">
      <div>
        ${side("Flows in", flows.inbound.map(lineRow), "Nothing flows in: no origin and no followed source.")}
        ${side("Packages", depRows, "No pinned packages.")}
      </div>
      <div>${side("Flows out", flows.outbound.map(lineRow), "Nothing flows out: no forks, no mirror and no forge follows.")}</div>
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

// POST /:owner/:name/flows/update
export async function flowsUpdate(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const back = `${repoBase(repo)}/flows`;
  const asked = askUpdate(ctx.app, repo, ctx.auth.user, readRadar(ctx.app.db, repo.id, await pinsOf(ctx.app, repo)), field(form, "name"));
  if (!asked.ok) return flashTo(ctx, back, { tone: "danger", message: asked.why });
  if (asked.filed === null) return flashTo(ctx, back, { message: "Nothing to file: an update is already open, or none is worth taking." });
  const where = `${repoBase(repo)}/issues/${asked.filed}`;
  return flashTo(ctx, where, { message: repo.autonomy === "autonomous" ? "Filed for the crew, who will propose a pull." : "Filed as an issue." });
}
