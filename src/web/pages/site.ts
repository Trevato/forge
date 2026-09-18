/**
 * The site pages: the landing page and the signed-in dashboard, sign in and
 * sign up, creating a repository, search, and the confirmation step every
 * destructive action passes through. Plain forms, zero JavaScript required,
 * fast everywhere — a phone in the redwoods is the reference device.
 *
 * Every failure re-renders the form the person was filling in, with what they
 * typed still in it. A dead end that loses input is a bug, not a message.
 */

import { createRepo } from "../../actions/repos.ts";
import { signUp } from "../../actions/users.ts";
import { appsRuntime } from "../../apps/runtime.ts";
import { appsForRepos } from "../../core/apps.ts";
import { listEventsVisibleTo, type ForgeEvent } from "../../core/events.ts";
import {
  getIssuesByRef,
  listAssignedTo,
  listOpenAgentPullsVisibleTo,
  type Issue,
} from "../../core/issues.ts";
import { LOOK_SIZES, looksForApps } from "../../core/looks.ts";
import { accessAllows, listOrgsForUser, orgAccess } from "../../core/orgs.ts";
import { listPins, pinnedRepoIds } from "../../core/pins.ts";
import {
  canRead,
  getReposByIds,
  listReposVisibleTo,
  writableRepoIds,
  type Repo,
} from "../../core/repos.ts";
import { latestRunsForIssues } from "../../core/runs.ts";
import { createSession, destroySession } from "../../core/sessions.ts";
import {
  getUsersByIds,
  hasAnyUser,
  verifyPassword,
  type User,
} from "../../core/users.ts";
import { isThemeName } from "../../design/themes.ts";
import { crossOrigin, type Ctx } from "../../http/context.ts";
import { studioHome } from "./studio.ts";
import { edgeLoginUrl } from "../../http/edge.ts";
import { sshCommand } from "../../ssh/command.ts";
import {
  hostOf,
  notFoundPage,
  pageHead,
  repoBase,
  signInFirst,
} from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { icon, type IconName } from "../icons.ts";
import { lookUrl } from "./looks.ts";
import {
  eventActor,
  eventVerb,
  isTransientEvent,
} from "../../design/activity.ts";
import { flashTo, page, redirect } from "../layout.ts";
import { liveClientJs, liveMount } from "../live.ts";
import {
  btn,
  card,
  empty,
  envStateBadge,
  field as formField,
  iconBtn,
  listCard,
  pager,
  repoCounts,
  row,
  runStateBadge,
  selectField,
  time,
  userTag,
} from "../ui.ts";
import { appsCard } from "./apps.ts";

export function sessionCookie(value: string, expires: Date, url: URL): string {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `forge_session=${value}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}${secure}`;
}

/**
 * A `?next=` destination is a path on this forge or nothing at all. A
 * protocol-relative `//evil.example` is a redirect off-site wearing a path's
 * clothes, so it is refused with everything else that isn't a plain path.
 */
function safeNext(raw: string | null): string | undefined {
  if (raw === null || raw === "") return undefined;
  if (!raw.startsWith("/") || raw.startsWith("//")) return undefined;
  if (raw.includes("\\") || /[\n\r]/.test(raw)) return undefined;
  return raw;
}

/**
 * One repository row. The lead glyph carries provenance — a mirror wears its
 * origin's mark rather than the generic repo book — and a pin shows in the
 * trail, because "is this on my machine" is a property of the row, not a
 * separate list to cross-reference.
 */
const repoRow = (repo: Repo, pinned?: ReadonlySet<string>): Html =>
  row({
    href: `/${repo.ownerName}/${repo.name}`,
    nav: true,
    lead: icon(
      repo.origin !== null
        ? repo.origin.kind
        : repo.forkParentId !== null
          ? "fork"
          : "repo",
    ),
    title: `${repo.ownerName}/${repo.name}`,
    titleAttr: `${repo.ownerName}/${repo.name}`,
    ...(repo.description !== "" ? { meta: html`${repo.description}` } : {}),
    trail: html`${repoCounts({
      openIssues: repo.counts?.openIssues,
      openPulls: repo.counts?.openPulls,
    })}${when(
      pinned?.has(repo.id) === true,
      () =>
        html`<span class="badge" data-variant="outline" title="On your machine"
          >${icon("pin")}Pinned</span
        >`,
    )}${when(
      repo.visibility === "private",
      () =>
        html`<span class="badge" data-variant="secondary"
          >${icon("lock")}Private</span
        >`,
    )}`,
  });

// ---- home ----

