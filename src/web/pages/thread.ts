/**
 * What an issue and a pull request have in common: a number, a conversation,
 * a label set, and a composer. Both pages are the same document with a
 * different spine, so the spine lives here once.
 *
 * The conversation is a two-tier timeline, deliberately: comments are cards
 * with weight, and state changes are one muted line with an icon. That rhythm
 * is what makes a long thread skimmable.
 */

import {
  setIssueLabelsThrough,
  setIssueStateThrough,
} from "../../actions/issues.ts";
import { listEvents } from "../../core/events.ts";
import type { Issue, Label } from "../../core/issues.ts";
import { getIssue, labelsFor, listComments } from "../../core/issues.ts";
import { canWrite, type Repo } from "../../core/repos.ts";
import type { IconName as Glyph } from "../icons.ts";
import { getUserById } from "../../core/users.ts";
import type { Ctx } from "../../http/context.ts";
import { commentCard } from "../comments.ts";
import { field, readForm } from "../form.ts";
import { html, raw, when, type Html } from "../html.ts";
import { flashTo } from "../layout.ts";
import {
  btn,
  card,
  icon,
  labelChip,
  time,
  tlComment,
  tlEvent,
  userLink,
  type IconName,
  type Tone,
} from "../ui.ts";
import { loadRepo, notFoundPage, repoBase, signInFirst } from "../chrome.ts";

/**
 * The four ways a write can fail *because of the origin*, in words.
 *
 * They are worth their own sentences: three of them mean nothing changed
 * anywhere and the fourth means the change belongs on another forge, and a
 * generic "that could not be saved" would hide which. Returns undefined for
 * anything that is not an origin outcome, so callers keep their own wording.
 */
export function originError(error: string): string | undefined {
  const words: Record<string, string> = {
    mirrored:
      "This repository mirrors an origin — do it there, and the next sync brings it back.",
    origin_owner_only:
      "Only the person who connected this origin can write through it. Your comment would otherwise appear upstream under their name.",
    origin_refused:
      "The origin refused that. Nothing was changed here either.",
    origin_unreachable:
      "The origin could not be reached. Nothing was changed.",
  };
  return words[error];
}

/** The origin's mark, when this repo has one. */
export function originGlyph(repo: Repo): Glyph {
  return repo.origin?.kind ?? "globe";
}

/** An issue number from a URL segment: digits only, and never a leading zero. */
export function parseNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^[1-9][0-9]{0,8}$/.test(raw)) return undefined;
  return Number(raw);
}

/** The pieces every thread mutation needs, or the response that refuses it. */
export function threadContext(
  ctx: Ctx,
  kind: "issue" | "pull",
): { repo: Repo; issue: Issue } | Response {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const number = parseNumber(ctx.params.number);
  const issue =
    number === undefined ? undefined : getIssue(ctx.app.db, repo.id, number);
  if (!issue || issue.kind !== kind) return notFoundPage(ctx);
  return { repo, issue };
}

// ---- timeline ----

interface Entry {
  at: string;
  node: Html;
}

const EVENT_LOOK: Record<string, { icon: IconName; tone: Tone; verb: string }> =
  {
    "issue.closed": {
      icon: "issueClosed",
      tone: "danger",
      verb: "closed this",
    },
    "issue.reopened": { icon: "issue", tone: "success", verb: "reopened this" },
    "pull.closed": { icon: "x", tone: "danger", verb: "closed this" },
    "pull.reopened": { icon: "pull", tone: "success", verb: "reopened this" },
    "pull.merged": { icon: "merge", tone: "merged", verb: "merged this" },
    "issue.labeled": {
      icon: "tag",
      tone: "default",
      verb: "changed the labels",
    },
    "pull.reviewed": {
      icon: "comment",
      tone: "default",
      verb: "reviewed a line",
    },
  };

/**
 * State changes for this thread, read back out of the event outbox — the same
 * durable record webhooks and the stream ride on, so the timeline can never
 * disagree with what actually happened.
 */
function stateEvents(ctx: Ctx, repo: Repo, issue: Issue): Entry[] {
  const events = listEvents(ctx.app.db, { repoId: repo.id, limit: 200 });
  const entries: Entry[] = [];
  for (const event of events) {
    const look = EVENT_LOOK[event.kind];
    if (!look) continue;
    if (Number(event.payload.number) !== issue.number) continue;
    const actor =
      event.actorId !== null
        ? getUserById(ctx.app.db, event.actorId)
        : undefined;
    entries.push({
      at: event.createdAt,
      node: tlEvent({
        icon: look.icon,
        tone: look.tone,
        body: html`${actor
            ? userLink(actor.username)
            : html`<span>someone</span>`} <span>${look.verb}</span> ${time(
            event.createdAt,
          )}`,
      }),
    });
  }
  return entries;
}

