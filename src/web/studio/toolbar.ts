/**
 * The forge toolbar's actions (#810), as a forge page. The bar the app proxy
 * adds to an app's pages runs on the app's origin, so it never posts: it
 * opens this page on the forge's own origin, where every mutation is an
 * ordinary same-origin form with the forge's CSRF check (`readForm`). The
 * bar's script reads nothing of the app's page and nothing of the forge's
 * session; the forge reads the session here.
 *
 *   GET  /:owner/:name/toolbar?env=&page=   where you are, who is working,
 *                                           and the actions a person may take
 *   POST /:owner/:name/toolbar/comment      a preview of the comment, then
 *                                           (step=post) the comment and a receipt
 *
 * Telling the crew posts to the one `/:owner/:name/tell`; making it yours
 * links to #606's page. Signed out, the page is where you are and home.
 */

import { addCommentThrough, openIssueThrough } from "../../actions/issues.ts";
import { reportTitle } from "../../actions/page-report.ts";
import { getAppByRepo } from "../../core/apps.ts";
import { getIssue, MAX_BODY } from "../../core/issues.ts";
import { canWrite } from "../../core/repos.ts";
import { listRuns } from "../../core/runs.ts";
import { mayView, mayViewId } from "../../core/sealed.ts";
import { mayDirectCrew } from "../../crew/direct.ts";
import type { Ctx } from "../../http/context.ts";
import { notFoundPage, pageHead, loadRepo, repoBase } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, when } from "../html.ts";
import { page } from "../layout.ts";
import { originError } from "../pages/thread.ts";
import { btn, card } from "../ui.ts";

/** The longest page address the bar may carry. */
const PAGE_MAX = 512;

/** `raw` as a page address (http or https, no credentials), or "" for no.
 *  Only origin and path survive: a query or fragment may carry a token, and
 *  the address is published in an issue or comment. */
export function pageAddress(raw: string): string {
  if (raw.length === 0 || raw.length > PAGE_MAX) return "";
  const url = URL.parse(raw);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return "";
  if (url.username !== "" || url.password !== "") return "";
  url.search = "";
  url.hash = "";
  return url.href.length <= PAGE_MAX ? url.href : "";
}

/** `env` as the bar names it: production, or a preview's pull number. */
function parseEnv(raw: string): { env: string; pull?: number } | undefined {
  if (raw === "production") return { env: raw };
  const n = /^pull-([1-9]\d{0,8})$/.exec(raw)?.[1];
  return n === undefined ? undefined : { env: raw, pull: Number(n) };
}

/** The toolbar page's own path, for forms to come back to. */
const toolbarPath = (base: string, env: string, address: string): string =>
  `${base}/toolbar?env=${env}${address === "" ? "" : `&page=${encodeURIComponent(address)}`}`;

// GET /:owner/:name/toolbar
export function toolbarPage(ctx: Ctx): Response {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const where = parseEnv(ctx.url.searchParams.get("env") ?? "production");
  if (where === undefined || getAppByRepo(ctx.app.db, repo.id) === undefined)
    return notFoundPage(ctx);
  const db = ctx.app.db;
  const user = ctx.auth.user;
  const pull = where.pull === undefined ? undefined : getIssue(db, repo.id, where.pull);
  if (where.pull !== undefined && (!pull || pull.kind !== "pull" || !mayView(db, repo, pull, user)))
    return notFoundPage(ctx);
  const address = pageAddress(ctx.url.searchParams.get("page") ?? "");
  const base = repoBase(repo);
  const here = html`${repo.name}, ${pull ? html`preview of pull #${pull.number}` : "production"}`;
  const home = btn("Home", { href: "/", variant: "ghost" });
  if (!user) {
    return page({
      ctx,
      title: `${repo.name} · forge`,
      body: html`<div class="narrow-wide">${pageHead(here)}<div class="form-actions">${home}</div></div>`,
    });
  }
  // Read once, now, as the page opens: the live agent run on this app, or
  // on this preview's pull.
  // A run on work the viewer may not see (a sealed report) is not theirs to read.
  const live = listRuns(db, repo.id, {
    kind: "agent",
    ...(pull ? { issueId: pull.id } : {}),
    state: "running",
    limit: 200,
  }).find((r) => mayViewId(db, repo, r.issueId, user));
  const comment = pull ? "Comment on this pull" : "Report this page";
  const body = html`<div class="narrow-wide">
    ${pageHead(here)}
    ${when(
      live !== undefined,
      () => html`<p class="mono" data-working>
        <a href="${base}/runs/${live!.id}">Working now: ${live!.summary || "the crew is on this"}</a>
      </p>`,
    )}
    ${card(
      html`<form method="post" action="${base}/toolbar/comment" class="stack">
        <input type="hidden" name="env" value="${where.env}" />
        <input type="hidden" name="page" value="${address}" />
        <input type="hidden" name="step" value="preview" />
        <label>${comment}
          <textarea name="body" rows="4" maxlength="${MAX_BODY}" required></textarea>
        </label>
        <div class="form-actions">${btn("Preview", { variant: "primary" })}</div>
      </form>`,
    )}
    ${when(
      mayDirectCrew(db, repo, user),
      () =>
        card(
          html`<form method="post" action="${base}/tell" class="stack">
            <input type="hidden" name="from" value="${toolbarPath(base, where.env, "")}" />
            <label>Tell the crew
              <textarea name="text" rows="3" maxlength="${MAX_BODY}" required></textarea>
            </label>
            <div class="form-actions">${btn("Tell", { variant: "primary" })}</div>
          </form>`,
        ),
    )}
    <div class="form-actions">
      ${when(
        !canWrite(db, repo, user),
        () => btn("Make it yours", { href: `${base}/make-it-yours`, icon: "fork" }),
      )}
      ${home}
    </div>
  </div>`;
  return page({ ctx, title: `${repo.name} · forge`, body });
}

