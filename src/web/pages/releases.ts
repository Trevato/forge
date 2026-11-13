/**
 * Releases: each kept release of the forge's own code with its short sha, the
 * pull that landed it, when, and — for the one serving — since when it has
 * been healthy. A writer of the forge's repository gets a Roll back button on
 * a kept release whose schema is not behind the live database's; the POST
 * goes through the same refusals and the same health-read swap as
 * `--rollback`, then this process drains.
 */

import { getReposByIds } from "../../core/repos.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { running } from "../../kernel/version.ts";
import type { Ctx } from "../../http/context.ts";
import { lastProof, proofNotice, proveAgain } from "../../release/prove.ts";
import { listReleases } from "../../release/record.ts";
import { BOOTED, canRollBackTo, mayRead, mayRollBack, rollBackTo } from "../../release/gate.ts";
import { journeyLine, liveSince, NO_RELEASES_YET } from "../../release/words.ts";
import { notFoundPage, signInFirst, NOT_ADMIN_HERE, SIGN_IN_TO_DO, forbiddenPage } from "../chrome.ts";
import { readForm } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { badge, btn, row, sha, time } from "../ui.ts";
import { holdAs, liftAs } from "../../keeper/hold.ts";
import { releaseNowAs } from "../../keeper/now.ts";
import { keeperPanel } from "./keeper-panel.ts";

/** The live line (`liveSince`) for the home, or nothing when no release is known to be live. */
export function liveLine(ctx: Ctx): Html | undefined {
  const live = running().commit;
  if (live === null || !mayRead(ctx.app, ctx.auth.user)) return undefined;
  return html`<p class="small muted" id="live-release">
    <a href="/releases">${liveSince(html, html`<span class="sha">${live.slice(0, 7)}</span>`, time(BOOTED))}</a>
  </p>`;
}

/** The proven stranger's journey line for the version serving, or nothing when the last proof kept no timings. */
export function journeyCard(ctx: Ctx): Html | undefined {
  const p = lastProof(ctx.app.config.dataDir);
  if (p === undefined || !p.ok || p.version !== running().version) return undefined;
  const line = journeyLine(html, p.journey, (n) => n);
  return line === undefined ? undefined : html`<p class="small muted" id="journey-proof">${line}</p>`;
}

/**
 * The proof's own record, the top item when the last proof has not passed: what
 * was checked, where it stopped, what happened, whether the release is serving,
 * when it is tried again, and a way to try it now. Plain words; the proof's raw
 * line is one fold away.
 */
