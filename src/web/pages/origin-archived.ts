/**
 * `/settings/origins/:id/archived`: the repositories archived on one connected
 * Forgejo, each a click from coming back. Works with no JavaScript: one form
 * holds the checkboxes and every Restore button, and the submit answers with
 * this same page, per-row results on top.
 */

import { scopeWords } from "../../origins/providers/http.ts";
import type { ArchivedRepo } from "../../origins/types.ts";
import {
  archiveFailureWords,
  MAX_RESTORE,
  readArchived,
  restoreArchived,
  type RestoreResult,
} from "../../actions/origin_archive.ts";
import type { Ctx } from "../../http/context.ts";
import { field, readForm } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { badge, btn, empty, listCard, row, time } from "../ui.ts";
import { accountOnly, hostLabel, notFoundNote, shell } from "./origins.ts";

const selectAllJs = /* js */ `
var all = document.querySelector('[data-archived-all]');
if (all) {
  all.closest('label').hidden = false;
  all.addEventListener('change', function () {
    document.querySelectorAll('input[name="repo"]').forEach(function (b) { b.checked = all.checked; });
  });
}
`;

const pageOf = (value: string | null): number => {
  const page = Number(value ?? "1");
  return Number.isInteger(page) && page >= 1 && page <= 10_000 ? page : 1;
};

const hrefOf = (base: string, query: string, page: number): string => {
  const params = new URLSearchParams();
  if (query !== "") params.set("q", query);
  if (page > 1) params.set("page", String(page));
  const search = params.toString();
  return search === "" ? base : `${base}?${search}`;
};

function resultsCard(results: readonly RestoreResult[]): Html {
  const restored = results.filter((r) => r.state === "restored").length;
  return listCard(
    results.map((result) =>
      result.state === "restored"
        ? row({
            title: result.fullName,
            meta: html`The origin now says this repository is not archived.`,
            trail: badge("Restored", { tone: "success", icon: "check" }),
          })
        : row({
            title: result.fullName,
            meta: html`${result.message}`,
            trail: badge(
              result.state === "unconfirmed" ? "Unconfirmed" : "Not restored",
              {
                tone: result.state === "unconfirmed" ? "attn" : "danger",
                icon: "alert",
              },
            ),
            after: html`<button
              class="btn"
              data-size="sm"
              type="submit"
              name="one"
              value="${result.fullName}"
            >
              Retry
            </button>`,
          }),
    ),
    {
      extra: "mb archived-list",
      attrs: html`role="status"`,
      head: html`<h2>
        Restored ${String(restored)} of ${String(results.length)}
      </h2>`,
    },
  );
}

