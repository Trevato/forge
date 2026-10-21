/**
 * Issue pages: one issue with its timeline, and the compose form. The list
 * is the studio's (`tellsList`, `src/web/studio/lists.ts`). Prose is
 * markdown; every state change is a plain form post to its own endpoint.
 * Mobile-first, no JavaScript required.
 */

import {
  addCommentThrough,
  openIssueThrough,
  setIssueSealed,
} from "../../actions/issues.ts";
import type { Issue } from "../../core/issues.ts";
import { canRead, type Repo } from "../../core/repos.ts";
import { privateRepoForSealed } from "../../actions/repos.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
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
import { html, raw, when, type Html } from "../html.ts";
import { flashTo, page, redirect } from "../layout.ts";
import { btn, empty, icon, field as formField } from "../ui.ts";
import {
  conversation,
  originError,
  parseNumber,
  threadContext,
  threadFragment,
} from "./thread.ts";
import {
  PAGE_TITLES,
  pageTitle,
  tellsHref,
} from "../studio/nouns.ts";

// ---- compose ----

/**
 * The compose page: `PAGE_TITLES.compose` on the tab, the heading and the
 * button, and Cancel back to the issues list. The form posts to
 * `/issues/new` — the one door that changes something.
 */
function composePage(
  ctx: Ctx,
  repo: Repo,
  values: { title: string; body: string; sealed?: boolean },
  error?: string,
): Response {
  const heading = PAGE_TITLES.compose;
  const base = repoBase(repo);
  return page(
    {
      ctx,
      title: pageTitle("compose", repo, false),
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
          "Create issue",
          tellsHref(base),
          error,
        )}`,
    },
    error === undefined ? 200 : 422,
  );
}

function newIssueForm(
  repo: Repo,
  values: { title: string; body: string; sealed?: boolean },
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
      <div class="field">
        <label class="check">
          <input
            type="checkbox"
            name="sealed"
            ${values.sealed === true ? raw("checked") : null}
          />
          <span
            >Sealed security report — only people who can write here and the
            crew see it, until one of them unseals it.</span
          >
        </label>
      </div>
      <div class="form-actions">
        ${btn(submit, { variant: "primary", icon: "issue" })}
        ${btn("Cancel", { href: cancelHref, variant: "ghost" })}
      </div>
    </form>
  </div>`;
}

// GET /:owner/:name/issues/new
export function newIssuePage(ctx: Ctx): Response {
  const request = ctx.request;
  notePhase(request, "session", takeSessionTime(request));
  const repo = timePhase(request, "repo", () => loadRepo(ctx));
  if (!repo) return timePhase(request, "render", () => notFoundPage(ctx));
  if (!ctx.auth.user) {
    const open = timePhase(request, "access", () => canRead(ctx.app.db, repo, undefined));
    return timePhase(request, "render", () =>
      open ? accountOrReport(ctx, repo) : signInFirst(ctx),
    );
  }
  // `?sealed=1`: the repository page's "report it sealed" link.
  const sealed = ctx.url.searchParams.get("sealed") === "1";
  return timePhase(request, "render", () =>
    composePage(ctx, repo, { title: "", body: "", sealed }),
  );
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

// POST /:owner/:name/issues/new
export async function newIssueSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;

  const values = {
    title: field(form, "title"),
    body: field(form, "body"),
    sealed: form.get("sealed") !== null,
  };
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

// GET /:owner/:name/issues/:number/thread?after=<id>
export function issueThreadFragment(ctx: Ctx): Response {
  return threadFragment(ctx, "issue");
}

// POST /:owner/:name/issues/:number/seal  { sealed: "1" | "0" }
export async function issueSealSubmit(ctx: Ctx): Promise<Response> {
  const found = threadContext(ctx, "issue");
  if (found instanceof Response) return found;
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const sealed = field(form, "sealed") === "1";
  const dest = `${repoBase(found.repo)}/issues/${found.issue.number}`;
  const done = setIssueSealed(
    ctx.app,
    ctx.auth.user,
    found.repo,
    found.issue,
    sealed,
  );
  return flashTo(
    ctx,
    dest,
    done.ok
      ? {
          message: sealed
            ? "Sealed: only people who can write here and the crew see it now."
            : "Unsealed: everyone who can read this repository sees it now.",
        }
      : {
          tone: "danger",
          message:
            done.error === "mirrored"
              ? "A mirror's issues live on its origin, in the open: nothing here can be sealed."
              : "Only someone who can write here seals or unseals.",
        },
  );
}

// POST /:owner/:name/issues/:number/private — the place to fix a sealed report by hand
export async function issuePrivateSubmit(ctx: Ctx): Promise<Response> {
  const found = threadContext(ctx, "issue");
  if (found instanceof Response) return found;
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const made = await privateRepoForSealed(ctx.app, ctx.auth.user, found.repo, found.issue);
  const back = `${repoBase(found.repo)}/issues/${found.issue.number}`;
  if (!made.ok)
    return made.error === "not_found"
      ? notFoundPage(ctx)
      : flashTo(ctx, back, {
          tone: "danger",
          message:
            made.error === "not_sealed"
              ? "This report is not sealed: its fix can be worked in the open."
              : "The private repository could not be made just now.",
        });
  const there = `${made.value.ownerName}/${made.value.name}`;
  return flashTo(ctx, back, {
    message: `Your private repository for sealed work is ${there}: push the fix to ${ctx.url.origin}/${there}.git and open the pull from there, saying "Closes #${found.issue.number}". Only you, this repository's writers and its crew can read it.`,
  });
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
