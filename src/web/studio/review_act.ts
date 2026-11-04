/**
 * Acting from `/review`: Merge, Close, Request changes and Reply on the ask
 * a row shows, each a plain form POST to `/review/act`. Nothing here is a
 * second road: a merge is `mergePull` (the landing gate), a close the same
 * `setIssueStateThrough` the pull page uses, a verdict `submitReview`, a
 * reply `addCommentThrough` — with the same access checks, behind `readForm`
 * (same-origin, `rw` scope). A person who acted lands on the next ask.
 */

import type { Database } from "bun:sqlite";
import { mergePull, submitReview } from "../../actions/pulls.ts";
import { addCommentThrough, setIssueStateThrough } from "../../actions/issues.ts";
import { reviewWords } from "../../actions/review_words.ts";
import { getIssue } from "../../core/issues.ts";
import { getPull } from "../../core/pulls.ts";
import { canRead, getRepo, listReposVisibleTo } from "../../core/repos.ts";
import type { User } from "../../core/users.ts";
import type { Ctx } from "../../http/context.ts";
import { notFoundPage, signInFirst } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { flashTo, redirect } from "../layout.ts";
import { btn } from "../ui.ts";
import { originError } from "../pages/thread.ts";
import { mergeFailure } from "../pages/pull.ts";
import { askAnchor, waitingOn } from "./asks.ts";

type Ask = ReturnType<typeof waitingOn>[number];

const VERBS = ["merge", "close", "changes", "reply"] as const;
type Verb = (typeof VERBS)[number];

/** Every ask waiting on `user`, newest first: the order `/review` draws and acts in. */
export function orderedAsks(db: Database, user: User): Ask[] {
  const repos = listReposVisibleTo(db, user, { limit: 200, withoutArchived: true });
  return waitingOn(db, user, repos).sort((a, b) => Date.parse(b.since) - Date.parse(a.since));
}

/** The row's anchor, so a redirect can land on the ask after the one acted on. */
export const rowId = (a: Ask): string => `ask-${askAnchor(a.id)}`;

/** Which of the four a row offers: a pull all of them, an issue close and reply, anything else none. */
export function verbsFor(a: Ask): readonly Verb[] {
  return a.pull !== undefined ? VERBS : a.issue !== undefined ? ["close", "reply"] : [];
}

/** The buttons and boxes under a row (a guest's pull from another forge says Approve and Decline), a sibling of its link; `undefined` when it offers none. */
export function actRow(a: Ask, guest = false): Html | undefined {
  const verbs = verbsFor(a);
  const number = a.pull?.number ?? a.issue?.number;
  if (verbs.length === 0 || number === undefined) return undefined;
  const of = `${a.repo.ownerName}/${a.repo.name}`;
  const form = (verb: Verb, inner: Html) =>
    html`<form method="post" action="/review/act" data-verb="${verb}">
      <input type="hidden" name="repo" value="${of}" />
      <input type="hidden" name="number" value="${String(number)}" />
      <input type="hidden" name="verb" value="${verb}" />${inner}
    </form>`;
  const box = (verb: Verb, label: string, send: string) =>
    form(
      verb,
      html`<label class="sr-only" for="${rowId(a)}-${verb}">${label}</label>
        <textarea class="input" id="${rowId(a)}-${verb}" name="body" rows="2" maxlength="65536" required placeholder="${label}"></textarea>
        <div class="form-actions"><span class="spacer"></span>${btn(send)}</div>`,
    );
  const quick = verbs.filter((v) => v === "merge" || v === "close");
  return html`<li data-act-forms>
    <div class="form-actions">${quick.map((v) =>
      form(v, btn(guest ? (v === "merge" ? "Approve" : "Decline") : v === "merge" ? "Merge" : "Close")),
    )}</div>
    ${verbs.includes("changes") ? box("changes", "Request changes: what must change", "Request changes") : null}
    ${box("reply", "Reply", "Reply")}
  </li>`;
}

const back = (a: Ask | undefined): string => (a === undefined ? "/review" : `/review#${rowId(a)}`);

/** POST /review/act  { repo, number, verb, body? } — one action, then the next ask. */
export async function reviewAct(ctx: Ctx): Promise<Response> {
  const user = ctx.auth.user;
  if (!user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;

  const [owner = "", name = ""] = field(form, "repo").split("/");
  const verb = field(form, "verb") as Verb;
  const numberText = field(form, "number");
  if (!VERBS.includes(verb) || !/^\d{1,9}$/.test(numberText) || owner === "" || name === "" || name.includes("/"))
    return flashTo(ctx, "/review", { tone: "danger", message: "That action was not understood." });
  const repo = getRepo(ctx.app.db, owner, name);
  if (repo === undefined || !canRead(ctx.app.db, repo, user)) return notFoundPage(ctx);
  const number = Number(numberText);
  const pull = getPull(ctx.app.db, repo.id, number);
  const issue = pull ?? getIssue(ctx.app.db, repo.id, number);
  if (issue === undefined || ((verb === "merge" || verb === "changes") && pull === undefined)) return notFoundPage(ctx);

  const before = orderedAsks(ctx.app.db, user);
  const acted = (a: Ask) => a.repo.id === repo.id && (a.pull?.number ?? a.issue?.number) === number;
  const at = before.findIndex(acted);
  const here = at < 0 ? undefined : before[at];
  const refuse = (message: string) => flashTo(ctx, back(here), { tone: "danger", message });

  const text = field(form, "body").trim();
  if ((verb === "changes" || verb === "reply") && text === "")
    return refuse(verb === "reply" ? "A reply needs something in it." : "Say what must change.");

  let done: string;
  if (verb === "merge") {
    const merged = await mergePull(ctx.app, user, repo, pull!, "merge");
    if (!merged.ok) return refuse(mergeFailure(merged.error));
    done = "Merged.";
  } else if (verb === "close") {
    const closed = await setIssueStateThrough(ctx.app, user, repo, issue, "closed");
    if (!closed.ok)
      return refuse(
        originError(closed.error) ??
          (closed.error === "forbidden"
            ? "Only the author or someone with write access can do that."
            : "That could not be closed."),
      );
    done = "Closed.";
  } else if (verb === "changes") {
    const reviewed = await submitReview(ctx.app, user, repo, pull!, { state: "changes_requested", body: text });
    if (!reviewed.ok)
      return refuse(
        originError(reviewed.error) ??
          (reviewed.error === "forbidden"
            ? reviewWords.forbidden
            : reviewed.error === "body_too_long"
              ? reviewWords.tooLong
              : "That review could not be recorded."),
      );
    done = "Changes requested.";
  } else {
    const posted = await addCommentThrough(ctx.app, user, repo, issue, text);
    if (!posted.ok)
      return refuse(originError(posted.error) ?? (posted.error === "body_too_long" ? "That reply is too long." : "That reply could not be posted."));
    done = "Reply posted.";
  }

  // The next ask: the first one that followed this row and still waits; if
  // this was the last, the first that remains.
  const after = orderedAsks(ctx.app.db, user).filter((a) => !acted(a));
  const later = new Set(before.slice(at + 1).map((a) => a.id));
  const next = at < 0 ? after[0] : (after.find((a) => later.has(a.id)) ?? after[0]);
  return redirect(back(next), { flash: { message: done }, url: ctx.url, forgeUrl: ctx.app.config.url });
}
