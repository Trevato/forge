/**
 * What an issue and a pull request have in common: a number, a conversation,
 * a label set, and a composer. Both pages are the same document with a
 * different spine, so the spine lives here once.
 *
 * The conversation is a two-tier timeline, deliberately: comments are cards
 * with weight, and state changes are one muted line with an icon. That rhythm
 * is what makes a long thread skimmable.
 */

import { listCrew } from "../../actions/crew.ts";
import { linkIssue, unlinkIssue } from "../../actions/dependencies.ts";
import { dependenciesOf } from "../../core/dependencies.ts";
import { isCrew } from "../../core/agents.ts";
import {
  assignIssue,
  setIssueLabelsThrough,
  setIssueStateThrough,
} from "../../actions/issues.ts";
import { listEvents } from "../../core/events.ts";
import type { Issue, Label } from "../../core/issues.ts";
import { getIssue, labelsFor, listComments } from "../../core/issues.ts";
import { canRead, canWrite, type Repo } from "../../core/repos.ts";
import type { IconName as Glyph } from "../icons.ts";
import {
  getUserById,
  getUserByName,
  getUsersByIds,
  listPeople,
  type User,
} from "../../core/users.ts";
import type { Ctx } from "../../http/context.ts";
import { commentCard } from "../comments.ts";
import { field, readForm } from "../form.ts";
import { html, raw, when, type Html } from "../html.ts";
import { flashOrJson, flashTo } from "../layout.ts";
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
    origin_refused: "The origin refused that. Nothing was changed here either.",
    origin_unreachable: "The origin could not be reached. Nothing was changed.",
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

