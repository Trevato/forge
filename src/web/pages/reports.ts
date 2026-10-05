/**
 * Reports from outside, the person's side (`actions/reports.ts`): the form
 * anyone fills on a public repository, and the queue its writers read. A
 * report shows as plain text in a box that says where it came from — never
 * markdown, so no link or image of a stranger's renders.
 */

import {
  acceptReport,
  dismissReport,
  fileReport,
  waitingReports,
} from "../../actions/reports.ts";
import {
  BODY_MAX,
  OUTSIDE_TITLE,
  REQUEST_MAX,
  TITLE_MAX,
  outsideWords,
  type Report,
} from "../../core/reports.ts";
import { canRead, type Repo } from "../../core/repos.ts";
import { scopeAllows } from "../../core/tokens.ts";
import type { Ctx } from "../../http/context.ts";
import { clientAddress } from "../../http/peer.ts";
import {
  crumbsFor,
  loadRepo,
  notFoundPage,
  repoBase,
  repoHeader,
  repoPalette,
  signInFirst,
} from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { btn, card, empty, field as formField, time } from "../ui.ts";

/** The repository, when it takes reports: public, and so seen by anyone. */
function publicRepo(ctx: Ctx): Repo | undefined {
  const repo = loadRepo(ctx);
  return repo !== undefined && canRead(ctx.app.db, repo, undefined)
    ? repo
    : undefined;
}

interface FormValues {
  title: string;
  body: string;
  page: string;
}

function reportForm(
  ctx: Ctx,
  repo: Repo,
  values: FormValues,
  error?: string,
  status = 200,
): Response {
  const base = repoBase(repo);
  return page(
    {
      ctx,
      title: `Report a problem · ${repo.ownerName}/${repo.name}`,
      crumbs: crumbsFor(repo),
      body: html`${repoHeader(ctx, repo, "issues", {
          compact: true,
          ownTitle: true,
        })}
        <h1 class="mt">Report a problem</h1>
        <div class="narrow-wide mt">
          <p>
            Tell the people who keep ${repo.ownerName}/${repo.name} that
            something is wrong. You need no account. A person reads it first;
            nothing acts on it before they do.
          </p>
          <form class="mt" method="post" action="${base}/report">
            ${when(error, (m) => html`<p class="error-note">${m}</p>`)}
            ${formField({
              label: "What is wrong",
              name: "title",
              value: values.title,
              required: true,
              autofocus: true,
              hint: `One line, at most ${TITLE_MAX} characters.`,
            })}
            ${formField({
              label: "What happened",
              name: "body",
              type: "textarea",
              rows: 8,
              value: values.body,
              hint: `Plain text, at most ${BODY_MAX} characters. What you did, what you saw, what you expected.`,
            })}
            <input type="hidden" name="page" value="${values.page}" />
            <div hidden aria-hidden="true">
              <label
                >Leave this empty
                <input
                  name="website"
                  type="text"
                  tabindex="-1"
                  autocomplete="off"
              /></label>
            </div>
            <div class="form-actions">
              ${btn("Send report", { variant: "primary", icon: "issue" })}
            </div>
          </form>
        </div>`,
    },
    status,
  );
}

// GET /:owner/:name/report
export function reportPage(ctx: Ctx): Response {
  const repo = publicRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (ctx.url.searchParams.get("sent") === "1")
    return page({
      ctx,
      title: `Report sent · ${repo.ownerName}/${repo.name}`,
      crumbs: crumbsFor(repo),
      body: html`${repoHeader(ctx, repo, "issues", {
        compact: true,
        ownTitle: true,
      })}
      ${empty({
        icon: "check",
        title: "Report sent",
        note: "A person who keeps this repository will read it.",
      })}`,
    });
  return reportForm(ctx, repo, {
    title: "",
    body: "",
    page: ctx.url.searchParams.get("from") ?? "",
  });
}

const REFUSED: Record<string, string> = {
  empty_title: "Say in one line what is wrong.",
  title_too_long: `That line is too long (${TITLE_MAX} characters at most).`,
  body_too_long: `That is too long (${BODY_MAX} characters at most).`,
  queue_full: "Many reports are waiting here already. Try again later.",
};

