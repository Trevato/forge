/**
 * A frozen mirror, said once and fixed in one click (#1090).
 *
 * When an origin is disconnected its mirrors keep their provenance and stop:
 * nothing fetches into them and a push is refused until the origin is back
 * (`origins/push-through.ts`). Left unsaid, that looks exactly like an
 * upstream that has gone quiet — which is how a fork following one came to
 * read "ahead 813, behind 0" while upstream moved on. So a frozen mirror
 * says so wherever its state is shown, and its admin gets the reconnect
 * right there: a select of their own origins on the same host, or the way
 * to connect one (which re-attaches it by itself).
 */

import {
  listUserOrigins,
  reattachMirror,
  type ReattachError,
} from "../../actions/origins.ts";
import { hostOf, siteOf } from "../../core/origins.ts";
import { canAdmin, type Repo, type RepoDetached } from "../../core/repos.ts";
import type { Ctx } from "../../http/context.ts";
import { loadRepo, notFoundPage, repoBase } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { flashTo } from "../layout.ts";
import { btn, selectField } from "../ui.ts";

/** `codeberg.org` from a URL — what a person calls a forge; "" if unknown. */
const hostLabel = (url: string): string => URL.parse(url)?.host ?? "";

/** A day, which is what "disconnected on" wants: `2026-10-11`. */
export function day(iso: string): Html {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return html``;
  const exact = new Date(at).toISOString();
  return html`<time datetime="${exact}">${exact.slice(0, 10)}</time>`;
}

/** "…was disconnected on <day>", or without the day when nobody recorded it. */
export const disconnectedOn = (d: RepoDetached): Html =>
  d.detachedAt === null
    ? html`was disconnected`
    : html`was disconnected on ${day(d.detachedAt)}`;

/** The one sentence a frozen mirror says about itself. */
export function frozenSentence(d: RepoDetached): Html {
  const host = hostLabel(d.htmlUrl);
  return html`This repository mirrors
    <span class="mono">${d.fullName}</span>${host === ""
      ? null
      : html` at ${host}`},
    but that origin ${disconnectedOn(d)};
    ${d.frozenSince === null
      ? html`nothing has been fetched into it since.`
      : html`it has been frozen since ${day(d.frozenSince)}.`}`;
}

/**
 * The quiet block on a frozen mirror's home and branches pages; nothing for
 * any other repository. Every reader gets the sentence — it is the truth
 * about what they are reading — and an admin gets the reconnect.
 */
export function frozenBlock(ctx: Ctx, repo: Repo): Html | null {
  const d = repo.detached;
  if (d === null) return null;
  const user = ctx.auth.user;
  const admin = user !== undefined && canAdmin(ctx.app.db, repo, user);
  const host = hostOf(d.htmlUrl);
  const site = siteOf(d.htmlUrl);
  // Only the viewer's own working origins on the same site — scheme, host
  // and port: reconnecting lends the mirror a credential, nobody can lend
  // one that is not theirs, and one that needs re-authorizing has nothing
  // to lend until it is (which, done under Settings → Origins, reconnects
  // this mirror by itself).
  const origins =
    admin && user !== undefined
      ? listUserOrigins(ctx.app, user).filter(
          (o) => !o.needsReauth && (site === "" || siteOf(o.webUrl) === site),
        )
      : [];
  // The forge's own origin, scheme and all, so the connect form it lands on
  // is filled with something discovery takes as it is.
  const forge = URL.parse(d.htmlUrl)?.origin ?? "";
  const connect = `/settings/origins${forge === "" ? "" : `?host=${encodeURIComponent(forge)}`}#connect`;
  const action = !admin
    ? html`<span class="muted">An admin of this repository can reconnect it.</span>`
    : origins.length === 0
      ? html`Connect an
        account${host === "" ? null : html` at ${hostLabel(d.htmlUrl)}`} under
          <a href="${connect}">Settings → Origins</a>: connecting one
          reconnects this mirror by itself.`
      : html`<form
          method="post"
          action="${repoBase(repo)}/settings/origin/reconnect"
          class="field-row"
        >
          ${selectField({
            name: "origin",
            label: "Reconnect through",
            options: origins.map((o, i) => ({
              value: o.id,
              label: `${o.login} at ${hostLabel(o.webUrl)}`,
              selected: i === 0,
            })),
          })}
          ${btn("Reconnect", { size: "sm", variant: "primary", icon: "sync" })}
        </form>`;
  return html`<div class="small mb" id="frozen">
    ${frozenSentence(d)} ${action}
  </div>`;
}

/** A refusal to re-attach, in a sentence a person can act on. */
export function reattachMessage(
  error: ReattachError,
  d: Pick<RepoDetached, "fullName" | "htmlUrl"> | null,
): string {
  const name = d?.fullName ?? "this repository";
  const host = d === null ? "" : hostLabel(d.htmlUrl);
  switch (error) {
    case "not_found":
      return "No such origin.";
    case "unauthorized":
    case "forbidden":
      return "Only an admin of this repository can reconnect it.";
    case "not_detached":
      return "This repository is not a frozen mirror.";
    case "wrong_host":
      return host === ""
        ? `That origin is not on the forge ${name} came from.`
        : `That origin is not on ${host}, where ${name} came from.`;
    case "remote_unknown":
      return `${name} was mirrored before this forge kept the origin's id for it, so it cannot be told apart from a repository made again under the same name. Mirror it again.`;
    case "origin_cannot_see":
      return `That account cannot see ${name}; connect one that can.`;
    case "not_the_same_repo":
      return `${name} on the origin is a different repository now; it was deleted and made again, so this mirror stays as it is.`;
    case "already_mirrored":
      return `Another repository here already mirrors ${name}.`;
    case "needs_reauth":
      return "That origin needs re-authorizing first.";
    case "unreachable":
      return "The origin could not be reached; try again.";
  }
}

// POST /:owner/:name/settings/origin/reconnect  { origin }
export async function reconnectSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  // A non-admin is told nothing, the way every repository setting is.
  if (!repo || !canAdmin(ctx.app.db, repo, ctx.auth.user))
    return notFoundPage(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const done = await reattachMirror(
    ctx.app,
    ctx.auth.user,
    repo,
    field(form, "origin"),
  );
  if (!done.ok)
    return flashTo(ctx, repoBase(repo), {
      tone: "danger",
      message: reattachMessage(done.error, repo.detached),
    });
  const { origin } = done.value;
  return flashTo(ctx, repoBase(repo), {
    message: `Reconnected to ${origin.login} at ${hostLabel(origin.webUrl)}; syncing.`,
  });
}
