/**
 * `/family`: the forge-level family (#425). The forge this one was spawned
 * from, this forge, and the forges it sent, each with how it stands as it
 * last reported (`spawn/heartbeat.ts`). Nested lists, like the repository
 * family tree, bounded in depth and count. Anyone may see the parent; only
 * this forge's admins see its children. A child that stopped reporting
 * reads "quiet": a fact about the clock, not a fault.
 */

import type { Ctx } from "../../http/context.ts";
import type { ChildAppsSummary } from "../../spawn/child-apps.ts";
import { familyView, type FamilyChild } from "../../spawn/family.ts";
import { hostedChildApps } from "../../spawn/host.ts";
import { MAX_DEPTH } from "../../spawn/heartbeat.ts";
import { pageHead } from "../chrome.ts";
import { html, type Html } from "../html.ts";
import { page } from "../layout.ts";
import { card, time } from "../ui.ts";

interface Node {
  readonly label: string;
  readonly href: string | null;
  readonly meta: readonly Html[];
  readonly badge: Html | null;
  readonly here?: boolean;
  readonly children: readonly Node[];
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

function standingNode(c: FamilyChild): Node {
  const meta: Html[] = [];
  if (c.state === "unheard") meta.push(html`has not reported yet`);
  else {
    if (c.lastSeen !== null)
      meta.push(html`last seen ${time(new Date(c.lastSeen).toISOString())}`);
    if (c.version !== null) meta.push(html`version ${c.version}`);
    if (c.behind !== null)
      meta.push(html`${c.behind === 0 ? "up to date" : `${plural(c.behind, "release")} behind`}`);
    if (c.openProposals !== null)
      meta.push(html`${plural(c.openProposals, "open proposal")}`);
    if (c.severedAt !== null) meta.push(html`follows nothing since ${c.severedAt.slice(0, 10)}`);
    else if (c.forgeTip !== null) meta.push(html`code at <span class="mono">${c.forgeTip.slice(0, 7)}</span>`);
    if (c.ownChildren !== null && c.ownChildren > 0)
      meta.push(html`${plural(c.ownChildren, "forge")} of its own`);
  }
  if (c.apps !== null) meta.push(html`<span data-apps>${c.apps}</span>`);
  return {
    label: c.name,
    href: c.url,
    meta,
    badge:
      c.state === "reporting"
        ? html`<span class="pill" data-tone="accent">reporting</span>`
        : c.state === "quiet"
          ? html`<span class="pill">quiet</span>`
          : null,
    children: [],
  };
}

function row(n: Node, depth: number): Html {
  const inner = html`<span class="row-main">
      <span class="row-title"
        >${n.label}${n.here ? html` <span class="lineage-here">you are here</span>` : null}</span
      >
      ${n.meta.length === 0
        ? null
        : html`<span class="row-meta"
            >${n.meta.map((m, i) => html`${i > 0 ? " · " : ""}${m}`)}</span
          >`}
    </span>
    ${n.badge === null ? null : html`<span class="row-trail">${n.badge}</span>`}`;
  return html`<li>
    ${n.href === null
      ? html`<div class="row">${inner}</div>`
      : html`<a class="row" href="${n.href}" rel="noopener noreferrer">${inner}</a>`}
    ${n.children.length === 0 || depth + 1 >= MAX_DEPTH
      ? null
      : html`<ul class="lineage-children">
          ${n.children.map((c) => row(c, depth + 1))}
        </ul>`}
  </li>`;
}

// GET /family
export async function familyPage(
  ctx: Ctx,
  appsOf: (app: Ctx["app"], name: string) => ChildAppsSummary | undefined = hostedChildApps,
): Promise<Response> {
  const app = ctx.app;
  const owns = ctx.auth.user?.isAdmin === true;
  const view = await familyView(app, owns, appsOf);
  const parent = view.parent;
  const kids = { items: view.children, more: view.more };

  const here: Node = {
    label: view.here.host ?? "this forge",
    href: null,
    meta: [html`version ${view.here.version}`],
    badge: null,
    here: true,
    children: kids.items.map(standingNode),
  };
  const root: Node =
    parent === null
      ? here
      : {
          label: parent.host,
          href: parent.url,
          meta:
            parent.behind === null
              ? []
              : [html`this forge is ${parent.behind === 0 ? "up to date" : plural(parent.behind, "release") + " behind"}`],
          badge: null,
          children: [here],
        };

  const alone = parent === null && kids.items.length === 0;
  return page({
    ctx,
    title: "Family",
    body: html`<div class="narrow-wide">
      ${pageHead("Family", {
        sub: "The forge this one came from, and the forges it sent. Children report in; nothing here reaches into one.",
      })}
      ${card(
        html`<ul class="list lineage" aria-label="Forges, by who sent whom">
            ${row(root, 0)}
          </ul>
          ${kids.more > 0
            ? html`<p class="muted small card-body">
                ${plural(kids.more, "more forge")} not shown.
              </p>`
            : null}
          ${alone
            ? html`<p class="muted small card-body">
                This forge has no parent and has sent none${owns ? "" : " that you can see"}.
              </p>`
            : null}`,
        { pad: false },
      )}
    </div>`,
  });
}
