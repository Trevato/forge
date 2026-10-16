/**
 * GET /:owner/:name/pulls/:number/resolve — a conflicted pull, one file at a
 * time. Each conflict block is a card: the two sides named by their branch,
 * three taps (ours, theirs, both) and a text box for your own words. The
 * choices travel in the query string, so the page keeps no state and writes
 * nothing to git; it shows the running count and the merged file beneath.
 * Writers only.
 */

import { canWrite } from "../../core/repos.ts";
import { pullDir, pullStatus } from "../../core/pulls.ts";
import { readConflictedFile } from "../../git/conflict-file.ts";
import {
  applyChoices,
  parseConflicts,
  resolvedCount,
  type Choice,
} from "../../git/conflicts.ts";
import type { Ctx } from "../../http/context.ts";
import { crumbsFor, notFoundPage, repoBase, repoPalette, repoHeader } from "../chrome.ts";
import { FINISH_REFUSALS, finishConflicts } from "../../actions/finish-conflicts.ts";
import { field, readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { btn, card, icon } from "../ui.ts";
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

const CSS = `
.rs-list { display: grid; gap: 12px; margin-top: 12px; }
.rs-card { content-visibility: auto; contain-intrinsic-size: auto 260px; }
.rs-sides { display: grid; gap: 8px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); }
.rs-side { min-width: 0; }
.rs-side pre, .rs-merged { margin: 4px 0 0; padding: 8px; overflow: auto; max-height: 12em; font-size: 12px; white-space: pre; background: var(--muted-bg, transparent); border: 1px solid var(--border, #8884); border-radius: 6px; }
.rs-merged { max-height: 32em; }
.rs-taps { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0; }
.rs-taps label { flex: 1 1 0; text-align: center; padding: 8px 6px; min-height: 40px; border: 1px solid var(--border, #8884); border-radius: 6px; cursor: pointer; }
.rs-taps input { position: absolute; opacity: 0; pointer-events: none; }
.rs-taps label:has(input:checked) { font-weight: 600; border-color: currentColor; }
.rs-taps label:has(input:focus-visible) { outline: 2px solid currentColor; }
.rs-text { width: 100%; min-height: 3.5em; font-family: monospace; }
`;

export async function conflictsPage(ctx: Ctx): Promise<Response> {
  const found = pullContext(ctx);
  if (found instanceof Response) return found;
  const { repo, pull } = found;
  if (!canWrite(ctx.app.db, repo, ctx.auth.user)) return notFoundPage(ctx);
  const base = repoBase(repo);
  const back = `${base}/pulls/${pull.number}/files`;
  const dir = await pullDir(ctx.app.db, ctx.app.reposRoot, repo, pull);
  const status = await pullStatus(dir, pull);
  const files = status.conflicts;
  const asked = ctx.url.searchParams.get("file") ?? "";
  // Only a path git itself named is read; the rest of the world is a 404.
  const file = asked === "" ? files[0] : files.find((f) => f === asked);
  const unknown = asked !== "" && file === undefined && files.length > 0;
  if (pull.state !== "open" || file === undefined) {
    return page({
      ctx,
      title: `Resolve · ${pull.title}`,
      crumbs: crumbsFor(repo),
      palette: repoPalette(ctx, repo),
      body: html`${repoHeader(ctx, repo, "pulls", { compact: true, ownTitle: true })}
        ${changeHead(ctx, repo, pull)}${changeTabs(repo, pull, "files")}
        ${card(
          html`<p>${unknown && pull.state === "open"
              ? "Nothing to resolve there: that file is not one of the conflicted files."
              : "Nothing to resolve: this pull has no conflicts."}
            <a href="${back}">Back to the files</a>.</p>`,
        )}`,
    });
  }

  const text = await readConflictedFile(dir, status.baseOid, status.headOid, file);
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
    return card(
      html`<div class="rs-sides">
          <div class="rs-side">
            <strong class="small mono">${pull.baseBranch}</strong>
            <pre>${block.ours}</pre>
          </div>
          <div class="rs-side">
            <strong class="small mono">${pull.headBranch}</strong>
            <pre>${block.theirs}</pre>
          </div>
        </div>
        ${block.base === ""
          ? ""
          : html`<details><summary class="small muted">Before either changed it</summary><pre class="rs-merged">${block.base}</pre></details>`}
        <div class="rs-taps">
          ${tap("ours", `Ours`)}${tap("theirs", `Theirs`)}${tap("both", "Both")}${tap("text", "Mine")}
        </div>
        <textarea class="rs-text" name="t${i}" rows="3" maxlength="${MAX_TEXT}"
          aria-label="Your own text for block ${i + 1}">${own?.kind === "text" ? own.text : ""}</textarea>`,
      {
        extra: "rs-card",
        head: html`<h2>Block ${i + 1} of ${total}</h2>`,
      },
    );
  });

  const body = html`${repoHeader(ctx, repo, "pulls", { compact: true, ownTitle: true })}
    ${changeHead(ctx, repo, pull)}${changeTabs(repo, pull, "files")}
    <p class="muted small mt">
      <a href="${back}">← Files</a> · <span class="mono">${file}</span> ·
      <strong id="rs-count">${done} of ${total} resolved</strong>
      · nothing is written until you finish
    </p>
    ${files.length > 1
      ? html`<p class="small">
          ${files.map((f) =>
            f === file
              ? html`<strong class="mono">${f}</strong> `
              : html`<a class="mono" href="${here}?file=${encodeURIComponent(f)}">${f}</a> `,
          )}
        </p>`
      : ""}
    ${total === 0
      ? card(
          html`<p>This file has no text blocks to choose between (it may be
            deleted on one side). Resolve it in your own checkout.</p>`,
        )
      : html`<form method="get" action="${here}">
          <input type="hidden" name="file" value="${file}" />
          <input type="hidden" name="head" value="${status.headOid}" />
          <input type="hidden" name="base" value="${status.baseOid}" />
          <div class="rs-list">${cards}</div>
          <p class="mt">${btn("Update the merged file", { icon: "check", variant: "ghost" })}
            ${files.length === 1
              ? html`<button type="submit" formmethod="post" class="btn" data-variant="primary">Finish: commit this to ${pull.headBranch}</button>`
              : html`<span class="muted small">Finish needs every conflicted file on this page; this pull has ${files.length}. Resolve it in your own checkout.</span>`}</p>
        </form>`}
    <h2 class="mt">Merged file</h2>
    <pre class="rs-merged" aria-label="Merged ${file}">${merged}</pre>`;

  return page({
    ctx,
    title: `Resolve · ${pull.title} · ${repo.name}`,
    crumbs: crumbsFor(repo),
    palette: repoPalette(ctx, repo),
    body,
    styleCss: CSS,
  });
}

// POST /:owner/:name/pulls/:number/resolve
export async function conflictsFinish(ctx: Ctx): Promise<Response> {
  const found = pullContext(ctx);
  if (found instanceof Response) return found;
  const { repo, pull } = found;
  if (!ctx.auth.user || !canWrite(ctx.app.db, repo, ctx.auth.user))
    return new Response("forbidden", { status: 403 });
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
