/**
 * GET /:owner/:name/pulls/:number/resolve — a conflicted pull, one file at a
 * time. Each conflict block is a heading over rows, no box: the two sides
 * named by their branch, four taps (keep one side, keep both, write your
 * own) and a text box for your own words. The choices travel in the query
 * string, so the page keeps no state and writes nothing to git; it shows the
 * running count and the merged file beneath. Writers only.
 */

import { canWrite, getRepoById, type Repo } from "../../core/repos.ts";
import { pullDir, pullStatus, type Pull } from "../../core/pulls.ts";
import { activeRunFor } from "../../core/runs.ts";
import { getIssueById } from "../../core/issues.ts";
import {
  PROPOSE_WHY,
  proposalOf,
  proposerOf,
  proposeResolution,
} from "../../crew/proposal.ts";
import { readConflictedFile } from "../../git/conflict-file.ts";
import {
  applyChoices,
  parseConflicts,
  resolvedCount,
  type Choice,
} from "../../git/conflicts.ts";
import { notePhase, takeSessionTime, timePhase, timePhaseAsync } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { crumbsFor, notFoundPage, repoBase, repoPalette, repoHeader, forbiddenPage } from "../chrome.ts";
import { FINISH_REFUSALS, finishConflicts } from "../../actions/finish-conflicts.ts";
import { RESOLUTION_ASKED } from "../../actions/pull_ask_words.ts";
import { field, readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { renderMarkdown } from "../markdown.ts";
import { btn } from "../ui.ts";
import { changeHead, changeTabs, pullContext } from "../studio/change.ts";

/** More blocks or longer words than this are not a hand's work. */
export const MAX_BLOCKS = 500;
export const MAX_TEXT = 20_000;

/**
 * The choices a query carries: `b<i>` is ours, theirs, both or text, and
 * `t<i>` the words for text. Anything else leaves the block open. A box's
 * words end in a newline, as a line of a file does, unless they are empty.
 */
export function choicesFrom(
  params: URLSearchParams,
  total: number,
): (Choice | undefined)[] {
  const out: (Choice | undefined)[] = [];
  for (let i = 0; i < Math.min(total, MAX_BLOCKS); i++) {
    // Words in the box with no tap picked are "Mine": typing is the choice.
    const typed = (params.get(`t${i}`) ?? "") !== "";
    const kind = params.get(`b${i}`) ?? (typed ? "text" : null);
    if (kind === "ours" || kind === "theirs" || kind === "both")
      out.push({ kind });
    else if (kind === "text") {
      let text = (params.get(`t${i}`) ?? "").replace(/\r\n?/g, "\n");
      if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);
      out.push({
        kind: "text",
        text: text === "" || text.endsWith("\n") ? text : text + "\n",
      });
    } else out.push(undefined);
  }
  return out;
}

/** POST /:owner/:name/pulls/:number/resolve/propose — have the crew propose a resolution. */
export async function proposeSubmit(ctx: Ctx): Promise<Response> {
  const found = pullContext(ctx);
  if (found instanceof Response) return found;
  const { repo, pull } = found;
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const dest = `${repoBase(repo)}/pulls/${pull.number}/resolve`;
  const made = await proposeResolution(ctx.app, ctx.auth.user, repo, pull);
  if (!made.ok) return flashTo(ctx, dest, { tone: "danger", message: PROPOSE_WHY[made.error] });
  return flashTo(ctx, dest, {
    message: RESOLUTION_ASKED,
  });
}

/**
 * The crew's proposal: the tap to ask for one while the pull conflicts and
 * the last run is not still working, and what the last run did — its note,
 * its commit, and the files to edit by hand.
 */
async function proposalCard(
  ctx: Ctx,
  repo: Repo,
  pull: Pull,
  dir: string,
  conflicted: boolean,
): Promise<Html> {
  const { app } = ctx;
  const here = `${repoBase(repo)}/pulls/${pull.number}/resolve`;
  const agent = proposerOf(app, pull);
  const issue = getIssueById(app.db, pull.id);
  const working = issue !== undefined && activeRunFor(app.db, "agent", issue.id) !== undefined;
  const seen = await proposalOf(app, repo, pull, dir);
  const parts: Html[] = [];
  if (seen.kind === "working")
    parts.push(html`<p>The crew is working on a fix (${seen.state}). This card updates by itself.</p>`);
  else if (seen.kind === "landed") {
    const head = getRepoById(app.db, pull.headRepoId) ?? repo;
    parts.push(html`<p><strong>The crew proposed a resolution</strong>, committed as
      <a class="mono" href="${repoBase(repo)}/commit/${seen.oid}">${seen.oid.slice(0, 7)}</a>
      on <span class="mono">${seen.branch}</span>.</p>
      ${seen.note === undefined ? "" : html`<div class="md">${renderMarkdown(seen.note)}</div>`}
      ${seen.files.length === 0
        ? ""
        : html`<p class="small">Edit by hand: ${seen.files.map(
            (f) => html`<a class="mono" href="/${head.ownerName}/${head.name}/edit/${encodeURIComponent(pull.headBranch)}/${f.split("/").map(encodeURIComponent).join("/")}">${f}</a> `,
          )}</p>`}`);
  } else if (seen.kind === "failed")
    parts.push(html`<p>The last proposal did not land (${seen.state}): ${seen.summary}</p>`);
  if (conflicted && agent !== undefined && working && seen.kind !== "working")
    parts.push(html`<p class="muted">${PROPOSE_WHY.busy}</p>`);
  if (conflicted && agent !== undefined && !working)
    parts.push(html`<form method="post" action="${here}/propose">
      <p>${btn("Ask the crew to fix it", { icon: "check" })}
      <span class="muted small">${"@" + agent} merges the base into this branch and commits a fix.</span></p>
    </form>`);
  if (parts.length === 0) return html``;
  // A live region: the run's events re-read the card, so nobody reloads.
  return html`<div id="crew-proposal" data-live="run.queued,run.started,run.finished,pull.*,comment.*"><section><h2>The crew</h2>${parts}</section></div>`;
}