export interface ConversationOptions {
  /** The verb on the opening card ("opened this", "wants to merge …"). */
  openVerb: Html | string;
}

/**
 * The whole thread: the opening post, every comment, and the state changes
 * between them, in time order. The container id is what the live client
 * appends into, so it never moves.
 */
export function conversation(
  ctx: Ctx,
  repo: Repo,
  issue: Issue,
  options: ConversationOptions,
): { node: Html; lastCommentId: string } {
  // Conversation comments only: a line-anchored review comment belongs to the
  // diff, and showing it in both places says the same thing twice.
  const comments = listComments(ctx.app.db, issue.id, { kind: "comment" });
  const glyph = originGlyph(repo);
  const entries: Entry[] = comments.map((c) => ({
    at: c.createdAt,
    node: threadComment(c.id, c.authorName, c.createdAt, c.body, {
      originAuthor: c.originAuthor,
      originKind: glyph,
    }),
  }));
  entries.push(...stateEvents(ctx, repo, issue));
  entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const opening = tlComment(
    commentCard({
      id: "",
      author: issue.authorName,
      at: issue.createdAt,
      body: issue.body,
      verb: options.openVerb,
      originAuthor: issue.originAuthor,
      originKind: glyph,
      originUrl: issue.originUrl,
    }),
  );

  return {
    node: html`<div class="timeline" id="conversation">
      ${opening}${entries.map((e) => e.node)}
    </div>`,
    lastCommentId: comments.length > 0 ? comments[comments.length - 1]!.id : "",
  };
}

/** One comment as a timeline item. The id rides the *outer* node, because
 * that is the node the live client moves into the page. */
export function threadComment(
  id: string,
  author: string,
  at: string,
  body: string,
  origin: { originAuthor?: string | null; originKind?: Glyph } = {},
): Html {
  return html`<div class="tl-item" data-kind="comment" data-comment-id="${id}">
    <span class="tl-dot">${icon("comment")}</span>${commentCard({
      id,
      author,
      at,
      body,
      verb: "commented",
      ...(origin.originAuthor == null
        ? {}
        : { originAuthor: origin.originAuthor }),
      ...(origin.originKind === undefined
        ? {}
        : { originKind: origin.originKind }),
    })}
  </div>`;
}

/**
 * GET …/thread?after=<id> — the comments the page has not seen, as a bare
 * fragment. Served under a `sandbox` CSP with nothing else allowed, so the
 * fragment can only ever be what it is: markup to append.
 */
export function threadFragment(ctx: Ctx, kind: "issue" | "pull"): Response {
  const repo = loadRepo(ctx);
  if (!repo) return new Response("", { status: 404 });
  const number = parseNumber(ctx.params.number);
  const issue =
    number === undefined ? undefined : getIssue(ctx.app.db, repo.id, number);
  if (!issue || issue.kind !== kind) return new Response("", { status: 404 });
  const after = ctx.url.searchParams.get("after") ?? "";
  const fresh = listComments(ctx.app.db, issue.id, {
    kind: "comment",
  }).filter((c) => c.id > after);
  const glyph = originGlyph(repo);
  const fragment = html`${fresh.map((c) =>
    threadComment(c.id, c.authorName, c.createdAt, c.body, {
      originAuthor: c.originAuthor,
      originKind: glyph,
    }),
  )}`;
  return new Response(fragment.text, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        "default-src 'none'; style-src 'none'; sandbox",
    },
  });
}

// ---- composer ----

export interface ComposerOptions {
  /** Where the comment POSTs. */
  action: string;
  /** Where close/reopen POSTs; omitted hides those buttons. */
  stateAction?: string;
  state: "open" | "closed";
  /** A merged pull can never reopen. */
  locked?: boolean;
  kind: "issue" | "pull";
}

/** The comment box. Close and reopen are their own form, not an `intent`
 * rider on this one — one endpoint, one verb. */
export function composer(ctx: Ctx, o: ComposerOptions): Html {
  if (!ctx.auth.user) {
    return card(
      html`<a href="/signin">Sign in</a> to join this conversation.`,
      { extra: "mt" },
    );
  }
  // A close/reopen button *inside* the comment form would be a nested form —
  // invalid HTML, and the browser silently hands the click to the wrong
  // action. The state form sits outside; the button joins it by id.
  const stateForm =
    o.stateAction !== undefined && !o.locked
      ? html`<form method="post" action="${o.stateAction}" id="thread-state">
          <input
            type="hidden"
            name="state"
            value="${o.state === "open" ? "closed" : "open"}"
          />
        </form>`
      : null;
  const closeButton =
    o.stateAction !== undefined && !o.locked
      ? btn(
          o.state === "open"
            ? `Close ${o.kind === "pull" ? "pull request" : "issue"}`
            : "Reopen",
          {
            size: "sm",
            icon: o.state === "open" ? "issueClosed" : "issue",
            form: "thread-state",
          },
        )
      : null;
  return html`${stateForm}
    <form class="card comment-form" method="post" action="${o.action}">
      <label class="sr-only" for="comment-body">Comment</label>
      <textarea
        class="input"
        id="comment-body"
        name="body"
        rows="4"
        data-grow
        placeholder="Leave a comment"
        required
      ></textarea>
      <div class="form-actions">
        <span class="muted small"
          >${icon("file")} Markdown is supported — <code>**bold**</code>,
          <code>[link](url)</code>, <code>&gt; quote</code>.</span
        >
        <span class="spacer"></span>
        ${closeButton}
        ${btn("Comment", { variant: "primary", icon: "comment" })}
      </div>
    </form>`;
}

