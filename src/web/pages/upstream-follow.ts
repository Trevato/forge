/**
 * Following an upstream (#3442), on the page: the settings card that turns
 * it on, points it and checks now; and the one line the repository's About
 * card shows admins. Every mutation is a same-origin POST through
 * `readForm`; the doors only word what `actions/upstream_follow.ts` answers.
 */

import {
  behindWords,
  checkedWords,
  checkLine,
  checkUpstreamNow,
  clockWords,
  FOLLOW_REFUSALS,
  followShown,
  setFollowUpstream,
  standing,
  upstreamLabel,
  upstreamShort,
} from "../../actions/upstream_follow.ts";
import { aheadFor, aheadWords } from "../../origins/ahead.ts";
import { requireWriter } from "../../actions/access.ts";
import {
  addFollowSources,
  checkSourcesNow,
  removeFollowSource,
  SOURCE_REFUSALS,
  sourceStanding,
} from "../../actions/follow_sources.ts";
import { listSources, stampOf, type FollowSource } from "../../core/follow_sources.ts";
import { canAdmin, type Repo } from "../../core/repos.ts";
import { getProvenance } from "../../core/provenance.ts";
import { getFollow, listChecks } from "../../core/upstream_follow.ts";
import type { Ctx } from "../../http/context.ts";
import { loadRepo, repoBase, repoNotFound } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { icon } from "../icons.ts";
import { isLocalPath } from "../flash.ts";
import { flashTo } from "../layout.ts";
import { btn, card, field as formField, row, timeAgo } from "../ui.ts";

/** Where to land: a validated same-origin path the form names as `back`, else the settings card. */
function backTo(form: Awaited<ReturnType<typeof readForm>> & object, fallback: string): string {
  const back = (form as FormData).get("back");
  return typeof back === "string" && isLocalPath(back) ? back : fallback;
}