const CSS = `
.rs-list { display: grid; gap: 12px; margin-top: 12px; }
.rs-card { content-visibility: auto; contain-intrinsic-size: auto 260px; }
.rs-sides { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); }
.rs-side { min-width: 0; }
.rs-side .rs-label { display: block; color: var(--muted, inherit); opacity: .75; }
.rs-side pre, .rs-merged { margin: 2px 0 0; padding: 4px 0 8px; overflow: auto; max-height: 12em; font-size: 12.5px; white-space: pre; background: none; border: 0; border-bottom: 1px solid var(--border, #8884); border-radius: 0; }
.rs-merged { max-height: 32em; }
.rs-taps { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0; }
.rs-taps label { flex: 1 1 0; text-align: center; padding: 8px 6px; min-height: 40px; border: 1px solid var(--border, #8884); border-radius: 6px; cursor: pointer; }
.rs-taps input { position: absolute; opacity: 0; pointer-events: none; }
.rs-taps label:has(input:checked) { font-weight: 600; border-color: currentColor; }
.rs-taps label:has(input:focus-visible) { outline: 2px solid currentColor; }
.rs-text { width: 100%; min-height: 3.5em; font-family: monospace; }
`;

/** The other conflicted files as links the shell's j/k walk; nothing when there is one file. */
export function fileSwitcher(here: string, files: readonly string[], file: string): Html {
  if (files.length < 2) return html``;
  return html`<p class="small">
          ${files.map((f) =>
            f === file
              ? html`<strong class="mono">${f}</strong> `
              : html`<a class="mono" data-nav href="${here}?file=${encodeURIComponent(f)}">${f}</a> `,
          )}
        </p>`;
}

