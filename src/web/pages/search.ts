/**
 * Finding things, and confirming the things you cannot take back.
 *
 * `/search` is the no-JavaScript twin of the command palette: one query box
 * over the repositories and issues the viewer may see. `/-/confirm` is the
 * second, deliberate step every destructive POST passes through — and the
 * only page in the product that knows which routes are dangerous, so a
 * crafted link can neither invent reassuring words nor aim at an endpoint
 * that was never meant to be confirmed.
 */

import { listIssues } from "../../core/issues.ts";
import { listReposVisibleTo, type Repo } from "../../core/repos.ts";
import type { Ctx } from "../../http/context.ts";
import { notFoundPage, pageHead } from "../chrome.ts";
import { html, when, type Html } from "../html.ts";
import { icon } from "../icons.ts";
import { page } from "../layout.ts";
import {
  btn,
  card,
  empty,
  field as formField,
  listCard,
  row,
  stateBadge,
  time,
  userLink,
} from "../ui.ts";

/** One repository, as a row. The same shape the dashboard and profiles use. */
const repoRow = (repo: Repo): Html =>
  row({
    href: `/${repo.ownerName}/${repo.name}`,
    nav: true,
    lead: icon(repo.forkParentId !== null ? "fork" : "repo"),
    title: `${repo.ownerName}/${repo.name}`,
    titleAttr: `${repo.ownerName}/${repo.name}`,
    ...(repo.description !== "" ? { meta: html`${repo.description}` } : {}),
    trail:
      repo.visibility === "private"
        ? html`<span class="badge" data-variant="secondary"
            >${icon("lock")}Private</span
          >`
        : html``,
  });

// ---- search ----

// The palette is the fast path; this page is the one that always works.
export function searchPage(ctx: Ctx): Response {
  const query = (ctx.url.searchParams.get("q") ?? "").trim();
  const form = html`<form
    class="filters"
    method="get"
    action="/search"
    role="search"
  >
    <input
      class="input search"
      type="search"
      name="q"
      value="${query}"
      placeholder="Search repositories and issues"
      aria-label="Search"
      autofocus
      data-search-input
    />
    <button class="btn" data-variant="primary" data-size="sm" type="submit">
      Search
    </button>
  </form>`;

  if (query === "") {
    return page({
      ctx,
      title: "Search",
      body: html`${pageHead("Search")} ${form}
      ${empty({
        icon: "search",
        title: "Search this forge",
        note: "Repository names and issue or pull-request titles, across everything you can see.",
      })}`,
    });
  }

  const repos = listReposVisibleTo(ctx.app.db, ctx.auth.user, {
    query,
    limit: 20,
  });
  const scope = listReposVisibleTo(ctx.app.db, ctx.auth.user, { limit: 20 });
  const hits: Html[] = [];
  for (const repo of scope) {
    for (const kind of ["issue", "pull"] as const) {
      for (const issue of listIssues(ctx.app.db, repo.id, {
        state: "all",
        kind,
        query,
        limit: 5,
      })) {
        hits.push(
          row({
            href: `/${repo.ownerName}/${repo.name}/${kind === "issue" ? "issues" : "pulls"}/${issue.number}`,
            nav: true,
            lead: icon(kind === "issue" ? "issue" : "pull"),
            title: issue.title,
            titleAttr: issue.title,
            meta: html`<a href="/${repo.ownerName}/${repo.name}"
                >${repo.ownerName}/${repo.name}</a
              >
              #${issue.number} · opened ${time(issue.createdAt)} by
              ${userLink(issue.authorName, { avatar: false })}`,
            trail: stateBadge(issue.state),
          }),
        );
      }
    }
  }

  const body = html`${pageHead(html`Results for “${query}”`)} ${form}
    <h2 class="mt">Repositories</h2>
    ${repos.length === 0
      ? empty({ icon: "repo", title: "No repositories match" })
      : listCard(repos.map(repoRow))}
    <h2 class="mt">Issues and pull requests</h2>
    ${hits.length === 0
      ? empty({ icon: "issue", title: "No issues or pull requests match" })
      : listCard(hits.slice(0, 40))}`;
  return page({ ctx, title: `Search · ${query}`, body });
}

// ---- confirmation ----

interface Destructive {
  verb: string;
  title: string;
  detail: string;
  /** A phrase the visitor must type back before the button will work. */
  phrase: string;
}

/**
 * The routes this page will confirm, and the words it uses for each. The
 * wording is derived here, never taken from the link — otherwise a mailed
 * URL could put "Continue" on a button that deletes a repository.
 */