/** HH:MM in UTC, with the instant for machines and the title for people. */
function clock(iso: string): Html {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return html``;
  const exact = `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  return html`<time datetime="${at.toISOString()}" title="${exact}">${clockWords(iso)}</time>`;
}

/** The About card's line, for admins; null for everyone else. */
export function followingLine(ctx: Ctx, repo: Repo): Html | null {
  const follow = followShown(ctx.app, repo, ctx.auth.user);
  if (follow === undefined || !follow.enabled) return null;
  return html`<p class="mt small muted" data-following-upstream>
    ${icon("sync")} Following
    <a href="${follow.url}" rel="noreferrer noopener">${upstreamLabel(follow.url)}</a>
    <span class="mono">${follow.branch}</span>
    ${follow.checkedAt === null ? null : html`· last checked ${clock(follow.checkedAt)}`}
    · ${standing(follow)}
  </p>`;
}

/**
 * Under the head of a followed repository: how far behind the last check
 * found it, or that it conflicts. Read from the stored check, never git;
 * null when level, unchecked, failed for another reason, or following
 * nothing. Admins only, like the page it links to.
 */
export function behindLine(ctx: Ctx, repo: Repo): Html | null {
  const follow = followShown(ctx.app, repo, ctx.auth.user);
  const words = follow === undefined ? null : behindWords(follow);
  if (follow === undefined || words === null || follow.checkedAt === null) return null;
  const base = repoBase(repo);
  return html`<div class="small muted" data-behind-upstream>
    ${icon("sync")}
    ${words.conflict
      ? html`<a href="${base}/settings#upstream">${words.text}</a>`
      : html`${words.text} ·`}
    checked ${timeAgo(follow.checkedAt)}
    <form method="post" action="${base}/settings/upstream/check" class="inline">
      <input type="hidden" name="back" value="${base}" />
      ${btn("Update", { size: "sm", icon: "sync" })}
    </form>
    <a href="${base}/settings#upstream">details</a>
  </div>`;
}

/**
 * Under the head of a mirror: how many commits its origin has that it has
 * not taken, with the one action that takes them. Read from the stored
 * reading, never the network; null when level or unread, or when the viewer
 * cannot read the repository. Only writers see the action: the route behind
 * it asks the same.
 */
export function originAheadLine(ctx: Ctx, repo: Repo): Html | null {
  if (repo.origin === null) return null;
  const ahead = aheadFor(ctx.app, repo, ctx.auth.user);
  if (ahead === undefined) return null;
  const base = repoBase(repo);
  return html`<div class="small muted" data-origin-ahead>
    ${icon("sync")}
    ${aheadWords(ahead)} · read ${timeAgo(ahead.at)}
    ${when(
      requireWriter(ctx.app, ctx.auth.user, repo).ok,
      () => html`<form method="post" action="${base}/sync/take" class="inline">
        ${btn("Take them", { size: "sm", icon: "sync" })}
      </form>`,
    )}
  </div>`;
}

/** The last five checks, newest first; nothing when there are none. */
function historyList(ctx: Ctx, repo: Repo): Html | null {
  const checks = listChecks(ctx.app.db, repo.id, 5);
  if (checks.length === 0) return null;
  return html`<ul class="list" data-following-history>
    ${checks.map((c) => row({ title: checkLine(c, timeAgo(c.at)) }))}
  </ul>`;
}

/** The settings card: on or off, the URL and branch, and "Check upstream now". */
export function followUpstreamCard(ctx: Ctx, repo: Repo): Html | null {
  if (!canAdmin(ctx.app.db, repo, ctx.auth.user)) return null;
  const follow = getFollow(ctx.app.db, repo.id);
  const base = repoBase(repo);
  return card(
    html`<form method="post" action="${base}/settings/upstream">
        <p class="muted">
          New upstream commits arrive as a pull; never a push to
          <span class="mono">${repo.defaultBranch}</span>. A check runs every 30 minutes.
        </p>
        ${formField({
          label: "Upstream git URL",
          name: "url",
          value: follow?.url ?? "",
          placeholder: "https://github.com/owner/name.git",
          mono: true,
          spellcheck: false,
          hint: "A public upstream needs no credential. https or http only.",
        })}
        ${formField({
          label: "Branch",
          name: "branch",
          value: follow?.branch ?? "main",
          mono: true,
          spellcheck: false,
        })}
        <div class="field">
          <label class="check">
            <input type="checkbox" name="enabled" ${follow?.enabled === true ? html`checked` : null} />
            <span>Follow upstream</span>
          </label>
        </div>
        ${when(
          follow,
          (f) => html`<p class="hint" data-following-standing>${standing(f)}${
            f.checkedAt === null ? "" : html` · last checked ${clock(f.checkedAt)}`
          }${f.error === "" ? "" : html` · ${f.error}`} · ${f.opened} proposed so far</p>`,
        )}
        ${historyList(ctx, repo)}
        <div class="form-actions">${btn("Save")}</div>
      </form>
      ${when(
        follow?.enabled === true,
        () => html`<form method="post" action="${base}/settings/upstream/check" class="mt">
          ${btn("Check upstream now", { size: "sm", icon: "sync" })}
        </form>`,
      )}`,
    { head: html`${icon("sync")}<h2 id="upstream">Follow upstream</h2>` },
  );
}

// POST /:owner/:name/settings/upstream
export async function followUpstreamUpdate(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo || !canAdmin(ctx.app.db, repo, ctx.auth.user)) return repoNotFound(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const saved = setFollowUpstream(ctx.app, ctx.auth.user, repo, {
    url: field(form, "url"),
    branch: field(form, "branch"),
    enabled: form.get("enabled") !== null,
  });
  return flashTo(
    ctx,
    backTo(form, `${repoBase(repo)}/settings#upstream`),
    saved.ok
      ? {
          message: saved.value.enabled
            ? `Following ${upstreamLabel(saved.value.url)} ${saved.value.branch}. The next check runs within a minute.`
            : "Following the upstream is off. Nothing is checked or proposed.",
        }
      : { tone: "danger", message: FOLLOW_REFUSALS[saved.error] },
  );
}

// POST /:owner/:name/settings/upstream/check
export async function followUpstreamCheck(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo || !canAdmin(ctx.app.db, repo, ctx.auth.user)) return repoNotFound(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const checked = await checkUpstreamNow(ctx.app, ctx.auth.user, repo);
  const back = field(form, "back");
  return flashTo(
    ctx,
    back === repoBase(repo) ? back : `${repoBase(repo)}/settings#upstream`,
    checked.ok
      ? { message: checkedWords(checked.value) }
      : { tone: "danger", message: FOLLOW_REFUSALS[checked.error] },
  );
}

/** One source on one line: where, which branch, who it is trusted as, where its last check stands. */
function sourceLine(base: string, s: FollowSource): Html {
  const stamp = stampOf(s);
  const stand = sourceStanding(s);
  return row({
    lead: icon("sync"),
    title: html`<a href="${s.url}" rel="noreferrer noopener">${upstreamShort(s.url)}</a> <span class="mono">${s.branch}</span>`,
    meta: html`${stamp === undefined ? "" : `${stamp.account}@${stamp.host}`} · ${stand}${
      s.checkedAt === null ? "" : html` · checked ${clock(s.checkedAt)}`
    }`,
    trail: html`<form method="post" action="${base}/settings/sources/${s.id}/remove" class="row-fields">
      ${btn("Remove", { size: "sm", variant: "outline", label: `Stop following ${upstreamShort(s.url)}` })}
    </form>`,
  });
}

