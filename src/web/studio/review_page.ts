/**
 * `/review`: every ask waiting on the viewer as one row — the title, the
 * repository, how long it has waited and why a person must decide, and what the crew advises — newest
 * decision first. Read from the same candidates the asks page reads
 * (`waitingOn`); no polling, and nothing here changes anything.
 */

import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { previewEnv } from "../../apps/data.ts";
import { recommendationsFor } from "../../core/pull_wait.ts";
import { appsForRepos } from "../../core/apps.ts";
import { lookUrl, looksForApps } from "../../core/looks.ts";
import { latestRunsForIssues, type Run } from "../../core/runs.ts";
import type { Ctx } from "../../http/context.ts";
import { checkWord } from "../../apps/check_word.ts";
import { repoBase, signInFirst } from "../chrome.ts";
import { html, type Html } from "../html.ts";
import { page } from "../layout.ts";
import { badge, empty, listCard, row, runStateBadge, time } from "../ui.ts";
import { lookThumb, lookThumbPlain, thumbLook } from "../pages/looks.ts";
import { stepOfStored } from "../../flow/path.ts";
import { stepLink } from "./step_link.ts";
import { isTrusted, pullSourceOf } from "../../core/trusted_sources.ts";
import { actRow, rowId } from "./review_act.ts";
import { reviewSet } from "./review_set.ts";
import { staleArchive } from "./review_stale.ts";
import { diffStatFor, sizeLine } from "./review_evidence.ts";

/** The check on a pull's head, as the pull page wears it; only a run of this very head counts. */
function verdict(run: Run | undefined, headOid: string): Html {
  switch (checkWord(run, headOid)) {
    case "green":
      return runStateBadge("ok", "check");
    case "red":
      return runStateBadge("failed", "check");
    case "running":
      return runStateBadge("running", "check");
    case "none":
      return badge("No check", { variant: "outline" });
  }
}

/**
 * m / c / r act on the row the cursor is on (j / k, the shell's own); the
 * buttons are the forms' own, so a key is a click, never a second road. The
 * shell ignores keys typed in a box and so does this. Each key is also a
 * \`data-shortcut\` on the row's control, which is what the help lists.
 */
const REVIEW_KEYS_JS = `
var rowOf = function () { var a = document.activeElement; return a && a.closest ? a.closest('li[data-ask]') : null; };
document.addEventListener('keydown', function (e) {
  var t = e.target;
  if (e.metaKey || e.ctrlKey || e.altKey || (t && t.matches && t.matches('input, textarea, select, [contenteditable]'))) return;
  if (t && t.closest && t.closest('dialog[open]')) return;
  var verb = { m: 'merge', c: 'close', r: 'changes' }[e.key];
  var li = verb && rowOf();
  var f = li && li.querySelector('form[data-verb="' + verb + '"]');
  if (!f) return;
  e.preventDefault(); e.stopPropagation();
  if (verb === 'changes') f.querySelector('textarea').focus();
  else f.querySelector('button').click();
}, true);
var hit = location.hash && document.querySelector('li[data-ask]' + location.hash.replace(/[^#a-z0-9-]/g, ''));
if (hit) { var link = hit.querySelector('[data-nav]'); if (link) link.focus(); }
`;

/** A key the page answers to; the shell's help lists it from the attribute. */
const key = (k: string, label: string, word: string): Html =>
  html`<span data-shortcut="${k}" aria-label="${label}"><kbd>${k}</kbd> ${word}</span>`;