/** Which glyph an event wears in the activity rail. */
function eventIcon(kind: string): IconName {
  if (kind === "push") return "commit";
  if (kind === "issue.closed") return "issueClosed";
  if (kind.startsWith("issue.")) return "issue";
  if (kind === "pull.merged") return "merge";
  if (kind.startsWith("pull.")) return "pull";
  if (kind === "repo.forked") return "fork";
  if (kind.startsWith("repo.")) return "repo";
  if (kind.startsWith("label.")) return "tag";
  if (kind.startsWith("webhook.")) return "webhook";
  if (kind.startsWith("team.") || kind.startsWith("org.")) return "users";
  if (kind.startsWith("token.") || kind.startsWith("key.")) return "key";
  if (kind.startsWith("settings.")) return "settings";
  if (kind.startsWith("app.") || kind === "run.finished") return "rocket";
  if (kind.startsWith("crew.")) return "bot";
  return "activity";
}

/** Which conversation, if any, an event is about — for one grouped read. */
function eventIssueRef(
  event: ForgeEvent,
): { repoId: string; number: number } | undefined {
  const number = event.payload["number"];
  return typeof number === "number" && event.repoId !== null
    ? { repoId: event.repoId, number }
    : undefined;
}

const issueKey = (repoId: string, number: number): string =>
  `${repoId}#${number}`;

/**
 * The thing an event happened to, as `#3 Title` or a label/hook name. The
 * issues arrive as a map the caller filled in one grouped read — a feed of
 * forty rows must not be forty `getIssue` calls.
 */