/** The settings card: every source on a line, and one box to add as many as you like. */
export function followSourcesCard(ctx: Ctx, repo: Repo): Html | null {
  if (!canAdmin(ctx.app.db, repo, ctx.auth.user)) return null;
  const sources = listSources(ctx.app.db, repo.id);
  const base = repoBase(repo);
  // A migrated repository's link back to where it came from is offered as the first line (#3293).
  const from = sources.length === 0 ? getProvenance(ctx.app.db, repo.id)?.sourceUrl : undefined;
  return card(
    html`<ul class="list" data-follow-sources>
        ${sources.length === 0
          ? html`<li class="muted small">Following no other sources.</li>`
          : sources.map((s) => sourceLine(base, s))}
      </ul>
      <form method="post" action="${base}/settings/sources" class="stack mt">
        <p class="muted small">
          A new commit on a source whose account is <a href="/settings/trusted">trusted</a> opens or updates
          one pull, stamped with where it came from; a conflict goes to the crew. Anyone else's waits as a guest.
        </p>
        ${formField({
          label: "Sources, one per line",
          name: "sources",
          type: "textarea",
          rows: 3,
          ...(from === undefined ? {} : { value: `${from} main` }),
          mono: true,
          spellcheck: false,
          placeholder: "https://git.open-platform.sh/jmoran/forge-jay.git main",
          hint: "Address, then the branch (main when left out). A forge admin may add “as account” to name the trusted account, e.g. “… main as benjivers”.",
        })}
        <div class="form-actions">${btn("Follow")}</div>
      </form>
      ${when(
        sources.length > 0,
        () => html`<form method="post" action="${base}/settings/sources/check" class="mt">
          ${btn("Check sources now", { size: "sm", icon: "sync" })}
        </form>`,
      )}`,
    { head: html`${icon("sync")}<h2 id="sources">Followed sources</h2>`, pad: sources.length === 0 },
  );
}

// POST /:owner/:name/settings/sources
export async function followSourcesAdd(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo || !canAdmin(ctx.app.db, repo, ctx.auth.user)) return repoNotFound(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const done = addFollowSources(ctx.app, ctx.auth.user, repo, field(form, "sources"));
  if (!done.ok) return repoNotFound(ctx);
  const bad = done.value.find((d) => !d.result.ok);
  const added = done.value.filter((d) => d.result.ok).length;
  return flashTo(
    ctx,
    `${repoBase(repo)}/settings#sources`,
    done.value.length === 0
      ? { tone: "danger", message: "Give at least one address." }
      : bad !== undefined && !bad.result.ok
        ? { tone: "danger", message: `${added} added. “${bad.line.slice(0, 80)}”: ${SOURCE_REFUSALS[bad.result.error]}` }
        : { message: `Following ${added} source${added === 1 ? "" : "s"}. The first check runs within a minute.` },
  );
}

// POST /:owner/:name/settings/sources/:id/remove
export async function followSourceRemove(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo || !canAdmin(ctx.app.db, repo, ctx.auth.user)) return repoNotFound(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const gone = removeFollowSource(ctx.app, ctx.auth.user, repo, ctx.params.id ?? "");
  return flashTo(
    ctx,
    backTo(form, `${repoBase(repo)}/settings#sources`),
    gone.ok
      ? { message: `No longer following ${upstreamShort(gone.value.url)}.` }
      : { tone: "danger", message: SOURCE_REFUSALS.not_found },
  );
}

// POST /:owner/:name/settings/sources/check
export async function followSourcesCheck(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo || !canAdmin(ctx.app.db, repo, ctx.auth.user)) return repoNotFound(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const checked = await checkSourcesNow(ctx.app, ctx.auth.user, repo);
  if (!checked.ok) return repoNotFound(ctx);
  const lines = checked.value.map((c) =>
    c.result.ok ? `${upstreamShort(c.source.url)}: ${checkedWords(c.result.value)}` : `${upstreamShort(c.source.url)}: ${FOLLOW_REFUSALS[c.result.error]}`,
  );
  return flashTo(ctx, `${repoBase(repo)}/settings#sources`, { message: lines.join(" ") || "No sources to check." });
}