// ---- labels ----

/** The labels rail: what is on this thread, and (for writers) a form that
 * replaces the whole set in one post. */
export function labelsCard(
  ctx: Ctx,
  repo: Repo,
  issue: Issue,
  applied: Label[],
  all: Label[],
  action: string,
): Html {
  const mayEdit = canWrite(ctx.app.db, repo, ctx.auth.user);
  const chips =
    applied.length === 0
      ? html`<p class="muted small">None yet.</p>`
      : html`<div class="bar">
          ${applied.map((l) =>
            labelChip(
              l,
              `${repoBase(repo)}/${issue.kind === "pull" ? "pulls" : "issues"}?label=${encodeURIComponent(l.name)}`,
            ),
          )}
        </div>`;
  if (!mayEdit || all.length === 0)
    return card(chips, {
      head: html`${icon("tag")}
        <h2>Labels</h2>`,
    });

  const applies = new Set(applied.map((l) => l.id));
  return card(
    html`${chips}
      <form method="post" action="${action}" class="mt">
        <fieldset class="stack">
          <legend class="sr-only">Labels on this thread</legend>
          ${all.map(
            (l) =>
              html`<label class="check">
                <input
                  type="checkbox"
                  name="labels"
                  value="${l.id}"
                  ${applies.has(l.id) ? raw("checked") : null}
                />
                ${labelChip(l)}
              </label>`,
          )}
        </fieldset>
        <div class="form-actions">
          ${btn("Apply labels", { size: "sm", variant: "primary" })}
        </div>
      </form>`,
    {
      head: html`${icon("tag")}
        <h2>Labels</h2>`,
    },
  );
}

// ---- shared mutations ----

/** POST …/:number/state — close or reopen, for both kinds. */
export async function stateSubmit(
  ctx: Ctx,
  kind: "issue" | "pull",
): Promise<Response> {
  const found = threadContext(ctx, kind);
  if (found instanceof Response) return found;
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;

  const wanted = field(form, "state") === "closed" ? "closed" : "open";
  const dest = `${repoBase(found.repo)}/${kind === "pull" ? "pulls" : "issues"}/${found.issue.number}`;
  // The `…Through` twin: identical on a native repo, and on a mirror it
  // closes the issue at the origin first and reflects what came back.
  const changed = await setIssueStateThrough(
    ctx.app,
    ctx.auth.user,
    found.repo,
    found.issue,
    wanted,
  );
  if (!changed.ok) {
    const message =
      originError(changed.error) ??
      (changed.error === "already_merged"
        ? "A merged pull request cannot be reopened."
        : changed.error === "forbidden"
          ? "Only the author or someone with write access can do that."
          : "That could not be changed.");
    return flashTo(ctx, dest, { tone: "danger", message });
  }
  return flashTo(ctx, dest, {
    message: wanted === "closed" ? "Closed." : "Reopened.",
  });
}

/** POST …/:number/labels — replace the label set. Writers only. */
export async function labelsSubmit(
  ctx: Ctx,
  kind: "issue" | "pull",
): Promise<Response> {
  const found = threadContext(ctx, kind);
  if (found instanceof Response) return found;
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;

  const chosen = form
    .getAll("labels")
    .filter((v): v is string => typeof v === "string");
  const dest = `${repoBase(found.repo)}/${kind === "pull" ? "pulls" : "issues"}/${found.issue.number}`;
  const applied = await setIssueLabelsThrough(
    ctx.app,
    ctx.auth.user,
    found.repo,
    found.issue,
    chosen,
  );
  if (!applied.ok) {
    return flashTo(ctx, dest, {
      tone: "danger",
      message:
        originError(applied.error) ??
        (applied.error === "unknown_label"
          ? "One of those labels no longer exists."
          : "You need write access to change labels."),
    });
  }
  return flashTo(ctx, dest, {
    message:
      applied.value.length === 0
        ? "Labels cleared."
        : `Labels set to ${applied.value.map((l) => l.name).join(", ")}.`,
  });
}

export { labelsFor, listComments, when };
