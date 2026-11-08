/**
 * The picker on one connected account: every repository its token can see,
 * each opened live, forked, or mirrored on its own — and the submit that
 * starts a mirror and hands off to the page that watches it.
 *
 * `origins.ts` owns the account list and the helpers both pages share; this
 * file only lists one account's repositories and starts their mirrors.
 */

import {
  listOriginRepoGroup,
  listRemoteRepos,
  startMirrorJob,
  type OriginRepoGroup,
} from "../../actions/origins.ts";
import { getOriginFor, type Origin, type OriginRepoRow } from "../../core/origins.ts";
import { REPO_GROUPS, type RepoGroup } from "../../origins/types.ts";
import { pinnedRepoIds } from "../../core/pins.ts";
import { getRepo, getReposByIds } from "../../core/repos.ts";
import type { Ctx } from "../../http/context.ts";
import { field, readForm } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { flashTo, page, redirect } from "../layout.ts";
import { browseBase, isOwnRepo } from "../scope.ts";
import {
  badge,
  btn,
  empty,
  icon,
  listCard,
  repoCounts,
  row,
  time,
  field as uiField,
} from "../ui.ts";
import {
  accountOnly,
  hostLabel,
  notFoundNote,
  originIcon,
  shell,
} from "./origins.ts";

