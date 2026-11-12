/**
 * Issue pages: one issue with its timeline, and the compose form. The list
 * is the studio's (`tellsList`, `src/web/studio/lists.ts`). Prose is
 * markdown; every state change is a plain form post to its own endpoint.
 * Mobile-first, no JavaScript required.
 */

import { PAUSE_REFUSAL } from "../../core/planner_pause.ts";
import {
  addCommentThrough,
  openIssueThrough,
  setIssueSealed,
} from "../../actions/issues.ts";
import type { Issue } from "../../core/issues.ts";
import { canRead, getRepo, listReposWritableTo, type Repo } from "../../core/repos.ts";
import { privateRepoForSealed } from "../../actions/repos.ts";
import { sealedWords, sealRefusedWords } from "../../actions/seal_issue_words.ts";
import { BODY_TOO_LONG, TITLE_TOO_LONG } from "../../actions/thread_limits_words.ts";
import { COMMENT_EMPTY, COMMENT_NOT_POSTED } from "../../actions/comment_words.ts";
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
import { html, raw, type Html } from "../html.ts";
import { flashTo, page, redirect } from "../layout.ts";
import { cleanFrom, repoOfPath, withFromLine } from "../issue_from.ts";
import { btn, empty, field as formField, listCard, row } from "../ui.ts";
import {
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
  values: { title: string; body: string; sealed?: boolean; from?: string | undefined },
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
  values: { title: string; body: string; sealed?: boolean; from?: string | undefined },
  submit: string,
  cancelHref: string,
  error?: string,
): Html {
  return html`<div class="narrow-wide mt">
    <form method="post" action="${repoBase(repo)}/issues/new">
      ${values.from === undefined
        ? null
        : html`<input type="hidden" name="from" value="${values.from}" />
            <p class="small muted">From <code>${values.from}</code></p>`}
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
        ${btn("Cancel", { href: cancelHref, variant: "link" })}
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
  // `?sealed=1`: the repository page's "report it sealed" link.
  const sealed = ctx.url.searchParams.get("sealed") === "1";
  if (!ctx.auth.user) {
    const open = timePhase(request, "access", () => canRead(ctx.app.db, repo, undefined));
    return timePhase(request, "render", () =>
      open ? accountOrReport(ctx, repo, sealed) : signInFirst(ctx),
    );
  }
  return timePhase(request, "render", () =>
    composePage(ctx, repo, { title: "", body: "", sealed, from: cleanFrom(ctx.url.searchParams.get("from")) }),
  );
}

/**
 * A stranger who asked to open an issue on a public repository: both doors,
 * the one that needs an account and the one that does not, rather than a
 * sign-in page that never says the second exists. A stranger who asked for
 * a sealed report (security.txt's Contact) is offered only the account: the
 * report without one is not sealed, and there is no sealed door without one.
 */
function accountOrReport(ctx: Ctx, repo: Repo, sealed: boolean): Response {
  const signIn = (variant: "primary" | "ghost") =>
    btn("Sign in", { href: signInHref(ctx), variant });
  const door = sealed
    ? empty({
        icon: "issue",
        title: "A sealed security report needs an account",
        note:
          "Only the people who keep this repository see it until its fix is released. " +
          "The report without an account is not sealed: do not use it for a vulnerability.",
        action: signIn("primary"),
      })
    : empty({
        icon: "issue",
        title: "Opening an issue needs an account",
        note: "Something wrong? You can report it without one; a person who keeps this repository reads it.",
        action: html`${btn("Report a problem", {
          href: `${repoBase(repo)}/report`,
          variant: "primary",
        })}
        ${signIn("ghost")}`,
      });
  return page({
    ctx,
    title: `New issue · ${repo.ownerName}/${repo.name}`,
    crumbs: crumbsFor(repo),
    body: html`${repoHeader(ctx, repo, "issues", {
        compact: true,
        ownTitle: true,
      })}
      ${door}`,
  });
}

// GET /new/issue[?from=/path]
/**
 * The header's door: signed out, the sign-in path; from a page inside a
 * repository, that repository's form; anywhere else, a picker over the
 * repositories the viewer may write. Each carries `from` along.
 */
export function newIssueAnywhere(ctx: Ctx): Response {
  const user = ctx.auth.user;
  if (user === undefined) return signInFirst(ctx);
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const from = cleanFrom(ctx.url.searchParams.get("from"));
  const query = from === undefined ? "" : `?from=${encodeURIComponent(from)}`;
  const named = from === undefined ? undefined : repoOfPath(from);
  const here = named && getRepo(ctx.app.db, named[0], named[1]);
  if (here && canRead(ctx.app.db, here, user))
    return redirect(`${repoBase(here)}/issues/new${query}`);
  const repos = listReposWritableTo(ctx.app.db, user, { limit: 200, withoutArchived: true });
  const rendering = performance.now();
  const response = page({
    ctx,
    title: "New issue",
    body: html`<div class="page-head"><h1>New issue</h1></div>
      ${repos.length === 0
        ? empty({ icon: "issue", title: "No repository to open an issue in", note: "Open one from a repository you can see." })
        : html`<p class="muted">Which repository?</p>${listCard(
            repos.map((r) =>
              row({
                href: `${repoBase(r)}/issues/new${query}`,
                nav: true,
                title: html`<span class="truncate">${r.ownerName}/${r.name}</span>`,
              }),
            ),
          )}`}`,
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

// POST /:owner/:name/issues/new
export async function newIssueSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;

  const from = cleanFrom(field(form, "from"));
  const typed = {
    title: field(form, "title"),
    body: field(form, "body"),
    sealed: form.get("sealed") !== null,
    ...(from === undefined ? {} : { from }),
  };
  // The line naming the page is added to what is stored, never to what is
  // sent back to the form on a refusal.
  const values = { ...typed, body: withFromLine(typed.body, from) };
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
          ? TITLE_TOO_LONG
          : created.error === "body_too_long"
            ? BODY_TOO_LONG
            : created.error === "planner_paused"
              ? PAUSE_REFUSAL
              : "You cannot open an issue here.");
    return composePage(ctx, repo, typed, message);
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
      ? { message: sealedWords(sealed) }
      : { tone: "danger", message: sealRefusedWords(done.error) },
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

/**
 * Where a comment returns to when the form names a fixed word: never a URL
 * from the form. A refused reply from the feed returns there too, as the
 * pull's does; one from the board keeps the issue page, where it always went.
 */
const BACK = new Map<string, { to: string; said: (n: number) => string; refusedTo?: string }>([
  ["board", { to: "/board", said: (n) => `Answered on #${n}. The planner plans again.` }],
  ["feed", { to: "/feed", said: () => "Reply posted.", refusedTo: "/feed" }],
]);

// POST /:owner/:name/issues/:number/comments
export async function issueCommentSubmit(ctx: Ctx): Promise<Response> {
  const found = threadContext(ctx, "issue");
  if (found instanceof Response) return found;
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;

  // A comment posted from the board's "the planner declined" line returns to
  // the board. A fixed word, never a URL from the form: no open redirect.
  const back = BACK.get(field(form, "back"));
  const dest = `${repoBase(found.repo)}/issues/${found.issue.number}`;
  const refusedTo = back?.refusedTo ?? dest;
  const body = field(form, "body");
  if (body.trim() === "")
    return flashTo(ctx, refusedTo, {
      tone: "danger",
      message: COMMENT_EMPTY,
    });
  const added = await addCommentThrough(
    ctx.app,
    ctx.auth.user,
    found.repo,
    found.issue,
    body,
  );
  if (!added.ok)
    return flashTo(ctx, refusedTo, {
      tone: "danger",
      message: originError(added.error) ?? COMMENT_NOT_POSTED,
    });
  return back === undefined
    ? flashTo(ctx, `${dest}#conversation`, { message: "Comment posted." })
    : flashTo(ctx, back.to, {
        message: back.said(found.issue.number),
      });
}

export { parseNumber };
export type { Issue };