export function reviewPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const user = ctx.auth.user;
  if (!user) return signInFirst(ctx);
  const set = timePhase(ctx.request, "asks", () => reviewSet(ctx, user));
  const asks = set.live;
  const rendering = performance.now();
  const advice = recommendationsFor(
    ctx.app.db,
    asks.flatMap((a) => {
      const id = a.pull?.id ?? a.issue?.id;
      return id === undefined ? [] : [id];
    }),
  );
  const checks = latestRunsForIssues(
    ctx.app.db,
    asks.flatMap((a) => (a.pull === undefined ? [] : [a.pull.id])),
    ["check"],
  );
  const apps = appsForRepos(ctx.app.db, asks.map((a) => a.repo.id));
  const looks = looksForApps(ctx.app.db, [...apps.values()].map((r) => r.id));
  /** Production beside the pull's preview, each only if this viewer may fetch it. */
  const lookOf = (a: (typeof asks)[number], base: string): Html | undefined => {
    const record = a.pull === undefined ? undefined : apps.get(a.repo.id);
    if (a.pull === undefined || record === undefined) return undefined;
    const lookIn = (env: string) => thumbLook(ctx, a.repo, record, looks.filter((l) => l.appId === record.id && l.env === env));
    const after = lookIn(previewEnv(a.pull.number));
    if (after === undefined) return undefined;
    const before = lookIn("production");
    // Only the after picture links (to the pull); the before one is a named picture, so
    // a keyboard user meets one stop, not two to the same place.
    return html`<li data-look><div class="looks">${before === undefined ? "" : lookThumbPlain(lookUrl(base, before), "Production look, before")}${lookThumb(`${base}/pulls/${a.pull.number}`, lookUrl(base, after), "Preview look, after: opens the pull")}</div></li>`;
  };
  const rows = asks.map((a) => {
    const base = repoBase(a.repo);
    const look = lookOf(a, base);
    const href =
      a.pull !== undefined
        ? `${base}/pulls/${a.pull.number}`
        : a.issue !== undefined
        ? `${base}/issues/${a.issue.number}`
        : base;
    const rec = advice.get((a.pull?.id ?? a.issue?.id) ?? "");
    const advised =
      rec === undefined
        ? "The crew has not advised yet"
        : html`The crew advises: ${rec.verdict}${rec.reason === "" ? "" : html` — ${rec.reason}`}`;
    const stat = a.pull === undefined ? undefined : diffStatFor(ctx.app, a.repo, a.pull);
    const pending =
      stat === "loading"
        ? " · Diff loading — reload for the size"
        : stat === "failed"
        ? " · Diff size unavailable — open the pull to see it"
        : "";
    const from = a.pull === undefined ? undefined : pullSourceOf(ctx.app.db, a.pull.id);
    // A guest's pull from another forge says Approve and Decline; a trusted source's (here for a wall) is a person's plain Merge.
    const act = actRow(a, from !== undefined && !isTrusted(ctx.app.db, from.host, from.account));
    const step = a.pull === undefined ? null : stepOfStored(ctx.app.db, a.repo, a.pull);
    return row({
      href,
      nav: true,
      id: rowId(a),
      data: { ask: "" },
      title: a.pull?.title ?? a.issue?.title ?? a.proposal?.title ?? `${a.repo.name} is waiting on you`,
      titleAttr: `${a.repo.ownerName}/${a.repo.name}: ${a.why ?? a.consequence.why}`,
      meta: html`${a.repo.ownerName}/${a.repo.name} · ${time(a.since)} · ${a.why ?? a.consequence.why} · ${advised}${pending}`,
      ...(step === null ? {} : { after: stepLink(step) }),
      // The trail survives the meta line's ellipsis: the verdict and the size are the facts this row gives.
      ...(a.pull === undefined
        ? {}
        : {
            trail: html`${typeof stat === "object" ? html`<span class="small muted">${sizeLine(stat)}</span> ` : ""}${verdict(checks.get(a.pull.id), a.pull.headOid)}`,
          }),
      // A sibling of the row's link, never inside it: a link in a link is not a link.
      children: [
        ...(a.pull !== undefined && apps.has(a.repo.id)
          ? [row({ href: `${base}/app/${previewEnv(a.pull.number)}/open`, title: "Open the preview", nav: true }), ...(look === undefined ? [] : [look])]
          : []),
        ...(act === undefined ? [] : [act]),
      ],
    });
  });
  // Asks older than 30 days fold under one row, whose button opens the bulk-dismiss preview.
  if (set.stale.length > 0) rows.push(html`<li>${staleArchive(set.stale)}<span class="small muted">Older than 30 days; nothing is dismissed without a look</span></li>`);
  const body = html`<h1>Review</h1>
    <p class="muted">${set.count === 0 ? "All fine" : `${set.count} ${set.count === 1 ? "ask" : "asks"}, newest first`}</p>
    ${rows.length === 0
      ? empty({
          icon: "issue",
          title: "Nothing to review",
          note: "When the crew needs a person, it shows up here.",
          action: html`<a class="btn" href="/asks">All asks</a>`,
        })
      : html`${listCard(rows)}<p class="small muted">Keys: j / k move, ${key("m", "Merge the focused row", "merge")}, ${key("c", "Close the focused row", "close")}, ${key("r", "Request changes on the focused row", "request changes")} · <a href="/asks">All asks, with their buttons</a></p>`}`;
  const response = page({ ctx, title: "Review", body, scriptJs: asks.length === 0 ? "" : REVIEW_KEYS_JS });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}
