/**
 * Following an upstream (#3442), on the page: the settings card that turns
 * it on, points it and checks now; and the one line the repository's About
 * card shows admins. Every mutation is a same-origin POST through
 * `readForm`; the doors only word what `actions/upstream_follow.ts` answers.
 */

import {
  checkedWords,
  checkUpstreamNow,
  clockWords,
  FOLLOW_REFUSALS,
  followShown,
  setFollowUpstream,
  standing,
  upstreamLabel,
} from "../../actions/upstream_follow.ts";
import { canAdmin, type Repo } from "../../core/repos.ts";
import { getFollow } from "../../core/upstream_follow.ts";
import type { Ctx } from "../../http/context.ts";
import { loadRepo, repoBase, repoNotFound } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { icon } from "../icons.ts";
import { flashTo } from "../layout.ts";
import { btn, card, field as formField } from "../ui.ts";

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
    `${repoBase(repo)}/settings#upstream`,
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
  return flashTo(
    ctx,
    `${repoBase(repo)}/settings#upstream`,
    checked.ok
      ? { message: checkedWords(checked.value) }
      : { tone: "danger", message: FOLLOW_REFUSALS[checked.error] },
  );
}