const DESTRUCTIVE: {
  pattern: RegExp;
  describe: (m: RegExpMatchArray) => Destructive;
}[] = [
  {
    pattern: /^\/([^/]+)\/([^/]+)\/settings\/delete$/,
    describe: (m) => ({
      verb: "Delete this repository",
      title: `Delete ${m[1]}/${m[2]}?`,
      detail:
        "Every issue, pull request, comment and webhook goes with it, and the git objects are removed from disk. Forks are detached first and keep working. This cannot be undone.",
      phrase: `${m[1]}/${m[2]}`,
    }),
  },
  {
    pattern: /^\/([^/]+)\/([^/]+)\/settings\/labels\/([^/]+)\/delete$/,
    describe: (m) => ({
      verb: "Delete label",
      title: "Delete this label?",
      detail: `It is removed from every issue and pull request in ${m[1]}/${m[2]} that carries it. The issues themselves are untouched.`,
      phrase: "",
    }),
  },
  {
    pattern: /^\/([^/]+)\/([^/]+)\/settings\/hooks\/([^/]+)\/delete$/,
    describe: (m) => ({
      verb: "Delete webhook",
      title: "Delete this webhook?",
      detail: `${m[1]}/${m[2]} stops POSTing events to it immediately. Pending deliveries are dropped.`,
      phrase: "",
    }),
  },
  {
    pattern: /^\/settings\/tokens\/([^/]+)\/delete$/,
    describe: () => ({
      verb: "Revoke token",
      title: "Revoke this access token?",
      detail:
        "Anything using it — a script, a CI job, a git remote — stops working at once. The secret cannot be recovered, only replaced.",
      phrase: "",
    }),
  },
  {
    pattern: /^\/settings\/keys\/([^/]+)\/delete$/,
    describe: () => ({
      verb: "Remove key",
      title: "Remove this SSH key?",
      detail: "The machine holding it can no longer authenticate as you.",
      phrase: "",
    }),
  },
  {
    pattern: /^\/([^/]+)\/-\/teams\/([^/]+)\/delete$/,
    describe: (m) => ({
      verb: "Delete team",
      title: "Delete this team?",
      detail: `Its members lose whatever access it granted them in ${m[1]}. The accounts themselves are untouched.`,
      phrase: "",
    }),
  },
];

function describeTarget(to: string): Destructive | undefined {
  for (const entry of DESTRUCTIVE) {
    const match = to.match(entry.pattern);
    if (match) return entry.describe(match);
  }
  return undefined;
}

/**
 * The confirmation step for anything destructive. Every dangerous button is a
 * link to this page, so the mutation needs a second, deliberate POST — with
 * or without JavaScript, and with no way to arrive here by a stray click.
 *
 * `to` is the POST target and is checked twice: it must be a path on this
 * forge (never absolute or protocol-relative), and it must be a route the
 * table above recognises as destructive.
 */
export function confirmPage(ctx: Ctx): Response {
  const params = ctx.url.searchParams;
  const to = params.get("to") ?? "";
  if (
    !to.startsWith("/") ||
    to.startsWith("//") ||
    to.includes("\\") ||
    /[\n\r]/.test(to)
  ) {
    return notFoundPage(ctx);
  }
  const known = describeTarget(to);
  // Only routes this file knows are destructive can be confirmed. A crafted
  // link therefore cannot invent reassuring words for a dangerous button, and
  // cannot aim the form at an endpoint that was never meant for it.
  if (!known) return notFoundPage(ctx);
  const { verb, title, detail, phrase } = known;

  const referer = ctx.request.headers.get("referer");
  let back = "/";
  if (referer !== null) {
    const parsed = URL.parse(referer);
    if (parsed && parsed.origin === ctx.url.origin)
      back = parsed.pathname + parsed.search;
  }

  const body = html`<div class="narrow-wide">
    ${pageHead(title)}
    ${card(
      html`<p>${detail}</p>
        <form method="post" action="${to}" class="mt">
          ${when(phrase !== "", () =>
            formField({
              label: `Type ${phrase} to continue`,
              name: "confirm",
              required: true,
              autofocus: true,
              mono: true,
              autocomplete: "off",
            }),
          )}
          <div class="form-actions">
            ${btn(verb, { variant: "danger" })}
            ${btn("Cancel", { href: back, variant: "ghost" })}
          </div>
        </form>`,
      {
        tone: "danger",
        head: html`${icon("alert")}
          <h2>${verb}</h2>`,
      },
    )}
  </div>`;
  return page({ ctx, title: `${verb} · forge`, body });
}