// POST /:owner/:name/report
export async function reportSubmit(ctx: Ctx): Promise<Response> {
  const repo = publicRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (Number(ctx.request.headers.get("content-length") ?? 0) > REQUEST_MAX)
    return new Response("too large", { status: 413 });
  const form = await readForm(ctx);
  if (form instanceof Response) return form;
  const values = {
    title: field(form, "title"),
    body: field(form, "body"),
    page: field(form, "page"),
  };
  const sent = `${repoBase(repo)}/report?sent=1`;
  // Only a script fills a field no person can see; it is told what a
  // person is told, and nothing is kept.
  if (field(form, "website") !== "")
    return flashTo(ctx, sent, { message: "Report sent." });
  const filed = fileReport(ctx.app, repo, values, clientAddress(ctx.request));
  if (filed.ok) return flashTo(ctx, sent, { message: "Report sent." });
  const refusal = filed.error;
  if (refusal.error === "not_found") return notFoundPage(ctx);
  if (refusal.error === "rate_limited") {
    const response = reportForm(
      ctx,
      repo,
      values,
      `Too many reports just now. Try again in ${refusal.retryAfter} seconds.`,
      429,
    );
    response.headers.set("retry-after", String(refusal.retryAfter));
    return response;
  }
  return reportForm(
    ctx,
    repo,
    values,
    REFUSED[refusal.error],
    refusal.error === "queue_full" ? 429 : 422,
  );
}

function reportCard(base: string, report: Report): Html {
  const action = (verb: "accept" | "dismiss") =>
    `${base}/reports/${report.id}/${verb}`;
  const accept = `accept-${report.id}`;
  return card(
    html`<p><strong>${report.title}</strong></p>
      ${when(
        report.body !== "",
        () => html`<pre class="commit-body">${report.body}</pre>`,
      )}
      ${when(report.page, (p) => html`<p class="hint">Sent from ${p}</p>`)}
      <form
        class="mt"
        id="${accept}"
        method="post"
        action="${action("accept")}"
      >
        ${formField({
          label: "Title of the issue",
          name: "title",
          id: `title-${report.id}`,
          value: outsideWords(report.title),
          required: true,
          hint: `It opens as “${OUTSIDE_TITLE.trim()}” and then these words. Change the words if you like; the mark stays.`,
        })}
      </form>`,
    {
      tone: "attn",
      head: html`From outside, not checked · ${time(report.createdAt)}`,
      foot: html`${btn("Accept as an issue", {
          variant: "primary",
          icon: "issue",
          form: accept,
        })}
        <form method="post" action="${action("dismiss")}">
          ${btn("Dismiss", { variant: "ghost" })}
        </form>`,
    },
  );
}

// GET /:owner/:name/reports
export function reportsPage(ctx: Ctx): Response {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  // A read-only token (an app process holds its owner's) never reads them.
  if (ctx.auth.scope === undefined || !scopeAllows(ctx.auth.scope, "rw"))
    return notFoundPage(ctx);
  const waiting = waitingReports(ctx.app, ctx.auth.user, repo);
  if (!waiting.ok) return notFoundPage(ctx);
  const base = repoBase(repo);
  return page({
    ctx,
    title: `Reports from outside · ${repo.ownerName}/${repo.name}`,
    crumbs: crumbsFor(repo),
    palette: repoPalette(ctx, repo),
    body: html`${repoHeader(ctx, repo, "issues", {
        compact: true,
        ownTitle: true,
      })}
      <h1 class="mt">Reports from outside</h1>
      <p class="hint">
        Sent without an account. No agent sees one until you accept it; then it
        is your issue, with the words quoted.
      </p>
      <div class="mt">
        ${waiting.value.length === 0
          ? empty({
              icon: "check",
              title: "Nothing waiting",
              note: `Anyone can report a problem at ${base}/report.`,
            })
          : waiting.value.map((r) => reportCard(base, r))}
      </div>`,
  });
}

// POST /:owner/:name/reports/:id/accept
export async function reportAcceptSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const accepted = await acceptReport(
    ctx.app,
    ctx.auth.user,
    repo,
    ctx.params.id ?? "",
    form.has("title") ? field(form, "title") : undefined,
  );
  const base = repoBase(repo);
  if (!accepted.ok)
    return accepted.error === "not_found" || accepted.error === "forbidden"
      ? notFoundPage(ctx)
      : flashTo(ctx, `${base}/reports`, {
          tone: "danger",
          message:
            accepted.error === "decided"
              ? "Someone already decided that report."
              : accepted.error === "empty_title"
                ? "The issue needs a title. The report is still waiting."
                : accepted.error === "title_too_long"
                  ? `That title is too long (${TITLE_MAX} characters at most). The report is still waiting.`
                  : "That report could not become an issue.",
        });
  return flashTo(ctx, `${base}/issues/${accepted.value.number}`, {
    message: `Accepted as issue #${accepted.value.number}.`,
  });
}

// POST /:owner/:name/reports/:id/dismiss
export async function reportDismissSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const dismissed = dismissReport(
    ctx.app,
    ctx.auth.user,
    repo,
    ctx.params.id ?? "",
  );
  if (!dismissed.ok && dismissed.error !== "decided") return notFoundPage(ctx);
  return flashTo(ctx, `${repoBase(repo)}/reports`, {
    message: "Dismissed.",
  });
}