async function render(
  ctx: Ctx,
  options: {
    query: string;
    page: number;
    results?: readonly RestoreResult[];
    notice?: string;
  },
): Promise<Response> {
  const user = ctx.auth.user!;
  const id = ctx.params.id ?? "";
  const { query } = options;
  let page = options.page;
  let read = await readArchived(ctx.app, user, id, { query, page });
  // Restoring can empty the last page; the rest of the list is still there.
  if (
    read.ok &&
    page > 1 &&
    read.value.listed.ok &&
    read.value.listed.value.items.length === 0
  ) {
    page = 1;
    read = await readArchived(ctx.app, user, id, { query, page });
  }
  if (!read.ok) return shell(ctx, notFoundNote(), 404);
  const { origin, listed, missingWrite } = read.value;
  const base = `/settings/origins/${origin.id}/archived`;
  const host = hostLabel(origin.webUrl);
  const canWrite = missingWrite.length === 0;

  const head = html`<div class="bar mb">
      <h2>Archived on ${host}</h2>
      <span class="spacer"></span>
      ${btn("Back to connected accounts", {
        href: "/settings/origins",
        size: "sm",
        variant: "ghost",
      })}
    </div>
    <p class="small mb">
      Restoring a repository makes it writable again. Apps the platform spun
      down when it was archived may need starting there.
    </p>
    ${when(
      !canWrite,
      () => html`<p class="small mb">
        This token cannot restore anything: it is missing
        <strong>${scopeWords(missingWrite)}</strong>
        (<code>${missingWrite.join(", ")}</code>).
        ${btn("Replace the token", {
          href: "/settings/origins",
          size: "sm",
          variant: "ghost",
        })}
      </p>`,
    )}
    ${when(
      options.notice !== undefined,
      () => html`<p class="small mb" role="status">${options.notice ?? ""}</p>`,
    )}`;

  const results = options.results ?? [];
  const hidden = html`<input type="hidden" name="q" value="${query}" />
    <input type="hidden" name="page" value="${String(page)}" />`;
  const action = hrefOf(base, "", 1);

  if (!listed.ok)
    return shell(
      ctx,
      html`${head}
        <form method="post" action="${action}">
          ${hidden}${when(results.length > 0, () => resultsCard(results))}
        </form>
        ${empty({
          icon: "alert",
          title:
            listed.error.error === "unreachable"
              ? `${host} could not be reached`
              : `${host} did not give the list`,
          note: `${archiveFailureWords(listed.error)} Nothing was changed by looking.`,
          action: btn("Try again", {
            href: hrefOf(base, query, page),
            variant: "primary",
          }),
        })}`,
    );

  const { items, total, hasNext } = listed.value;
  const filter = html`<form class="bar mb" method="get" action="${base}">
    <input
      class="input"
      type="search"
      name="q"
      value="${query}"
      placeholder="Filter by name"
      aria-label="Filter archived repositories by name"
    />
    <button class="btn" data-size="sm" type="submit">Filter</button>
  </form>`;

  const rowOf = (repo: ArchivedRepo): Html => {
    const restorable = canWrite && repo.canChange;
    const bring = `/bring?link=${encodeURIComponent(`${origin.webUrl.replace(/\/+$/, "")}/${repo.fullName}`)}`;
    return row({
      lead: when(canWrite, () =>
        restorable
          ? html`<label class="check"
              ><input
                type="checkbox"
                name="repo"
                value="${repo.fullName}"
                aria-label="Select ${repo.fullName}"
            /></label>`
          : html`<label class="check"
              ><input
                type="checkbox"
                disabled
                aria-label="${repo.fullName} needs admin to restore"
            /></label>`,
      ),
      title: repo.name,
      meta: html`${repo.owner}${when(
        repo.private,
        () => html` · private`,
      )}${when(
        repo.archivedAt !== null,
        () => html` · archived ${time(repo.archivedAt ?? "")}`,
      )}`,
      trail: when(canWrite && !repo.canChange, () =>
        badge("Needs admin", { tone: "attn" }),
      ),
      after: html`${btn("Bring here", {
        href: bring,
        size: "sm",
        variant: "ghost",
      })}${when(
        restorable,
        () =>
          html`<button
            class="btn"
            data-size="sm"
            type="submit"
            name="one"
            value="${repo.fullName}"
          >
            Restore
          </button>`,
      )}`,
    });
  };

  const anyRestorable = canWrite && items.some((repo) => repo.canChange);
  const list =
    items.length === 0
      ? empty({
          icon: "repo",
          title: query === "" ? "No archived repositories" : "No matches",
          note:
            query === ""
              ? `This token sees nothing archived on ${host}.`
              : "Nothing archived on this origin matches that filter.",
        })
      : listCard(items.map(rowOf), {
          extra: "archived-list",
          ...(anyRestorable
            ? {
                head: html`<label class="check" hidden
                    ><input
                      type="checkbox"
                      data-archived-all
                      aria-label="Select all on this page"
                  /></label>
                  <span class="muted small"
                    >${total === null ? "" : `${String(total)} archived`}</span
                  >
                  <span class="spacer"></span>
                  <button
                    class="btn"
                    data-size="sm"
                    type="submit"
                    name="selected"
                    value="1"
                  >
                    Restore selected
                  </button>`,
              }
            : {}),
        });

  const pages = when(
    page > 1 || hasNext,
    () =>
      html`<nav class="pager" aria-label="Pagination">
        ${when(page > 1, () =>
          btn("Previous", {
            href: hrefOf(base, query, page - 1),
            size: "sm",
            variant: "outline",
          }),
        )}
        <span>Page ${String(page)}</span>
        ${when(hasNext, () =>
          btn("Next", {
            href: hrefOf(base, query, page + 1),
            size: "sm",
            variant: "outline",
          }),
        )}
      </nav>`,
  );

  return shell(
    ctx,
    html`${head}${filter}
      <form method="post" action="${action}">
        ${hidden}${when(results.length > 0, () => resultsCard(results))}${list}
      </form>
      ${pages}`,
    200,
    selectAllJs,
  );
}

/** GET /settings/origins/:id/archived */
export async function originArchivedPage(ctx: Ctx): Promise<Response> {
  const denied = accountOnly(ctx);
  if (denied) return denied;
  return render(ctx, {
    query: (ctx.url.searchParams.get("q") ?? "").trim().slice(0, 200),
    page: pageOf(ctx.url.searchParams.get("page")),
  });
}

/** POST /settings/origins/:id/archived: a row's Restore, a Retry, or the selection. */
export async function originArchivedRestore(ctx: Ctx): Promise<Response> {
  const denied = accountOnly(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const query = field(form, "q").trim().slice(0, 200);
  const page = pageOf(field(form, "page"));
  const one = field(form, "one");
  const picked =
    one !== ""
      ? [one]
      : [...new Set(form.getAll("repo").filter((v) => typeof v === "string"))];
  if (picked.length === 0)
    return render(ctx, {
      query,
      page,
      notice: "Select at least one repository first.",
    });
  if (picked.length > MAX_RESTORE)
    return render(ctx, {
      query,
      page,
      notice: `That is ${String(picked.length)} at once. Nothing was changed; select ${String(MAX_RESTORE)} or fewer.`,
    });
  const done = await restoreArchived(
    ctx.app,
    ctx.auth.user!,
    ctx.params.id ?? "",
    picked,
  );
  if (!done.ok) return shell(ctx, notFoundNote(), 404);
  return render(ctx, { query, page, results: done.value });
}