/** One thing that happened, and when — the unit the timeline sorts. */
export interface Entry {
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
  const events = listEvents(ctx.app.db, { repoId: repo.id, limit: 200 }).filter(
    (event) =>
      EVENT_LOOK[event.kind] !== undefined &&
      Number(event.payload.number) === issue.number &&
      // A `pull.reviewed` carrying a `state` is a *verdict*, and the pull
      // page renders those off the `review` table with their badge and
      // their words. Rendering the event too would say it twice.
      !(event.kind === "pull.reviewed" && event.payload.state !== undefined),
  );
  // One read for every actor the timeline names, rather than one per entry.
  const actors = getUsersByIds(
    ctx.app.db,
    events.map((event) => event.actorId ?? "").filter(Boolean),
  );
  const entries: Entry[] = [];
  for (const event of events) {
    const look = EVENT_LOOK[event.kind]!;
    const actor =
      event.actorId !== null ? actors.get(event.actorId) : undefined;
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
  /**
   * Entries only one kind of thread has — review verdicts on a pull. They
   * are merged into the same sort as comments and state changes, because a
   * verdict is a thing that happened at a time like any other, and a
   * timeline that files it separately reads as two conversations.
   */
  extra?: readonly Entry[];
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
  entries.push(...(options.extra ?? []));
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

// ---- assignee ----

/**
 * Who could be put on this thread: nobody, then the people on this forge
 * who can see the repository, then the crew — which is exactly the set of
 * agents `assignIssue` will accept. People are read bounded and by name;
 * the author and whoever is on it now are offered whatever the bound, so
 * the select can never fail to show the current answer. Each candidate is
 * checked with `canRead`, the same rule the action applies.
 */
function assigneeCandidates(ctx: Ctx, repo: Repo, issue: Issue): User[] {
  const db = ctx.app.db;
  const seen = new Map<string, User>();
  const offer = (user: User | undefined): void => {
    if (
      user !== undefined &&
      user.kind !== "org" &&
      !seen.has(user.id) &&
      canRead(db, repo, user)
    )
      seen.set(user.id, user);
  };
  for (const person of listPeople(db, { limit: 200 })) offer(person);
  offer(getUserById(db, issue.authorId));
  if (issue.assigneeId !== null) offer(getUserById(db, issue.assigneeId));
  const crew = listCrew(ctx.app, ctx.auth.user, repo);
  if (crew.ok) for (const agent of crew.value) offer(agent.user);
  return [...seen.values()].sort((a, b) =>
    a.kind === b.kind
      ? a.username.localeCompare(b.username)
      : a.kind === "agent"
        ? 1
        : -1,
  );
}

/**
 * The assignee rail: who is on it, and — for a writer — the select that
 * changes that. Assigning an agent is what starts it working
 * (docs/APPS.md), so the agents are listed last and marked, never mixed in
 * with people as though the choice were the same kind of choice.
 */
export function assigneeCard(
  ctx: Ctx,
  repo: Repo,
  issue: Issue,
  action: string,
): Html {
  const mayEdit = canWrite(ctx.app.db, repo, ctx.auth.user);
  const current =
    issue.assigneeName === null
      ? html`<p class="muted small">Nobody yet.</p>`
      : html`<p class="bar">
          ${when(issue.assigneeIsAgent, () => icon("bot"))}
          ${userLink(issue.assigneeName)}
        </p>`;
  if (!mayEdit)
    return card(current, {
      head: html`${icon("user")}
        <h2>Assignee</h2>`,
    });
  const candidates = assigneeCandidates(ctx, repo, issue);
  return card(
    html`${current}
      <form method="post" action="${action}" class="edit-row mt">
        <label class="sr-only" for="f-assignee">Assign to</label>
        <select class="input" id="f-assignee" name="assignee">
          <option
            value=""
            ${issue.assigneeId === null ? raw("selected") : null}
          >
            Nobody
          </option>
          ${candidates.map(
            (user) =>
              html`<option
                value="${user.username}"
                ${user.id === issue.assigneeId ? raw("selected") : null}
              >
                ${user.username}${user.kind === "agent" ? " (agent)" : ""}
              </option>`,
          )}
        </select>
        ${btn("Assign", { size: "sm" })}
      </form>`,
    {
      head: html`${icon("user")}
        <h2>Assignee</h2>`,
    },
  );
}

/** POST …/:number/assignee — put someone on it, or take them off. */
export async function assigneeSubmit(
  ctx: Ctx,
  kind: "issue" | "pull",
): Promise<Response> {
  const found = threadContext(ctx, kind);
  if (found instanceof Response) return found;
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;

  const dest = `${repoBase(found.repo)}/${kind === "pull" ? "pulls" : "issues"}/${found.issue.number}`;
  const name = field(form, "assignee").trim();
  const assignee = name === "" ? null : getUserByName(ctx.app.db, name);
  if (assignee === undefined)
    return flashTo(ctx, dest, {
      tone: "danger",
      message: `There is no account named ${name}.`,
    });
  const assigned = assignIssue(
    ctx.app,
    ctx.auth.user,
    found.repo,
    found.issue,
    assignee,
  );
  if (!assigned.ok) {
    const words: Record<string, string> = {
      assignee_cannot_read: `${name} cannot see this repository, so cannot be assigned to it.`,
      agent_not_on_crew: `${name} is not on this repository's crew. Add it under Settings → Crew first.`,
      forbidden: "You need write access to assign.",
    };
    return flashTo(ctx, dest, {
      tone: "danger",
      message: words[assigned.error] ?? "That could not be assigned.",
    });
  }
  return flashTo(ctx, dest, {
    message:
      assignee === null
        ? "Unassigned."
        : assignee.kind === "agent"
          ? `Assigned to ${assignee.username}. It starts working on it now.`
          : `Assigned to ${assignee.username}.`,
  });
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
    return flashOrJson(ctx, dest, { tone: "danger", message });
  }
  return flashOrJson(ctx, dest, {
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

// ---- dependencies ----

/**
 * What this issue waits for, and what waits for it, with the form to change
 * it. Anyone who can write the repository or is on its crew may link: a plan
 * is the crew's to write as much as a person's.
 */
export function dependenciesCard(
  ctx: Ctx,
  repo: Repo,
  issue: Issue,
  action: string,
): Html {
  const { blockedBy, blocks } = dependenciesOf(ctx.app.db, issue.id);
  const base = repoBase(repo);
  const user = ctx.auth.user;
  const mayEdit =
    user !== undefined &&
    (canWrite(ctx.app.db, repo, user) || isCrew(ctx.app.db, repo.id, user.id));
  const list = (items: Issue[], removable: boolean) =>
    html`<ul class="dep-list">
      ${items.map(
        (i) =>
          html`<li data-state="${i.state}">
            ${icon(i.state === "closed" ? "issueClosed" : "issue")}
            <a href="${base}/issues/${i.number}">${i.title}</a>
            <span class="muted small">#${i.number}</span>
            ${removable && mayEdit
              ? html`<form method="post" action="${action}" class="inline">
                  <input type="hidden" name="unlink" value="${i.number}" />
                  <button
                    class="btn btn-ghost btn-xs"
                    type="submit"
                    aria-label="No longer waits for #${i.number}"
                  >
                    ${icon("x")}
                  </button>
                </form>`
              : null}
          </li>`,
      )}
    </ul>`;
  const openBlockers = blockedBy.filter((i) => i.state === "open").length;
  const waits =
    openBlockers === 0
      ? `Waits for ${blockedBy.length}, all done`
      : openBlockers === blockedBy.length
        ? `Waits for ${blockedBy.length}`
        : `Waits for ${blockedBy.length}, ${openBlockers} still open`;
  const holds = `Holds up ${blocks.length}`;
  const body = html`${blockedBy.length === 0
      ? html`<p class="muted small">Waits for nothing.</p>`
      : html`<p class="small">${waits}</p>
          ${list(blockedBy, true)}`}
    ${blocks.length === 0
      ? null
      : html`<p class="small mt">${holds}</p>
          ${list(blocks, false)}`}
    ${mayEdit
      ? html`<form method="post" action="${action}" class="edit-row mt">
          <label class="sr-only" for="f-blocked-by"
            >Waits for issue number</label
          >
          <input
            class="input"
            id="f-blocked-by"
            name="blockedBy"
            inputmode="numeric"
            placeholder="#"
            aria-label="Issue number this one waits for"
          />
          ${btn("Waits for", { type: "submit", size: "sm" })}
        </form>`
      : null}
    <p class="muted small mt"><a href="${base}/map">See the map</a></p>`;
  return card(body, {
    head: html`${icon("map")}
      <h2>Depends on</h2>`,
  });
}

// POST /:owner/:name/issues/:number/dependencies  { blockedBy } | { unlink }
export async function dependencySubmit(ctx: Ctx): Promise<Response> {
  const found = threadContext(ctx, "issue");
  if (found instanceof Response) return found;
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const dest = `${repoBase(found.repo)}/issues/${found.issue.number}`;
  const unlink = field(form, "unlink").trim();
  const raw = unlink !== "" ? unlink : field(form, "blockedBy").trim();
  const number = Number(raw.replace(/^#/, ""));
  const other =
    Number.isInteger(number) && number > 0
      ? getIssue(ctx.app.db, found.repo.id, number)
      : undefined;
  if (!other || other.kind !== "issue")
    return flashTo(ctx, dest, {
      tone: "danger",
      message: `There is no issue #${raw.replace(/^#/, "")} here.`,
    });
  const result =
    unlink !== ""
      ? unlinkIssue(ctx.app, ctx.auth.user, found.repo, found.issue, other)
      : linkIssue(ctx.app, ctx.auth.user, found.repo, found.issue, other);
  if (!result.ok) {
    const words: Record<string, string> = {
      self: "An issue cannot wait for itself.",
      cycle: `#${other.number} already waits for this one, directly or through others; linking would make a loop.`,
      cross_repo: "Dependencies stay inside one repository.",
      not_an_issue: "Only issues can depend on issues.",
      forbidden: "You need write access, or a place on the crew, to plan here.",
    };
    return flashTo(ctx, dest, {
      tone: "danger",
      message: words[result.error] ?? "That could not be linked.",
    });
  }
  return flashTo(ctx, dest, {
    message:
      unlink !== ""
        ? `#${found.issue.number} no longer waits for #${other.number}.`
        : `#${found.issue.number} waits for #${other.number}.`,
  });
}