export function proofCard(ctx: Ctx, writer: boolean): Html | undefined {
  const n = proofNotice(ctx.app.config.dataDir, running().version);
  if (n === undefined) return undefined;
  const serving = n.tone === "notice";
  const rows: [string, string | Html][] = [
    ["Is the release serving?", serving ? `Yes. This forge is running ${n.version} and answering.` : `Not as it should: ${n.happened}.`],
    ["What was checked", n.step],
    ["Where it stopped", n.stopped],
    ["What happened", n.happened],
    ["First failed", html`${time(n.since)}, ${String(n.failures)} ${n.failures === 1 ? "try" : "tries"} so far`],
    ["Next try", n.nextAt === null ? "Soon." : html`${time(new Date(n.nextAt).toISOString())} (${new Date(n.nextAt).toISOString().slice(11, 16)} UTC)`],
  ];
  return html`<section class="settings-block" id="proof" aria-label="The release's proof">
    <h2>Release ${n.version}: ${serving ? "its proof could not finish" : "it is not serving as it should"}</h2>
    <p>${n.sentence}</p>
    <ul class="list setting-list">${rows.map(([title, meta]) => row({ title: html`${title}`, meta: html`${meta}` }))}</ul>
    ${writer
      ? html`<form method="post" action="/releases/prove" class="bar">${btn("Prove it again now", { variant: "primary" })}<span class="small muted">The next minute's tick tries it; nothing else changes.</span></form>`
      : null}
    <details class="disclosure"><summary class="small muted">Exactly what the proof saw</summary><pre class="mono">${n.raw}</pre></details>
  </section>`;
}

/** POST /releases/prove: try the failed proof again at the next tick. */
export async function proveAgainSubmit(ctx: Ctx): Promise<Response> {
  const user = ctx.auth.user;
  if (user === undefined) return forbiddenPage(ctx, SIGN_IN_TO_DO);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  // Anyone who may read the releases may ask for a proof again: it changes nothing but when the next one runs.
  if (user.kind === "agent" || !mayRead(ctx.app, user)) return forbiddenPage(ctx, NOT_ADMIN_HERE);
  return proveAgain(ctx.app.config.dataDir)
    ? flashTo(ctx, "/releases", { message: "Asked: the forge proves this release again at its next tick, within a minute." })
    : flashTo(ctx, "/releases", { tone: "danger", message: "There is no failed proof to try again." });
}

/**
 * An owner's hold reason and a keeper's reason are free text: inside
 * `[data-releases]` they break anywhere, so the page never scrolls sideways at 390 px. No new class.
 */
export const RELEASES_CSS = `[data-releases] { overflow-wrap: anywhere; }
[data-releases] input[name="reason"] { max-width: 100%; }`;

export async function releasesPage(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const user = ctx.auth.user;
  if (user === undefined) return signInFirst(ctx);
  if (!mayRead(ctx.app, user)) return notFoundPage(ctx);
  const reading = performance.now();
  const releases = listReleases(ctx.app.db);
  notePhase(ctx.request, "releases", performance.now() - reading);
  const looking = performance.now();
  const repos = getReposByIds(ctx.app.db, releases.flatMap((r) => (r.pullNumber === null ? [] : [r.repoId])));
  notePhase(ctx.request, "repos", performance.now() - looking);
  const live = running().commit;
  const writer = mayRollBack(ctx.app, user);
  const checking = performance.now();
  const rollable = writer
    ? await Promise.all(releases.map((r) => (live !== null && r.sha === live ? false : canRollBackTo(ctx.app, r))))
    : releases.map(() => false);
  notePhase(ctx.request, "rollback", performance.now() - checking);
  const rendering = performance.now();
  const rows: Html[] = [];
  for (const [i, r] of releases.entries()) {
    const isLive = live !== null && r.sha === live;
    const repo = r.pullNumber === null ? undefined : repos.get(r.repoId);
    rows.push(
      row({
        nav: true,
        ...(repo === undefined || r.pullNumber === null ? {} : { href: `/${repo.ownerName}/${repo.name}/pulls/${r.pullNumber}` }),
        title: html`${sha(r.sha)} ${when(isLive, () => badge("live", { tone: "success" }))}
          ${when(!r.ok, () => badge("preflight failed", { tone: "danger" }))}`,
        meta: html`${r.pullNumber === null ? null : html`#${r.pullNumber} · `}landed ${time(r.createdAt)}${isLive ? html` · healthy since ${time(BOOTED)}` : null}`,
        ...(rollable[i] === true
          ? { after: html`<form method="post" action="/releases/${r.sha}/rollback">${btn("Roll back", { type: "submit" })}</form>` }
          : {}),
      }),
    );
  }
  const body =
    rows.length === 0
      ? html`<p class="mt muted">No releases yet. ${NO_RELEASES_YET}</p>`
      : html`<ul class="list setting-list">${rows}</ul>`;
  const response = page({
    ctx,
    title: "Releases",
    body: html`<div data-releases><div class="page-head"><h1>Releases</h1></div>${proofCard(ctx, user.kind !== "agent")}${keeperPanel(ctx.app.db, writer)}${journeyCard(ctx)}${body}</div>`,
    styleCss: RELEASES_CSS,
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

export async function rollbackSubmit(ctx: Ctx): Promise<Response> {
  const user = ctx.auth.user;
  if (user === undefined) return forbiddenPage(ctx, SIGN_IN_TO_DO);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  if (!mayRollBack(ctx.app, user)) return forbiddenPage(ctx, NOT_ADMIN_HERE);
  const target = ctx.params["sha"] ?? "";
  const refuse = (message: string): Response =>
    flashTo(ctx, "/releases", { tone: "danger", message });
  if (!/^[0-9a-f]{40}$/.test(target)) return notFoundPage(ctx);
  const result = await rollBackTo(ctx.app, user, target);
  if (!result.ok) return refuse(result.line);
  return flashTo(ctx, "/releases", { message: `Rolled back to ${target.slice(0, 7)}; it reads healthy.` });
}

/** POST /releases/hold: an owner's hold with a reason, through the function MCP calls. */
export async function releaseHoldSubmit(ctx: Ctx): Promise<Response> {
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const held = holdAs(ctx.app, ctx.auth.user, String(form.get("reason") ?? ""));
  return held.ok
    ? flashTo(ctx, "/releases", { message: `Releases held: ${held.value.reason}` })
    : flashTo(ctx, "/releases", { tone: "danger", message: held.message });
}

/** POST /releases/now: cut at the keeper's next tick, with a reason, through the function MCP calls (#11839). */
export async function releaseNowSubmit(ctx: Ctx): Promise<Response> {
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const asked = releaseNowAs(ctx.app, ctx.auth.user, String(form.get("reason") ?? ""));
  return asked.ok
    ? flashTo(ctx, "/releases", { message: `Release asked for now: ${asked.value.reason}` })
    : flashTo(ctx, "/releases", { tone: "danger", message: asked.message });
}

/** POST /releases/hold/:id/lift: lift an owner's hold. */
export async function liftSubmit(ctx: Ctx): Promise<Response> {
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const lifted = liftAs(ctx.app, ctx.auth.user, Number(ctx.params["id"]));
  return lifted.ok
    ? flashTo(ctx, "/releases", { message: `Hold ${lifted.value} lifted.` })
    : flashTo(ctx, "/releases", { tone: "danger", message: lifted.message });
}
