/**
 * Issue pages: one issue with its timeline, and the compose form. The list
 * is the studio's (`tellsList`, `src/web/studio/lists.ts`). Prose is
 * markdown; every state change is a plain form post to its own endpoint.
 * Mobile-first, no JavaScript required.
 */

import { addCommentThrough, openIssueThrough } from "../../actions/issues.ts";
import { labelsFor, listLabels, type Issue } from "../../core/issues.ts";
import { canRead, type Repo } from "../../core/repos.ts";
import type { Ctx } from "../../http/context.ts";
import {
  crumbsFor,
  loadRepo,
  notFoundPage,
  repoBase,
  repoHeader,
  repoPalette,
  signInFirst,
  signInHref,
} from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { flashTo, page, redirect } from "../layout.ts";
import { liveClientJs, liveMount } from "../live.ts";
import {
  btn,
  empty,
  icon,
  labelCss,
  originTag,
  stateBadge,
  time,
  userLink,
  field as formField,
} from "../ui.ts";
import {
  assigneeCard,
  dependenciesCard,
  composer,
  conversation,
  labelsCard,
  originError,
  originGlyph,
  parseNumber,
  threadContext,
  threadFragment,
} from "./thread.ts";
import { crewActivityCard, workSpent } from "./runs.ts";
import {
  PAGE_TITLES,
  pageTitle,
  studioRecord,
  tellsHref,
} from "../studio/nouns.ts";
import { studioTell } from "../studio/tell.ts";

// ---- compose ----

/**
 * The compose page, in the face the viewer has: the studio's own noun for
 * it (`PAGE_TITLES.compose`) on the tab, the heading and the button, and
 * Cancel back to the list that face calls home. The form posts to
 * `/issues/new` in both faces — the one door that changes something.
 */
function composePage(
  ctx: Ctx,
  repo: Repo,
  values: { title: string; body: string },
  error?: string,
): Response {
  const studio = studioRecord(ctx, repo) !== undefined;
  const heading = PAGE_TITLES.compose[studio ? "studio" : "dev"];
  const base = repoBase(repo);
  return page(
    {
      ctx,
      title: pageTitle("compose", repo, studio),
      crumbs: crumbsFor(repo),
      palette: repoPalette(ctx, repo),
      body: html`${repoHeader(ctx, repo, "issues", {
          compact: true,
          ownTitle: true,
        })}
        <h1 class="mt">${heading}</h1>
        ${newIssueForm(
          repo,
          values,
          studio ? "Tell" : "Create issue",
          studio ? tellsHref(base) : `${base}/issues`,
          error,
        )}`,
    },
    error === undefined ? 200 : 422,
  );
}

function newIssueForm(
  repo: Repo,
  values: { title: string; body: string },
  submit: string,
  cancelHref: string,
  error?: string,
): Html {
  return html`<div class="narrow-wide mt">
    <form method="post" action="${repoBase(repo)}/issues/new">
      ${when(error, (message) => html`<p class="error-note">${message}</p>`)}
      ${formField({
        label: "Title",
        name: "title",
        value: values.title,
        required: true,
        autofocus: true,
        ...(error ? { error } : {}),
      })}
      ${formField({
        label: "Description",
        name: "body",
        type: "textarea",
        rows: 10,
        value: values.body,
        hint: "Markdown is supported.",
      })}
      <div class="form-actions">
        ${btn(submit, { variant: "primary", icon: "issue" })}
        ${btn("Cancel", { href: cancelHref, variant: "ghost" })}
      </div>
    </form>
  </div>`;
}

// GET /:owner/:name/issues/new
export function newIssuePage(ctx: Ctx): Response {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user)
    return canRead(ctx.app.db, repo, undefined)
      ? accountOrReport(ctx, repo)
      : signInFirst(ctx);
  return composePage(ctx, repo, { title: "", body: "" });
}

/**
 * A stranger who asked to open an issue on a public repository: both doors,
 * the one that needs an account and the one that does not, rather than a
 * sign-in page that never says the second exists.
 */
function accountOrReport(ctx: Ctx, repo: Repo): Response {
  const base = repoBase(repo);
  return page({
    ctx,
    title: `New issue · ${repo.ownerName}/${repo.name}`,
    crumbs: crumbsFor(repo),
    body: html`${repoHeader(ctx, repo, "issues", {
        compact: true,
        ownTitle: true,
      })}
      ${empty({
        icon: "issue",
        title: "Opening an issue needs an account",
        note: "Something wrong? You can report it without one; a person who keeps this repository reads it.",
        action: html`${btn("Report a problem", {
          href: `${base}/report`,
          variant: "primary",
        })}
        ${btn("Sign in", { href: signInHref(ctx), variant: "ghost" })}`,
      })}`,
  });
}

// GET /:owner/:name/tells/new — the studio's own door onto the compose page
// `/issues/new` reaches, redirecting there when the studio does not apply,
// the same rule `tellPage` follows for one tell.
export function newTellPage(ctx: Ctx): Response {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (studioRecord(ctx, repo) === undefined)
    return redirect(`${repoBase(repo)}/issues/new${ctx.url.search}`);
  return newIssuePage(ctx);
}

// POST /:owner/:name/issues/new
export async function newIssueSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;

  const values = { title: field(form, "title"), body: field(form, "body") };
  // The `…Through` twin: on a mirror the origin creates the issue, so the
  // number and the timestamps are the origin's rather than ones we invented.
  const created = await openIssueThrough(ctx.app, ctx.auth.user, repo, values);
  if (!created.ok) {
    // Nothing typed is ever lost: the form comes back exactly as it was sent.
    const message =
      originError(created.error) ??
      (created.error === "empty_title"
        ? "An issue needs a title."
        : created.error === "title_too_long"
          ? "That title is too long (256 characters at most)."
          : created.error === "body_too_long"
            ? "That description is too long (64 KB at most)."
            : "You cannot open an issue here.");
    return composePage(ctx, repo, values, message);
  }
  return flashTo(ctx, `${repoBase(repo)}/issues/${created.value.number}`, {
    message: `Issue #${created.value.number} opened.`,
  });
}