// GET /settings/origins/:id/repos
export async function originReposPage(ctx: Ctx): Promise<Response> {
  const denied = accountOnly(ctx);
  if (denied) return denied;
  const origin = getOriginFor(
    ctx.app.db,
    ctx.auth.user!.id,
    ctx.params.id ?? "",
  );
  if (!origin) return shell(ctx, notFoundNote(), 404);
  const refresh = ctx.url.searchParams.get("refresh") === "1";
  const query = (ctx.url.searchParams.get("q") ?? "").trim();
  const asked = ctx.url.searchParams.get("group") ?? "";
  const only = (REPO_GROUPS as readonly string[]).includes(asked) ? (asked as RepoGroup) : undefined;
  const cursor = ctx.url.searchParams.get("cursor") ?? undefined;

  // The cached list other doors read follows a refresh; the groups are live.
  if (refresh) await listRemoteRepos(ctx.app, ctx.auth.user, origin.id, true);
  const shown = only === undefined ? REPO_GROUPS : [only];
  const groups = await Promise.all(
    shown.map(async (group) => ({
      group,
      read: await listOriginRepoGroup(ctx.app, ctx.auth.user, origin.id, group, {
        q: query,
        ...(group === only && cursor !== undefined ? { cursor } : {}),
      }),
    })),
  );
  const base = `/settings/origins/${origin.id}/repos`;
  const rows = groups.flatMap(({ read }) => (read.ok ? read.value.items : []));

  const filter = html`<form class="bar mb" method="get" action="${base}">
    <input
      class="input"
      type="search"
      name="q"
      value="${query}"
      placeholder="Search repositories"
      aria-label="Search repositories"
    />
    <button class="btn" data-size="sm" type="submit">Search</button>
    ${btn("Refresh from origin", {
      href: `${base}?refresh=1${query === "" ? "" : `&q=${encodeURIComponent(query)}`}`,
      size: "sm",
      variant: "outline",
      icon: "sync",
    })}
  </form>`;

  // Two grouped reads for the whole picker: the mirrors these rows already
  // point at, and which of those are pinned. A page of fifty remotes was a
  // hundred single-row queries.
  const mirrors = getReposByIds(
    ctx.app.db,
    rows.map((r) => r.mirroredAs ?? "").filter(Boolean),
  );
  const pins =
    ctx.auth.user === undefined
      ? new Set<string>()
      : pinnedRepoIds(ctx.app.db, ctx.auth.user.id);

  const repoRow = (remote: OriginRepoRow): Html => {
            const mirror =
              remote.mirroredAs === null
                ? undefined
                : mirrors.get(remote.mirroredAs);
            const pinned = mirror !== undefined && pins.has(mirror.id);
            // Only offer a name box when the obvious one is taken: the
            // mirror action picks a free name by itself otherwise.
            const collides =
              mirror === undefined &&
              getRepo(
                ctx.app.db,
                ctx.auth.user!.username,
                remote.fullName.split("/")[1] ?? "",
              ) !== undefined;
            // Mirroring is no longer what enter does — the row opens the
            // repository live, and this is the secondary verb beside it.
            const counted = repoCounts({
              openIssues: remote.openIssues,
              openPulls: remote.openPulls,
              issuesIncludePulls: remote.openIssuesIncludingPulls,
            });
            // Fork is the row's other verb: grabbing a repository you cannot
            // push to is a different intention from keeping a copy of one,
            // and making people open the repository first to find it out is
            // a step in the way of the workflow this picker exists for.
            const forkable =
              !remote.canPush && !isOwnRepo(origin.login, remote.fullName);
            const forkForm = when(
              forkable,
              () =>
                html`<form
                  class="row-fields"
                  method="post"
                  action="${browseBase(origin.id, remote.fullName)}/fork"
                >
                  ${btn("Fork", {
                    size: "sm",
                    variant: "ghost",
                    icon: "fork",
                    title: `Fork ${remote.fullName} into your account at ${hostLabel(origin.webUrl)}`,
                  })}
                </form>`,
            );
            const trail =
              mirror !== undefined
                ? html`${counted}${forkForm}${btn("Open mirror", {
                    href: `/${mirror.ownerName}/${mirror.name}`,
                    size: "sm",
                    variant: "outline",
                    icon: "repo",
                  })}`
                : html`${counted}${forkForm}
                    <form
                      class="row-fields"
                      method="post"
                      action="/settings/origins/${origin.id}/mirror"
                    >
                      <input
                        type="hidden"
                        name="fullName"
                        value="${remote.fullName}"
                      />
                      ${when(
                        collides,
                        () =>
                          uiField({
                            label: "Local name",
                            name: "name",
                            id: `mirror-name-${remote.fullName}`,
                            placeholder: "local name",
                            autocomplete: "off",
                            spellcheck: false,
                          }),
                      )}
                      ${btn("Mirror", {
                        size: "sm",
                        variant: "outline",
                        icon: "download",
                      })}
                    </form>`;
            return row({
              nav: true,
              lead: icon(originIcon(origin.kind)),
              // The row is not itself an anchor: it carries a form, and a
              // form inside an <a> is markup the parser pulls apart. The
              // title is the link, and `data-nav` opens it.
              title: html`<a href="${browseBase(origin.id, remote.fullName)}"
                  >${remote.fullName}</a
                >
                ${remote.private
                  ? badge("Private", { icon: "lock", variant: "secondary" })
                  : badge("Public", { variant: "outline" })}
                ${when(remote.fork, () =>
                  badge("Fork", { icon: "fork", variant: "outline" }),
                )}`,
              titleAttr: remote.fullName,
              meta: html`${when(
                mirror,
                (m) =>
                  html`<span class="where-place" data-state="present"
                      ><span aria-hidden="true">●</span
                      >mirrored as
                      <a href="/${m.ownerName}/${m.name}"
                        >${m.ownerName}/${m.name}</a
                      ></span
                    >${when(
                      pinned,
                      () =>
                        html`<span class="sep" aria-hidden="true">·</span
                          ><span
                            class="where-place"
                            data-state="present"
                            title="Kept on your machine"
                            ><span aria-hidden="true">◆</span
                            >this machine</span
                          >`,
                    )}
                    · `,
              )}${remote.description !== ""
                ? html`${remote.description} · `
                : null}${remote.pushedAt === null
                ? html`never pushed`
                : html`pushed ${time(remote.pushedAt)}`}`,
              trail,
            });
  };

  const sections = groups.map(({ group, read }) =>
    groupSection(origin, group, read, repoRow, query, base, only !== undefined),
  );
  const body = html`${sections}`;

  return page({
    ctx,
    title: `${origin.login} @ ${hostLabel(origin.webUrl)}`,
    body: html`<div class="page-head">
        <h1>${origin.login} @ ${hostLabel(origin.webUrl)}</h1>
        <span class="spacer"></span>
        ${btn("Origins", {
          href: "/settings/origins",
          size: "sm",
          variant: "ghost",
        })}
      </div>
      <p class="muted small mb">
        Open any of these to read it live, right now — nothing is downloaded.
        Mirror the ones you actually want, yours or not: a mirror is a
        repository here that follows the one there. Sending work back takes
        write access there, or a fork there; the forge says which.
      </p>
      ${filter} ${body}`,
  });
}

