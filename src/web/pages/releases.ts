/**
 * Releases: each kept release of the forge's own code with its short sha, the
 * pull that landed it, when, and — for the one serving — since when it has
 * been healthy. A writer of the forge's repository gets a Roll back button on
 * a kept release whose schema is not behind the live database's; the POST
 * goes through the same refusals and the same health-read swap as
 * `--rollback`, then this process drains.
 */

import { existsSync } from "node:fs";
import { canRead, canWrite, getRepo, getRepoById, type Repo } from "../../core/repos.ts";
import type { User } from "../../core/users.ts";
import { running } from "../../kernel/version.ts";
import type { Ctx } from "../../http/context.ts";
import { listReleases, type Release } from "../../release/record.ts";
import { releaseDir } from "../../release/checkout.ts";
import { liveSchema, releaseSchema, rollback } from "../../release/rollback.ts";
import { beginSwap, endSwap, handover } from "../../release/swap.ts";
import { notFoundPage, signInFirst } from "../chrome.ts";
import { readForm } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { badge, btn, card, empty, sha, time } from "../ui.ts";

/** When this process began serving: "healthy since" for the release it runs. */
const BOOTED = new Date().toISOString();

/** The forge's own code repository, when this forge names one. */
function forgeRepoOf(ctx: Ctx): Repo | undefined {
  const named = ctx.app.config.forgeRepo;
  if (named === undefined) return undefined;
  const [owner, name] = named.split("/");
  return owner === undefined || name === undefined ? undefined : getRepo(ctx.app.db, owner, name);
}

/** Who may see the release history: the forge repository's readers and a site admin. */
function mayRead(ctx: Ctx, user: User | undefined): boolean {
  if (user === undefined) return false;
  if (user.isAdmin) return true;
  const repo = forgeRepoOf(ctx);
  return repo !== undefined && canRead(ctx.app.db, repo, user);
}

function mayRollBack(ctx: Ctx, user: User | undefined): boolean {
  // Undoing a deployment is a person's decision, as a revert is (#1824).
  if (user === undefined || user.kind === "agent") return false;
  const repo = forgeRepoOf(ctx);
  return repo !== undefined && canWrite(ctx.app.db, repo, user);
}

/** "live: <sha> since <time>" for the home, or nothing when no release is known to be live. */
export function liveLine(ctx: Ctx): Html | undefined {
  const live = running().commit;
  if (live === null || !mayRead(ctx, ctx.auth.user)) return undefined;
  return html`<p class="small muted" id="live-release">
    <a href="/releases">live: <span class="sha">${live.slice(0, 7)}</span> since ${time(BOOTED)}</a>
  </p>`;
}

async function canRollBackTo(ctx: Ctx, r: Release): Promise<boolean> {
  const dataDir = ctx.app.config.dataDir;
  const dir = releaseDir(dataDir, r.sha);
  if (!r.ok || !/^[0-9a-f]{40}$/.test(r.sha) || !existsSync(dir)) return false;
  const known = await releaseSchema(dir);
  return known !== undefined && known >= liveSchema(dataDir);
}

function pullCell(ctx: Ctx, r: Release): Html {
  if (r.pullNumber === null) return html`—`;
  const repo = getRepoById(ctx.app.db, r.repoId);
  return repo === undefined
    ? html`#${r.pullNumber}`
    : html`<a href="/${repo.ownerName}/${repo.name}/pulls/${r.pullNumber}">#${r.pullNumber}</a>`;
}

export async function releasesPage(ctx: Ctx): Promise<Response> {
  const user = ctx.auth.user;
  if (user === undefined) return signInFirst(ctx);
  if (!mayRead(ctx, user)) return notFoundPage(ctx);
  const releases = listReleases(ctx.app.db);
  const live = running().commit;
  const writer = mayRollBack(ctx, user);
  const rows: Html[] = [];
  for (const r of releases) {
    const isLive = live !== null && r.sha === live;
    const button = writer && !isLive && (await canRollBackTo(ctx, r));
    rows.push(html`<tr>
      <td>${sha(r.sha)} ${when(isLive, () => badge("live", { tone: "success" }))}
        ${when(!r.ok, () => badge("preflight failed", { tone: "danger" }))}</td>
      <td>${pullCell(ctx, r)}</td>
      <td>${time(r.createdAt)}</td>
      <td>${isLive ? html`since ${time(BOOTED)}` : html`—`}</td>
      <td>${when(button, () =>
        html`<form method="post" action="/releases/${r.sha}/rollback">${btn("Roll back", { type: "submit" })}</form>`,
      )}</td>
    </tr>`);
  }
  const body =
    rows.length === 0
      ? empty({ icon: "clock", title: "No releases yet", note: "A pull landed on the forge's own repository is recorded here." })
      : card(html`<table class="table">
          <thead><tr><th>Release</th><th>Pull</th><th>Landed</th><th>Healthy</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`);
  return page({
    ctx,
    title: "Releases",
    body: html`<div class="page-head"><h1>Releases</h1></div>${body}`,
  });
}

export async function rollbackSubmit(ctx: Ctx): Promise<Response> {
  const user = ctx.auth.user;
  if (user === undefined) return new Response("forbidden", { status: 403 });
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  if (!mayRollBack(ctx, user)) return new Response("forbidden", { status: 403 });
  const target = ctx.params["sha"] ?? "";
  const refuse = (message: string): Response =>
    flashTo(ctx, "/releases", { tone: "danger", message });
  if (!/^[0-9a-f]{40}$/.test(target)) return notFoundPage(ctx);
  const drain = handover.drain;
  const port = ctx.app.config.port ?? 0;
  if (ctx.app.config.selfSwap !== true || drain === undefined || port <= 0)
    return refuse("This forge does not swap releases itself (FORGE_SELF_SWAP is off).");
  const turn = beginSwap();
  if (!turn.ok) return refuse(`Not rolled back: ${turn.line}.`);
  const result = await rollback({ dataDir: ctx.app.config.dataDir, sha: target, port, env: process.env });
  endSwap(result.ok);
  if (!result.ok) return refuse(`Not rolled back: ${result.line}.`);
  ctx.app.log.info("rolled back; draining this process", { sha: target.slice(0, 12), by: user.username });
  drain();
  return flashTo(ctx, "/releases", { message: `Rolled back to ${target.slice(0, 7)}; it reads healthy.` });
}