// POST /:owner/:name/toolbar/comment
export async function toolbarComment(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const user = ctx.auth.user;
  if (!user) return new Response("forbidden", { status: 403 });
  const where = parseEnv(field(form, "env"));
  if (where === undefined) return new Response("bad request", { status: 400 });
  const db = ctx.app.db;
  const pull = where.pull === undefined ? undefined : getIssue(db, repo.id, where.pull);
  if (where.pull !== undefined && (!pull || pull.kind !== "pull" || !mayView(db, repo, pull, user)))
    return notFoundPage(ctx);
  const text = field(form, "body").trim();
  const address = pageAddress(field(form, "page"));
  const base = repoBase(repo);
  const back = toolbarPath(base, where.env, address);
  const refuse = (message: string, status = 422): Response =>
    page(
      {
        ctx,
        title: "Not sent",
        body: html`<div class="narrow-wide">${pageHead("Not sent", { sub: message })}
          <div class="form-actions">${btn("Back", { href: back, variant: "ghost" })}</div></div>`,
      },
      status,
    );
  if (text === "") return refuse("A comment needs something in it.");
  const said = address === "" ? text : `${text}\n\nPage: <${address}>`;
  if (said.length > MAX_BODY) return refuse("That is too long to send in one go.");
  const target = pull ? `pull #${pull.number}` : "an issue on this app";

  if (field(form, "step") !== "post") {
    return page({
      ctx,
      title: "Preview",
      body: html`<div class="narrow-wide">
        ${pageHead("Preview", { sub: html`This will be sent as ${target}.` })}
        ${card(html`<form method="post" action="${base}/toolbar/comment" class="stack">
          <input type="hidden" name="env" value="${where.env}" />
          <input type="hidden" name="page" value="${address}" />
          <input type="hidden" name="step" value="post" />
          <input type="hidden" name="body" value="${text}" />
          <pre class="mono">${said}</pre>
          <div class="form-actions">
            ${btn("Send", { variant: "primary" })}
            ${btn("Edit", { href: back, variant: "ghost" })}
          </div>
        </form>`)}
      </div>`,
    });
  }

  if (pull) {
    const added = await addCommentThrough(ctx.app, user, repo, pull, said);
    if (!added.ok)
      return refuse(originError(added.error) ?? "That comment could not be posted.", 403);
    return receipt(`${base}/pulls/${pull.number}#conversation`, "Comment posted");
  }
  // The `…Through` twin, as every door that opens an issue: on a mirror the
  // origin creates it.
  const opened = await openIssueThrough(ctx.app, user, repo, {
    title: reportTitle(text),
    body: said,
  });
  if (!opened.ok) {
    return refuse(
      originError(opened.error) ??
        (opened.error === "body_too_long"
          ? "That is too long to send in one go."
          : "That could not be sent."),
      opened.error === "body_too_long" ? 422 : opened.error === "not_found" ? 404 : 403,
    );
  }
  return receipt(`${base}/issues/${opened.value.number}`, "Issue opened");

  function receipt(href: string, title: string): Response {
    return page({
      ctx,
      title,
      body: html`<div class="narrow-wide">
        ${pageHead(title)}
        <p><a href="${href}">See it</a></p>
        <div class="form-actions">${btn("Back to the page", { href: back, variant: "ghost" })}</div>
      </div>`,
    });
  }
}