const GROUP_WORDS: Record<RepoGroup, { title: string; note: string; none: string }> = {
  yours: {
    title: "Yours",
    note: "Repositories this account owns there.",
    none: "This account owns no repositories there.",
  },
  shared: {
    title: "Shared with you",
    note: "Someone let this account in: a collaborator, a team or an organization.",
    none: "Nothing has been shared with this account there.",
  },
  public: {
    title: "Public on this forge",
    note: "Anyone may read these. To send work back, fork one there and open a pull; a read-only connection cannot, and is told so.",
    none: "This forge shows no other public repositories.",
  },
};

/** One group, labelled, with its rows or its plain reason for having none. */
function groupSection(
  origin: Origin,
  group: RepoGroup,
  read: Awaited<ReturnType<typeof listOriginRepoGroup>>,
  repoRow: (remote: OriginRepoRow) => Html,
  query: string,
  base: string,
  alone: boolean,
): Html {
  const words = GROUP_WORDS[group];
  const q = query === "" ? "" : `&q=${encodeURIComponent(query)}`;
  const found: OriginRepoGroup = read.ok ? read.value : { items: [], next: null };
  const content = !read.ok
    ? empty({
        icon: "alert",
        title: read.error === "unreachable" ? "The origin could not be reached" : "This group could not be read",
        note: "Nothing was changed. Try again, or reconnect the origin if it needs re-authorizing.",
        action: btn("Back to origins", { href: "/settings/origins", variant: "primary" }),
      })
    : found.items.length === 0
      ? empty({
          icon: "repo",
          title: query === "" ? "No repositories" : "No matches",
          note:
            query === ""
              ? origin.kind === "github" && group === "public"
                ? "GitHub is too large to list. Paste a link on the bring page."
                : words.none
              : "Nothing in this group matches that search.",
        })
      : listCard(found.items.map(repoRow));
  return html`<section class="mb" aria-label="${words.title}">
    <h2>${words.title}</h2>
    <p class="muted small">${words.note}</p>
    ${content}
    ${when(found.next, (next) =>
      btn(found.items.length === 0 ? "Look further" : "More", {
        href: `${base}?group=${group}${q}&cursor=${encodeURIComponent(next)}`,
        size: "sm",
        variant: "outline",
      }),
    )}
    ${when(alone, () => btn("All groups", { href: `${base}${q === "" ? "" : `?${q.slice(1)}`}`, size: "sm", variant: "ghost" }))}
  </section>`;
}

/**
 * POST /settings/origins/:id/mirror — start the mirror, then get out of the
 * way.
 *
 * This used to run the whole import inside the request: a clone, a hook
 * install, and every label, issue, pull and comment, with a spinner-free
 * browser holding the connection open for as long as it took. It starts a
 * job now and redirects to the page that watches it, which is the same answer
 * the live-browse Mirror button gives.
 */
export async function originMirrorSubmit(ctx: Ctx): Promise<Response> {
  const denied = accountOnly(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const originId = ctx.params.id ?? "";
  const fullName = field(form, "fullName").trim();
  const name = field(form, "name").trim();

  const started = startMirrorJob(
    ctx.app,
    ctx.auth.user,
    originId,
    fullName,
    name === "" ? undefined : name,
  );
  if (!started.ok)
    return flashTo(ctx, `/settings/origins/${originId}/repos`, {
      tone: "danger",
      message:
        started.error === "unauthorized"
          ? "Sign in first."
          : "That repository could not be mirrored.",
    });
  return redirect(`/settings/origins/${originId}/mirror/${started.value.id}`);
}