// ---- one issue ----

// GET /:owner/:name/issues/:number
export async function issuePage(ctx: Ctx): Promise<Response> {
  const found = threadContext(ctx, "issue");
  if (found instanceof Response) return found;
  const { repo, issue } = found;
  // In the studio a tell is one sentence someone said, not dev's labels and
  // dependency form — the same rule `pullPage` follows for a change, and the
  // same rule `tellPage` below asks before opening this very page under the
  // studio's own noun. `?mode=dev` on the URL is the escape hatch to dev's
  // page, resolved once for `ctx.mode`.
  if (studioRecord(ctx, repo) !== undefined)
    return await studioTell(ctx, repo, issue);
  const base = repoBase(repo);
  const thread = `${base}/issues/${issue.number}`;

  const applied = labelsFor(ctx.app.db, issue.id);
  const all = listLabels(ctx.app.db, repo.id);
  const talk = conversation(ctx, repo, issue, { openVerb: "opened this" });

  const body = html`${repoHeader(ctx, repo, "issues", {
      compact: true,
      ownTitle: true,
    })}
    <div class="issue-head">
      <h1>${issue.title} <span class="number">#${issue.number}</span></h1>
      <div class="issue-meta">
        ${stateBadge(issue.state)}
        <span
          >${issue.originAuthor
            ? originTag(issue.originAuthor, originGlyph(repo))
            : userLink(issue.authorName)}
          opened this ${time(issue.createdAt)}</span
        >
        ${when(
          issue.originUrl,
          (url) =>
            html`<a class="origin-link" href="${url}" rel="noreferrer noopener"
              >${icon("external")}view on origin</a
            >`,
        )}
        ${workSpent(ctx, repo, issue.id)}
      </div>
    </div>
    <div class="split">
      <div>
        ${talk.node}
        ${composer(ctx, {
          action: `${thread}/comments`,
          stateAction: `${thread}/state`,
          state: issue.state,
          closeLabel: "Close issue",
          reasons: true,
        })}
      </div>
      <aside>
        ${assigneeCard(ctx, repo, issue, `${thread}/assignee`)}
        ${dependenciesCard(ctx, repo, issue, `${thread}/dependencies`)}
        ${labelsCard(ctx, repo, issue, applied, all, `${thread}/labels`)}
        ${crewActivityCard(ctx, repo, issue)}
      </aside>
    </div>
    ${liveMount({
      repo: base,
      thread: "issue",
      number: issue.number,
      lastCommentId: talk.lastCommentId,
    })}`;

  return page({
    ctx,
    title: `${issue.title} · ${repo.name}`,
    crumbs: crumbsFor(repo),
    palette: repoPalette(ctx, repo),
    body,
    styleCss: labelCss([...all, ...applied]),
    scriptJs: liveClientJs,
  });
}

/**
 * GET /:owner/:name/tells/:number — the studio's own noun for the page
 * `/issues/:number` already reaches. The page is `studioTell`, rendered
 * from here exactly as `issuePage` renders it: one handler each, never a
 * second copy of the page, and the same `threadContext` for who may see it,
 * so a reader who may not gets the forge's not-found at either address.
 *
 * A viewer the studio's tell does not apply to — dev mode, `?mode=dev`, or
 * a repository that is not an app — is sent on to `/issues/:number`, dev's
 * own address, the same rule `tellsList` follows for the list. The other
 * direction never bounces: `/issues/:number` asked for in studio mode
 * answers the studio's page where it stands, so every link ever written to
 * it keeps working and no reader is redirected out of a URL they were
 * handed.
 */
export async function tellPage(ctx: Ctx): Promise<Response> {
  const found = threadContext(ctx, "issue");
  if (found instanceof Response) return found;
  const { repo, issue } = found;
  if (studioRecord(ctx, repo) === undefined)
    return redirect(
      `${repoBase(repo)}/issues/${issue.number}${ctx.url.search}`,
    );
  return await studioTell(ctx, repo, issue);
}

// GET /:owner/:name/issues/:number/thread?after=<id>
export function issueThreadFragment(ctx: Ctx): Response {
  return threadFragment(ctx, "issue");
}

// POST /:owner/:name/issues/:number/comments
export async function issueCommentSubmit(ctx: Ctx): Promise<Response> {
  const found = threadContext(ctx, "issue");
  if (found instanceof Response) return found;
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;

  // A comment posted from the board's "the planner declined" line returns to
  // the board. A fixed word, never a URL from the form: no open redirect.
  const back = field(form, "back") === "board" ? "/board" : undefined;
  const dest = `${repoBase(found.repo)}/issues/${found.issue.number}`;
  const body = field(form, "body");
  if (body.trim() === "")
    return flashTo(ctx, dest, {
      tone: "danger",
      message: "A comment needs something in it.",
    });
  const added = await addCommentThrough(
    ctx.app,
    ctx.auth.user,
    found.repo,
    found.issue,
    body,
  );
  if (!added.ok)
    return flashTo(ctx, dest, {
      tone: "danger",
      message: originError(added.error) ?? "That comment could not be posted.",
    });
  return back === undefined
    ? flashTo(ctx, `${dest}#conversation`, { message: "Comment posted." })
    : flashTo(ctx, back, {
        message: `Answered on #${found.issue.number}. The planner plans again.`,
      });
}

export { parseNumber };
export type { Issue };
