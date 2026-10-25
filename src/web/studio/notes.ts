/**
 * The app's notes from its forge button (#4758), on the studio page, for the
 * people who may moderate: the latest `from-app` notes with Hide and Ban
 * sender, and each banned sender once with Unban. The buttons post to the
 * forge's own origin (`POST /:owner/:name/app/notes`), never to the app's
 * host, where moderation is a 404.
 */
import { moderateNote, ownerNotes, unbanSender, type OwnerNote } from "../../actions/app_notes.ts";
import { getAppByRepo, type AppRecord } from "../../core/apps.ts";
import type { Repo } from "../../core/repos.ts";
import type { User } from "../../core/users.ts";
import type { Ctx } from "../../http/context.ts";
import { loadRepo, notFoundPage, repoBase, signInFirst } from "../chrome.ts";
import { readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { flashTo } from "../layout.ts";
import { badge, btn, icon, listCard, row, time } from "../ui.ts";
import { safeBack } from "../../http/context.ts";

const act = (base: string, n: OwnerNote, action: "hide" | "ban" | "unban", label: string, danger = false): Html =>
  html`<form method="post" action="${base}/app/notes" class="inline">
    <input type="hidden" name="id" value="${n.id}" />
    <input type="hidden" name="action" value="${action}" />
    ${btn(label, { size: "sm", ...(danger ? { variant: "danger" as const } : {}) })}
  </form>`;

const sender = (n: OwnerNote): Html =>
  html`${n.by} ${badge(n.person ? "signed in" : "anonymous", { variant: "outline" })}`;

/** The card, or nothing for anyone who may not moderate or when there is nothing to show. */
export function notesCard(ctx: Ctx, repo: Repo, record: AppRecord): Html | null {
  const seen = ownerNotes(ctx.app, record, repo, ctx.auth.user);
  if (seen === undefined || (seen.notes.length === 0 && seen.banned.length === 0)) return null;
  const base = repoBase(repo);
  const notes = seen.notes.map((n) =>
    row({
      title: n.text,
      meta: html`${sender(n)} · ${n.page === "" ? "no page" : n.page} · ${time(n.at)}`,
      trail: html`<span class="bar">${act(base, n, "hide", "Hide")} ${act(base, n, "ban", "Ban sender", true)}</span>`,
    }),
  );
  const banned = seen.banned.map((n) =>
    row({
      title: sender(n),
      meta: html`banned · last wrote ${time(n.at)}`,
      trail: act(base, n, "unban", "Unban"),
    }),
  );
  return html`<div class="stack" id="app-notes">
    ${listCard(notes.length > 0 ? notes : [row({ title: html`<span class="muted">No notes shown.</span>` })], {
      head: html`${icon("comment")}<h2>Notes from the app</h2>`,
    })}
    ${banned.length === 0 ? null : listCard(banned, { head: html`<h2>Banned senders</h2>` })}
  </div>`;
}

const FAILURE: Record<string, string> = {
  forbidden: "You need admin access to do that.",
  unavailable: "That could not be done just now.",
};

// POST /:owner/:name/app/notes — hide a note, ban or unban its sender.
export async function noteModerate(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const record = getAppByRepo(ctx.app.db, repo.id);
  if (record === undefined) return notFoundPage(ctx);
  const user: User | undefined = ctx.auth.user;
  if (!user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const id = String(form.get("id") ?? "");
  const action = String(form.get("action") ?? "");
  if (id === "" || id.length > 64 || !["hide", "ban", "unban"].includes(action))
    return new Response("bad request", { status: 400 });
  const done =
    action === "unban"
      ? unbanSender(ctx.app, record, repo, user, id)
      : await moderateNote(ctx.app, record, repo, user, id, action as "hide" | "ban");
  const back = safeBack(ctx) ?? repoBase(repo);
  if (!done.ok) {
    if (done.error === "not_found") return notFoundPage(ctx);
    return flashTo(ctx, back, { tone: "danger", message: FAILURE[done.error] ?? "That could not be done." });
  }
  return flashTo(ctx, back, {
    message: action === "hide" ? "Note hidden." : action === "ban" ? "Sender banned." : "Sender unbanned.",
  });
}