function eventSubject(
  issues: Map<string, { title: string }>,
  event: ForgeEvent,
): string {
  const ref = eventIssueRef(event);
  if (ref !== undefined) {
    const issue = issues.get(issueKey(ref.repoId, ref.number));
    return issue ? `#${ref.number} ${issue.title}` : `#${ref.number}`;
  }
  for (const key of ["name", "url", "parent", "summary"] as const) {
    const value = event.payload[key];
    if (typeof value === "string" && value !== "") return value;
  }
  const updates = event.payload["updates"];
  if (Array.isArray(updates)) {
    const ref = (updates[0] as { ref?: string } | undefined)?.ref;
    if (typeof ref === "string") return ref.replace(/^refs\/heads\//, "");
  }
  return "";
}

/**
 * Recent activity, plus the repositories worth watching for more of it.
 *
 * There is no user-level event stream — the outbox fans out per repository —
 * so the rail names the few repositories its own rows came from and the live
 * client subscribes to those. That is the honest bound: the pill says "3 new"
 * for the repositories you were just looking at, and never pretends to cover
 * a forge-wide feed it is not connected to.
 */
function activityRail(
  ctx: Ctx,
  user: User | undefined,
): { body: Html; watch: string[] } {
  const db = ctx.app.db;
  // The visibility rule lives in the query, so this is the twelve most recent
  // things *this viewer* can see — not the twelve newest events in the forge
  // filtered down to however few of them happened to be visible.
  // A run being queued or started is a moment, not a fact; the rail shows
  // what came of it. Read a little past twelve so the cut keeps its size.
  const events = listEventsVisibleTo(db, user, { limit: 24 })
    .filter((e: ForgeEvent) => !isTransientEvent(e.kind))
    .slice(0, 12);
  const byId = getReposByIds(
    db,
    events.map((e: ForgeEvent) => e.repoId ?? "").filter(Boolean),
  );
  const watch: string[] = [];
  for (const event of events) {
    const repo = byId.get(event.repoId ?? "");
    if (repo === undefined) continue;
    const at = `/${repo.ownerName}/${repo.name}`;
    if (!watch.includes(at)) watch.push(at);
  }
  if (events.length === 0) {
    return {
      watch,
      body: card(
        html`<p class="muted small">
          Nothing has happened yet. Push a commit or open an issue and it shows
          up here.
        </p>`,
        { head: html`<h2>Recent activity</h2>` },
      ),
    };
  }
  // Three grouped reads for the whole rail: the actors, and the conversations
  // the rows name. Asked per row this was two queries a row.
  const actors = getUsersByIds(
    db,
    events.map((e: ForgeEvent) => e.actorId ?? "").filter(Boolean),
  );
  const issues = getIssuesByRef(
    db,
    events
      .map(eventIssueRef)
      .filter((r): r is { repoId: string; number: number } => r !== undefined),
  );
  const body = card(
    html`<ul class="list act">
      ${events.map((event: ForgeEvent) => {
        const repo = byId.get(event.repoId ?? "")!;
        const actor =
          event.actorId === null ? undefined : actors.get(event.actorId);
        const subject = eventSubject(issues, event);
        const where = `${repo.ownerName}/${repo.name}`;
        // `via: "origin"` means the sync worker saw this upstream rather than
        // someone doing it here. The glyph is the only honest way to say so
        // without a second line of prose on every row.
        const viaOrigin = event.payload["via"] === "origin";
        // A deploy with no actor is the forge's own doing, and says so.
        const who = eventActor(event, actor?.username);
        return row({
          href: `/${where}`,
          lead: icon(
            viaOrigin && repo.origin !== null
              ? repo.origin.kind
              : eventIcon(event.kind),
          ),
          title: html`<strong>${who}</strong> ${eventVerb(event)}`,
          meta: html`${where}${subject !== "" ? html` · ${subject}` : null}`,
          titleAttr: `${who} ${eventVerb(event)}`,
          trail: time(event.createdAt),
        });
      })}
    </ul>`,
    { head: html`<h2>Recent activity</h2>`, pad: false },
  );
  return { body, watch };
}

/**
 * What you keep on your machine. The server stores the *choice* and nothing
 * about the laptop, so this card is a list of decisions plus the one command
 * that acts on them — never a status the server would only ever hold a stale
 * copy of.
 */
function downloadsCard(ctx: Ctx, user: User): Html {
  const pins = listPins(ctx.app.db, user.id);
  const head = html`${icon("download")}
    <h2>On your machine</h2>`;
  if (pins.length === 0) {
    return card(
      html`<p class="muted small">
        Pin a repository (the ${icon("pin")} on its header) and the local client
        keeps it cloned under
        <span class="mono">~/src/&lt;host&gt;/&lt;owner&gt;/&lt;repo&gt;</span>.
      </p>`,
      { head },
    );
  }
  const repos = getReposByIds(
    ctx.app.db,
    pins.map((pin) => pin.repoId),
  );
  return listCard(
    [
      ...pins.map((pin) => {
        const repo = repos.get(pin.repoId);
        const at = repo?.origin ?? null;
        return row({
          nav: true,
          lead: icon("pin"),
          // The row carries an unpin form, and a form inside an <a> is markup
          // the parser pulls apart — so the title is the link.
          title: html`<a href="/${pin.ownerName}/${pin.name}"
            >${pin.ownerName}/${pin.name}</a
          >`,
          titleAttr: `${pin.ownerName}/${pin.name}`,
          // The same three places the repo header states, in the same words.
          meta: html`<span class="where">
            ${when(
              at,
              (o) =>
                html`<span class="where-place" data-state="present"
                    ><span class="where-dot" aria-hidden="true">●</span
                    >${hostOf(o.htmlUrl) || o.fullName}</span
                  ><span class="where-sep" aria-hidden="true">·</span>`,
            )}
            <span class="where-place" data-state="present"
              ><span class="where-dot" aria-hidden="true">●</span
              >workbench</span
            ><span class="where-sep" aria-hidden="true">·</span
            ><span class="where-place" data-state="present"
              ><span class="where-dot" aria-hidden="true">◆</span>this
              machine</span
            >
          </span>`,
          // No timestamp: when you pinned something is the least useful fact
          // about it, and this rail is narrow enough that the strip needs the
          // room more than the clock does.
          trail: html`<form
            class="row-actions"
            method="post"
            action="/${pin.ownerName}/${pin.name}/pin"
          >
            <input type="hidden" name="pinned" value="0" />
            ${iconBtn("pinOff", "Unpin", {
              size: "sm",
              title: `Unpin — stop keeping ${pin.ownerName}/${pin.name} on my machine`,
            })}
          </form>`,
        });
      }),
      html`<li>
        <div class="row">
          <span class="row-main">
            <span class="clone"
              ><span class="clone-text" id="forge-sync">forge sync</span>
              ${iconBtn("copy", "Copy the sync command", {
                size: "sm",
                type: "button",
                copy: "forge-sync",
              })}</span
            >
            <span class="row-meta"
              >Clones what is missing, fetches the rest, and reports
              ahead/behind/dirty. See "Origins" in the README.</span
            >
          </span>
        </div>
      </li>`,
    ],
    { head },
  );
}

/**
 * The inbox (docs/APPS.md): pulls the crew opened that are waiting on a
 * person, and whatever is assigned to the viewer. Both are absent when
 * empty — a card saying "nothing" is a zero drawn, and the absence carries
 * the same information — so a quiet forge opens on its repositories.
 */
function inbox(ctx: Ctx, user: User): Html {
  const needs = needsYouCard(ctx, user);
  const mine = onYouCard(ctx, user);
  if (needs === undefined && mine === undefined) return html``;
  return html`<div class="stack mb">${needs ?? null} ${mine ?? null}</div>`;
}

const threadPath = (repo: Repo, issue: Issue): string =>
  `/${repo.ownerName}/${repo.name}/${issue.kind === "pull" ? "pulls" : "issues"}/${issue.number}`;

/**
 * Open pulls the crew opened, in repositories the viewer can write — the
 * ones waiting on a review only a person can give. Visibility is in the
 * query; write access is checked once per distinct repository here. The
 * check beside each is the latest deploy of that pull, one grouped read.
 */
function needsYouCard(ctx: Ctx, user: User): Html | undefined {
  const db = ctx.app.db;
  const pulls = listOpenAgentPullsVisibleTo(db, user, 25);
  if (pulls.length === 0) return undefined;
  const repos = getReposByIds(
    db,
    pulls.map((pull) => pull.repoId),
  );
  // Write access for every repository at once — one query, like visibility.
  const mayWrite = writableRepoIds(db, user, [...repos.keys()]);
  const writable = new Map<string, Repo>();
  for (const repo of repos.values())
    if (mayWrite.has(repo.id)) writable.set(repo.id, repo);
  const mine = pulls.filter((pull) => writable.has(pull.repoId)).slice(0, 10);
  if (mine.length === 0) return undefined;
  const checks = latestRunsForIssues(
    db,
    mine.map((pull) => pull.id),
  );
  return listCard(
    mine.map((pull) => {
      const repo = writable.get(pull.repoId)!;
      const check = checks.get(pull.id);
      return row({
        href: threadPath(repo, pull),
        nav: true,
        state: "open",
        lead: icon("pull"),
        title: pull.title,
        titleAttr: pull.title,
        meta: html`${repo.ownerName}/${repo.name} #${pull.number} ·
        ${userTag(pull.authorName)} opened ${time(pull.createdAt)}`,
        trail: html`${check === undefined
          ? html`<span class="badge verdict-stale"
              >${icon("clock")}No checks</span
            >`
          : runStateBadge(check.state, check.kind)}`,
      });
    }),
    {
      head: html`${icon("eye")}
        <h2>Needs you</h2>
        <span class="muted small"
          >pull requests from the crew, waiting on a review</span
        >`,
    },
  );
}

/** Open issues and pulls assigned to the viewer, anywhere they can see. */
export function onYouCard(ctx: Ctx, user: User): Html | undefined {
  const db = ctx.app.db;
  const assigned = listAssignedTo(db, user.id, 20);
  if (assigned.length === 0) return undefined;
  const repos = getReposByIds(
    db,
    assigned.map((issue) => issue.repoId),
  );
  // `listAssignedTo` has no visibility filter of its own (an assignment can
  // outlive the access that made it), so each repo needs a real `canRead`.
  // Checking it straight would cost one query per row for any repo the
  // viewer does not own outright — `canRead` resolves org ownership from
  // the database. `listReposVisibleTo` answers the common case with one
  // query for the whole page; `canRead` only runs for the rare repo it
  // did not reach (its own cap), so the cost stays flat as rows grow.
  const visible = new Set(
    listReposVisibleTo(db, user, { limit: 200 }).map((repo) => repo.id),
  );
  const rows: Html[] = [];
  for (const issue of assigned) {
    const repo = repos.get(issue.repoId);
    if (!repo) continue;
    if (!visible.has(repo.id) && !canRead(db, repo, user)) continue;
    rows.push(
      row({
        href: threadPath(repo, issue),
        nav: true,
        state: "open",
        lead: icon(issue.kind === "pull" ? "pull" : "issue"),
        title: issue.title,
        titleAttr: issue.title,
        meta: html`${repo.ownerName}/${repo.name} #${issue.number} · updated
        ${time(issue.updatedAt)}`,
      }),
    );
  }
  if (rows.length === 0) return undefined;
  return listCard(rows, {
    head: html`${icon("user")}
      <h2>On you</h2>`,
  });
}

function orgsCard(ctx: Ctx, user: User): Html {
  const orgs = listOrgsForUser(ctx.app.db, user.id);
  const head = html`<h2>Your organizations</h2>
    <span class="spacer"></span>
    ${btn("New", { href: "/organizations/new", size: "sm", icon: "plus" })}`;
  if (orgs.length === 0) {
    return card(
      html`<p class="muted small">
        Organizations own repositories as a group, with teams for access.
      </p>`,
      { head },
    );
  }
  return listCard(
    orgs.map((org) =>
      row({
        href: `/${org.username}`,
        nav: true,
        lead: icon("users"),
        title: org.username,
      }),
    ),
    { head },
  );
}

/**
 * The studio's front door for a stranger: the public apps actually
 * serving, as a shelf of pictures, name and one clamped line — not the dev
 * pitch, which a signed-out reader reaches through `?mode=dev` (unchanged,
 * `landing` below) exactly as a signed-in one reaches it through the mode
 * switch. A forge with nothing public up yet — most people's first visit —
 * falls back to that same dev landing rather than showing an empty shelf.
 *
 * Two grouped reads carry the whole shelf (the apps, then their looks), and
 * a repository's runtime state is a map lookup (`AppsRuntime.status`), not
 * a process call — so this never gets slower as the forge grows apps, the
 * one page anonymous traffic actually hits.
 */
function studioLanding(ctx: Ctx): Html {
  const db = ctx.app.db;
  const publicRepos = listReposVisibleTo(db, undefined, { limit: 24 });
  const records = appsForRepos(
    db,
    publicRepos.map((repo) => repo.id),
  );
  const appRepos = publicRepos.filter((repo) => records.has(repo.id));
  if (appRepos.length === 0) return landing(ctx);

  const runtime = appsRuntime(ctx.app);
  const looks = looksForApps(
    db,
    appRepos.map((repo) => records.get(repo.id)!.id),
  );
  const tiles = appRepos.map((repo) => {
    const record = records.get(repo.id)!;
    const production = (
      runtime === undefined ? [] : runtime.status(record)
    ).find((env) => env.env === "production");
    const look = looks.find(
      (l) =>
        l.appId === record.id &&
        l.env === "production" &&
        l.kind === "desktop" &&
        l.error === null,
    );
    const base = repoBase(repo);
    return html`<a class="app-tile" href="${base}">
      ${look
        ? html`<img
            class="app-tile-look"
            src="${lookUrl(base, "production", look.commitOid, "desktop")}"
            width="${LOOK_SIZES.desktop.width}"
            height="${LOOK_SIZES.desktop.height}"
            alt=""
            loading="lazy"
          />`
        : html`<span class="app-tile-blank" aria-hidden="true"
            >${icon("rocket")}</span
          >`}
      <span class="app-tile-body">
        <span class="app-tile-name">${repo.name}</span>
        ${repo.description !== ""
          ? html`<span class="app-tile-desc truncate"
              >${repo.description}</span
            >`
          : null}
        ${envStateBadge(production?.state ?? "stopped")}
      </span>
    </a>`;
  });

  return html`<section class="hero">
      <h1>Apps, live.</h1>
      <p>
        A software forge that builds and serves its own apps — these are
        running here right now.
      </p>
      <div class="bar">
        ${ctx.app.config.edgeToken === undefined
          ? html`${btn("Create an account", {
              href: "/signup",
              variant: "primary",
              size: "lg",
            })}
            ${btn("Sign in", { href: "/signin", size: "lg" })}`
          : btn("Sign in", {
              href: edgeLoginUrl("/"),
              variant: "primary",
              size: "lg",
            })}
      </div>
    </section>
    <div class="mt app-shelf">${tiles}</div>`;
}

function landing(ctx: Ctx): Html {
  const publicRepos = listReposVisibleTo(ctx.app.db, undefined, { limit: 8 });
  return html`<section class="hero">
      <h1>Your code, your machine.</h1>
      <p>
        A software forge you run yourself: real git over HTTPS, issues, pull
        requests with review, webhooks and a JSON API — in one process, with
        zero runtime dependencies.
      </p>
      <div class="bar">
        ${ctx.app.config.edgeToken === undefined
          ? html`${btn("Create an account", {
              href: "/signup",
              variant: "primary",
              size: "lg",
            })}
            ${btn("Sign in", { href: "/signin", size: "lg" })}`
          : btn("Sign in", {
              href: edgeLoginUrl("/"),
              variant: "primary",
              size: "lg",
            })}
      </div>
      ${when(
        sshCommand(ctx.app),
        (ssh) =>
          html`<p class="hero-terminal">
            <code class="mono">${ssh}</code>
            <span class="muted"
              >the whole forge in your terminal — your key is your
              identity</span
            >
          </p>`,
      )}
      <div class="hero-points">
        ${card(
          html`<strong>Real git, and a real terminal</strong>Clone, fetch and
            push over HTTPS or SSH; the same port opens the forge as a
            keyboard-driven app. Branch protection is enforced by the
            pre-receive hook, not by convention.`,
        )}
        ${card(
          html`<strong>Issues and review</strong>Threads, labels, and pull
            requests with word-level diffs and comments anchored to a line.`,
        )}
        ${card(
          html`<strong>Built for automation</strong>Every mutation emits a
            durable event. Webhooks are signed and retried; the API mirrors the
            web.`,
        )}
      </div>
    </section>
    ${when(
      publicRepos.length > 0,
      () =>
        html`<div class="mt">
          <h2 class="mb">Public repositories</h2>
          ${listCard(publicRepos.map((repo) => repoRow(repo)))}
        </div>`,
    )}`;
}

/** The terminal is a front door, not a footnote: the command, on the dashboard. */
function terminalCard(ctx: Ctx): Html {
  const ssh = sshCommand(ctx.app);
  if (ssh === undefined) return html``;
  return card(
    html`<div class="terminal-line">
        <code class="mono">${ssh}</code>
        <a class="small" href="/settings/keys">SSH keys</a>
      </div>
      ${when(
        ctx.app.config.sshHostKey,
        (fp) => html`<p class="muted small mt">host key ${fp}</p>`,
      )}`,
    { head: html`<h2>Terminal</h2>` },
  );
}

function dashboard(ctx: Ctx, user: User): Html {
  const query = (ctx.url.searchParams.get("q") ?? "").trim();
  const cursor = ctx.url.searchParams.get("cursor") ?? "";
  const perPage = 20;
  const repos = listReposVisibleTo(ctx.app.db, user, {
    limit: perPage + 1,
    ...(query !== "" ? { query } : {}),
    ...(cursor !== "" ? { cursor } : {}),
  });
  const shown = repos.slice(0, perPage);
  const last = shown[shown.length - 1];
  const more = repos.length > perPage && last !== undefined;
  const carry = query !== "" ? `q=${encodeURIComponent(query)}&` : "";
  // Cursor lists only move forward; "Newer" is the way back to the top.
  const pinned = pinnedRepoIds(ctx.app.db, user.id);
  const rail = activityRail(ctx, user);

  const filter = html`<form class="filters" method="get" action="/">
    <input
      class="input search"
      type="search"
      name="q"
      value="${query}"
      placeholder="Filter repositories"
      aria-label="Filter repositories"
      data-search-input
    />
    <button class="btn" data-size="sm" type="submit">Filter</button>
    ${when(query !== "", () =>
      btn("Clear", { href: "/", size: "sm", variant: "ghost" }),
    )}
  </form>`;

  const list =
    shown.length === 0
      ? empty({
          icon: "repo",
          title: query === "" ? "No repositories yet" : "No matches",
          note:
            query === ""
              ? "Create one here, or just push to a remote that does not exist yet."
              : "Nothing you can see matches that filter.",
          action:
            query === ""
              ? btn("New repository", { href: "/new", variant: "primary" })
              : btn("Clear filter", { href: "/" }),
        })
      : listCard(shown.map((repo) => repoRow(repo, pinned)));

  return html`<div class="dash">
    <div>
      ${inbox(ctx, user)}
      ${pageHead("Your repositories", {
        actions: btn("New repository", {
          href: "/new",
          variant: "primary",
          size: "sm",
          icon: "plus",
          shortcut: "c",
        }),
      })}
      ${filter} ${list}
      ${pager({
        ...(cursor !== ""
          ? { prev: carry === "" ? "/" : `/?${carry.slice(0, -1)}` }
          : {}),
        ...(more && last ? { next: `/?${carry}cursor=${last.id}` } : {}),
      })}
    </div>
    <aside class="stack">
      ${terminalCard(ctx)} ${appsCard(ctx)} ${rail.body}
      ${downloadsCard(ctx, user)} ${orgsCard(ctx, user)}
    </aside>
    ${liveMount({
      repo: rail.watch[0] ?? "",
      repos: rail.watch.slice(1),
    })}
  </div>`;
}

export async function home(ctx: Ctx): Promise<Response> {
  const user = ctx.auth.user;
  // Studio by default: apps, the crew, what asks you. `?mode=dev` on the
  // home is the escape hatch — for a stranger as much as for someone
  // signed in — resolved once for `ctx.mode`.
  const studio = ctx.mode === "studio";
  if (user !== undefined && studio) return await studioHome(ctx, user);
  return page({
    ctx,
    title: "forge",
    body: user
      ? dashboard(ctx, user)
      : studio
        ? studioLanding(ctx)
        : landing(ctx),
    ...(user === undefined ? {} : { scriptJs: liveClientJs }),
  });
}

// ---- authentication ----

interface AuthValues {
  username?: string;
  email?: string;
}

interface AuthErrors {
  username?: string;
  email?: string;
  password?: string;
}

function authForm(
  ctx: Ctx,
  kind: "signin" | "signup",
  o: { values?: AuthValues; errors?: AuthErrors } = {},
): Html {
  const values = o.values ?? {};
  const errors = o.errors ?? {};
  const next = safeNext(ctx.url.searchParams.get("next"));
  const action = next
    ? `/${kind}?next=${encodeURIComponent(next)}`
    : `/${kind}`;
  // "Is this the first account?" is a `LIMIT 1` existence check, not a count
  // of the whole user table — and the sign-in screen paints on every session.
  const firstAccount = kind === "signup" && !hasAnyUser(ctx.app.db);

  // Behind a platform edge, that is the door: the button first, and the
  // password form kept for the accounts that have one — an account the edge
  // made has none, and the note says so before anyone types.
  const edge =
    ctx.app.config.edgeToken === undefined
      ? undefined
      : (ctx.app.config.edgeName ?? "the platform");
  const throughEdge = when(
    edge,
    (name) =>
      html`<div class="stack mb">
        ${btn(`Continue with ${name}`, {
          href: edgeLoginUrl(next ?? "/"),
          variant: "primary",
          size: "lg",
        })}
        <p class="muted small">
          ${kind === "signin"
            ? `Accounts made through ${name} sign in there and have no password here. The form below is for an account that was given one.`
            : `Signing in through ${name} makes your account on first sight; the form below makes one with a password instead.`}
        </p>
      </div>`,
  );

  const body = html`${throughEdge}
    <form method="post" action="${action}">
      ${formField({
        label: "Username",
        name: "username",
        value: values.username ?? "",
        autocomplete: "username",
        required: true,
        autofocus: true,
        ...(kind === "signup"
          ? {
              hint: "Letters, digits, dots and dashes.",
              pattern: "[A-Za-z0-9][A-Za-z0-9._-]*",
            }
          : {}),
        ...(errors.username ? { error: errors.username } : {}),
      })}
      ${when(kind === "signup", () =>
        formField({
          label: "Email",
          name: "email",
          type: "email",
          value: values.email ?? "",
          autocomplete: "email",
          required: true,
          ...(errors.email ? { error: errors.email } : {}),
        }),
      )}
      ${formField({
        label: "Password",
        name: "password",
        type: "password",
        autocomplete: kind === "signin" ? "current-password" : "new-password",
        required: true,
        ...(kind === "signup"
          ? { minlength: 10, hint: "At least 10 characters." }
          : {}),
        ...(errors.password ? { error: errors.password } : {}),
      })}
      ${when(
        firstAccount,
        () =>
          html`<p class="muted small mb">
            This forge has no accounts yet — the first account becomes the site
            admin.
          </p>`,
      )}
      <div class="form-actions">
        ${btn(kind === "signin" ? "Sign in" : "Create account", {
          variant: "primary",
        })}
        <span class="spacer"></span>
        ${kind === "signin"
          ? btn("Need an account? Sign up", {
              href: "/signup",
              variant: "link",
              size: "sm",
            })
          : btn("Have an account? Sign in", {
              href: "/signin",
              variant: "link",
              size: "sm",
            })}
      </div>
    </form>`;

  return html`<div class="narrow">
    ${pageHead(kind === "signin" ? "Sign in" : "Create your account")}
    ${card(body)}
  </div>`;
}

export function signinPage(ctx: Ctx): Response {
  return page({ ctx, title: "Sign in", body: authForm(ctx, "signin") });
}

export function signupPage(ctx: Ctx): Response {
  return page({ ctx, title: "Sign up", body: authForm(ctx, "signup") });
}

export async function signinSubmit(ctx: Ctx): Promise<Response> {
  const form = await readForm(ctx);
  if (form instanceof Response) return form;
  const username = field(form, "username");
  const verified = await verifyPassword(
    ctx.app.db,
    username,
    field(form, "password"),
  );
  if (!verified.ok) {
    return page(
      {
        ctx,
        title: "Sign in",
        body: authForm(ctx, "signin", {
          values: { username },
          errors: {
            password:
              ctx.app.config.edgeToken === undefined
                ? "That username and password don't match."
                : `That username and password don't match. An account made through ${ctx.app.config.edgeName ?? "the platform"} has no password here — use the button above.`,
          },
        }),
      },
      422,
    );
  }
  const session = createSession(ctx.app.db, verified.value.id);
  return redirect(
    safeNext(ctx.url.searchParams.get("next")) ?? "/",
    sessionCookie(session.token, session.expiresAt, ctx.url),
  );
}

export async function signupSubmit(ctx: Ctx): Promise<Response> {
  const form = await readForm(ctx);
  if (form instanceof Response) return form;
  const username = field(form, "username");
  const email = field(form, "email");
  const created = await signUp(ctx.app, {
    username,
    email,
    password: field(form, "password"),
  });
  if (!created.ok) {
    const errors: AuthErrors = {
      invalid_username: {
        username: "Usernames are letters, digits, dots, dashes.",
      },
      username_taken: { username: "That username is taken." },
      email_taken: { email: "That email already has an account." },
      weak_password: { password: "Passwords need at least 10 characters." },
    }[created.error] ?? { username: "Something went wrong." };
    return page(
      {
        ctx,
        title: "Sign up",
        body: authForm(ctx, "signup", { values: { username, email }, errors }),
      },
      422,
    );
  }
  const session = createSession(ctx.app.db, created.value.id);
  return redirect(
    safeNext(ctx.url.searchParams.get("next")) ?? "/",
    sessionCookie(session.token, session.expiresAt, ctx.url),
  );
}

// POST /theme — persist the theme choice in a cookie. Works as a plain form
// submit (redirect back to the referring page) and as a background fetch from
// the switcher script; "system" clears the cookie so the OS decides again.
export async function themeSubmit(ctx: Ctx): Promise<Response> {
  const form = await readForm(ctx);
  if (form instanceof Response) return form;
  const choice = field(form, "theme");
  const secure = ctx.url.protocol === "https:" ? "; Secure" : "";
  const cookie = isThemeName(choice)
    ? `forge_theme=${choice}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly${secure}`
    : `forge_theme=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly${secure}`;

  // Return to the page the form was submitted from — same-origin paths only,
  // so the redirect can never be steered off this forge.
  const referer = ctx.request.headers.get("referer");
  let back = "/";
  if (referer !== null) {
    const parsed = URL.parse(referer);
    if (parsed && parsed.origin === ctx.url.origin)
      back = parsed.pathname + parsed.search;
  }
  return redirect(back, cookie);
}

export function logoutSubmit(ctx: Ctx): Response {
  if (crossOrigin(ctx.request, ctx.url))
    return new Response("forbidden", { status: 403 });
  const cookie = ctx.request.headers.get("cookie") ?? "";
  const match = cookie.match(/forge_session=([^;]+)/);
  if (match) destroySession(ctx.app.db, match[1]!);
  return redirect("/", sessionCookie("", new Date(0), ctx.url));
}

// ---- new repository ----

interface RepoValues {
  owner: string;
  name: string;
  description: string;
  visibility: string;
}

function newRepoForm(ctx: Ctx, values: RepoValues, error?: string): Html {
  const user = ctx.auth.user!;
  // Owners the user may create under: themselves, plus orgs they can write to.
  const writeOrgs = listOrgsForUser(ctx.app.db, user.id).filter((org) =>
    accessAllows(orgAccess(ctx.app.db, org.id, user), "write"),
  );
  const owners = [user.username, ...writeOrgs.map((o) => o.username)];

  return html`<div class="narrow-wide">
    ${pageHead("New repository", {
      sub: "A repository is a bare git repo plus its issues, pulls and settings.",
    })}
    ${card(
      html`<form method="post" action="/new">
        ${selectField({
          label: "Owner",
          name: "owner",
          options: owners.map((o) => ({
            value: o,
            label: o,
            selected: o === values.owner,
          })),
        })}
        ${formField({
          label: "Name",
          name: "name",
          value: values.name,
          required: true,
          autofocus: true,
          pattern: "[A-Za-z0-9][A-Za-z0-9._-]*",
          hint: "Letters, digits, dots, dashes and underscores.",
          ...(error ? { error } : {}),
        })}
        ${formField({
          label: "Description",
          name: "description",
          value: values.description,
          hint: "Optional. One line, shown wherever the repo is listed.",
        })}
        ${selectField({
          label: "Visibility",
          name: "visibility",
          hint: "Private repositories are invisible to everyone but you and your teams.",
          options: [
            {
              value: "private",
              label: "Private",
              selected: values.visibility !== "public",
            },
            {
              value: "public",
              label: "Public",
              selected: values.visibility === "public",
            },
          ],
        })}
        <div class="form-actions">
          ${btn("Create repository", { variant: "primary" })}
          ${btn("Cancel", { href: "/", variant: "ghost" })}
        </div>
      </form>`,
    )}
  </div>`;
}

export function newRepoPage(ctx: Ctx): Response {
  if (!ctx.auth.user) return signInFirst(ctx);
  return page({
    ctx,
    title: "New repository",
    body: newRepoForm(ctx, {
      owner: ctx.url.searchParams.get("owner") ?? ctx.auth.user.username,
      name: "",
      description: "",
      visibility: "private",
    }),
  });
}

export async function newRepoSubmit(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const values: RepoValues = {
    owner: field(form, "owner"),
    name: field(form, "name"),
    description: field(form, "description"),
    visibility: form.get("visibility") === "public" ? "public" : "private",
  };
  const created = await createRepo(ctx.app, ctx.auth.user, {
    owner: values.owner,
    name: values.name,
    visibility: values.visibility === "public" ? "public" : "private",
    description: values.description,
  });
  if (!created.ok) {
    if (created.error === "forbidden_owner" || created.error === "unauthorized")
      return new Response("forbidden", { status: 403 });
    const messages: Record<string, string> = {
      name_taken: "That owner already has a repository by that name.",
      invalid_name: "Names start with a letter or digit; no spaces, no .git.",
      git_init_failed: "The repository could not be initialised on disk.",
    };
    return page(
      {
        ctx,
        title: "New repository",
        body: newRepoForm(
          ctx,
          values,
          messages[created.error] ?? "That name won't work.",
        ),
      },
      422,
    );
  }
  return flashTo(ctx, `/${created.value.ownerName}/${created.value.name}`, {
    message: "Repository created.",
  });
}