export async function conflictsPage(ctx: Ctx): Promise<Response> {
  const req = ctx.request;
  notePhase(req, "session", takeSessionTime(req));
  const found = timePhase(req, "pull", () => pullContext(ctx));
  if (found instanceof Response) return found;
  const { repo, pull } = found;
  if (!canWrite(ctx.app.db, repo, ctx.auth.user)) return notFoundPage(ctx);
  const base = repoBase(repo);
  const back = `${base}/pulls/${pull.number}/files`;
  const dir = await timePhaseAsync(req, "checkout", () =>
    pullDir(ctx.app.db, ctx.app.reposRoot, repo, pull),
  );
  const status = await timePhaseAsync(req, "status", () => pullStatus(dir, pull));
  const files = status.conflicts;
  const asked = ctx.url.searchParams.get("file") ?? "";
  // Only a path git itself named is read; the rest of the world is a 404.
  const file = asked === "" ? files[0] : files.find((f) => f === asked);
  const unknown = asked !== "" && file === undefined && files.length > 0;
  if (pull.state !== "open" || file === undefined) {
    const crew = await timePhaseAsync(req, "crew", () => proposalCard(ctx, repo, pull, dir, false));
    const rendering = performance.now();
    const response = page({
      ctx,
      title: `Resolve · ${pull.title}`,
      crumbs: crumbsFor(repo),
      palette: repoPalette(ctx, repo),
      body: html`${repoHeader(ctx, repo, "pulls", { compact: true, ownTitle: true })}
        ${changeHead(ctx, repo, pull)}${changeTabs(repo, pull, "files")}
        <p class="mt">${unknown && pull.state === "open"
              ? "No conflict in that file."
              : "This pull has no conflicts."}
            <a href="${back}">Back to the files</a>.</p>
        ${crew}`,
    });
    notePhase(req, "render", performance.now() - rendering);
    return response;
  }

  const text = await timePhaseAsync(req, "file", () =>
    readConflictedFile(dir, status.baseOid, status.headOid, file),
  );
  const crew = await timePhaseAsync(req, "crew", () => proposalCard(ctx, repo, pull, dir, true));
  const rendering = performance.now();
  const parsed = parseConflicts(text ?? "");
  const choices = choicesFrom(ctx.url.searchParams, parsed.blocks.length);
  const labels = { ours: pull.baseBranch, theirs: pull.headBranch };
  const done = resolvedCount(choices, parsed.blocks.length);
  const total = parsed.blocks.length;
  const merged = applyChoices(parsed, choices, labels);
  const here = `${base}/pulls/${pull.number}/resolve`;

  const cards: Html[] = parsed.blocks.slice(0, MAX_BLOCKS).map((block, i) => {
    const pick = choices[i]?.kind;
    const tap = (kind: string, label: string): Html =>
      html`<label
        ><input type="radio" name="b${i}" value="${kind}" ${pick === kind ? html`checked` : ""} />${label}</label
      >`;
    const own = choices[i];
    return html`<section class="rs-card"><h2>Block ${i + 1} of ${total}</h2>
        <div class="rs-sides">
          <div class="rs-side">
            <span class="rs-label small mono">${pull.baseBranch}</span>
            <pre>${block.ours}</pre>
          </div>
          <div class="rs-side">
            <span class="rs-label small mono">${pull.headBranch}</span>
            <pre>${block.theirs}</pre>
          </div>
        </div>
        ${block.base === ""
          ? ""
          : html`<details><summary class="small muted">The original</summary><pre class="rs-merged">${block.base}</pre></details>`}
        <div class="rs-taps">
          ${tap("ours", `Keep ${pull.baseBranch}`)}${tap("theirs", `Keep ${pull.headBranch}`)}${tap("both", "Keep both")}${tap("text", "Write my own")}
        </div>
        <textarea class="rs-text" name="t${i}" rows="3" maxlength="${MAX_TEXT}"
          aria-label="Your own words for block ${i + 1}">${own?.kind === "text" ? own.text : ""}</textarea></section>`;
  });

  const body = html`${repoHeader(ctx, repo, "pulls", { compact: true, ownTitle: true })}
    ${changeHead(ctx, repo, pull)}${changeTabs(repo, pull, "files")}
    <p class="muted small mt">
      <a href="${back}">← Files</a> · <span class="mono">${file}</span> ·
      <strong id="rs-count">${done} of ${total} resolved</strong>
      · nothing is saved until you finish
    </p>
    ${fileSwitcher(here, files, file)}
    ${crew}
    ${total === 0
      ? html`<p class="mt">This file has no text to choose between. It may be deleted on
            one side. Fix it in your own checkout.</p>`
      : html`<form method="get" action="${here}">
          <input type="hidden" name="file" value="${file}" />
          <input type="hidden" name="head" value="${status.headOid}" />
          <input type="hidden" name="base" value="${status.baseOid}" />
          <div class="rs-list">${cards}</div>
          <p class="mt">${btn("Show the result", { icon: "check", variant: "ghost" })}
            ${files.length === 1
              ? html`<button type="submit" formmethod="post" class="btn" data-variant="primary">Save to ${pull.headBranch}</button>`
              : html`<span class="muted small">This pull has ${files.length} conflicted files. Fix them in your own checkout.</span>`}</p>
        </form>`}
    <h2 class="mt">Merged file</h2>
    <pre class="rs-merged" aria-label="Merged ${file}">${merged}</pre>`;

  const response = page({
    ctx,
    title: `Resolve · ${pull.title} · ${repo.name}`,
    crumbs: crumbsFor(repo),
    palette: repoPalette(ctx, repo),
    body,
    styleCss: CSS,
  });
  notePhase(req, "render", performance.now() - rendering);
  return response;
}

// POST /:owner/:name/pulls/:number/resolve
export async function conflictsFinish(ctx: Ctx): Promise<Response> {
  const found = pullContext(ctx);
  if (found instanceof Response) return found;
  const { repo, pull } = found;
  if (!ctx.auth.user || !canWrite(ctx.app.db, repo, ctx.auth.user))
    return forbiddenPage(ctx, "Only someone who can write to this repository can do this.");
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const dest = `${repoBase(repo)}/pulls/${pull.number}`;
  const params = new URLSearchParams();
  for (const [k, v] of form.entries())
    if (typeof v === "string" && /^[bt]\d{1,4}$/.test(k)) params.set(k, v);
  const head = field(form, "head");
  const baseOid = field(form, "base");
  const path = field(form, "file");
  const dir = await pullDir(ctx.app.db, ctx.app.reposRoot, repo, pull);
  // Count the blocks the same way the page did, so choices line up.
  const status = await pullStatus(dir, pull);
  const text =
    status.conflicts.includes(path) && head === status.headOid
      ? await readConflictedFile(dir, status.baseOid, status.headOid, path)
      : undefined;
  const total = parseConflicts(text ?? "").blocks.length;
  const done = await finishConflicts(ctx.app, ctx.auth.user, repo, pull, {
    headOid: head,
    baseOid,
    path,
    choices: choicesFrom(params, total),
  });
  if (!done.ok)
    return flashTo(ctx, `${dest}/resolve`, {
      tone: "danger",
      message: FINISH_REFUSALS[done.error],
    });
  return flashTo(ctx, dest, {
    message: "Conflicts resolved: the choices are committed to the branch.",
  });
}
