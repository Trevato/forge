/**
 * The right-hand pane of /talk (#11009): the live preview of the repository
 * the chat is working on, with Code and Diff tabs beside it. What it shows is
 * `actions/talk_workspace.ts`'s, the same the terminal's `p` view reads. The
 * preview is a frame of the running app's own origin (the page names that one
 * origin in `frame-src`, nothing wider), reloaded by the script when a turn
 * ends, which is when a push has deployed. Code lists the files the chat
 * touched; Diff links the pull's files page, which cannot be framed. The tabs
 * are links (`?pane=`), the chosen one drawn by the server, so all of it works
 * with the script off; with it, a tab swaps the pane in place and the reply
 * streaming beside it carries on.
 */

import { workspaceOf, type Apps } from "../../actions/talk_workspace.ts";
import type { User } from "../../core/users.ts";
import type { Work } from "../../core/talk_work.ts";
import type { Ctx } from "../../http/context.ts";
import { html, raw, type Html } from "../html.ts";

export interface Pane {
  readonly html: Html;
  /** The one origin the frame needs in `frame-src`, when there is something running to frame. */
  readonly frame: string | undefined;
}

export const VIEWS = ["preview", "code", "diff"] as const;
export type View = (typeof VIEWS)[number];

export function talkPane(ctx: Ctx, user: User, name: string | undefined, works: ReadonlyMap<string, Work>, view: View = "preview", apps?: Apps): Pane {
  const empty = (words: string): Pane => ({
    frame: undefined,
    html: html`<aside class="talk-pane" aria-label="Preview"><p class="muted small">${words}</p></aside>`,
  });
  if (name === undefined) return empty("No repository yet.");
  const ws = workspaceOf(ctx.app, user, name, apps);
  if (ws === undefined) return empty("Not a repository you can see.");
  const { pull, url } = ws;
  const tab = (id: View, label: string): Html => html`<a href="?pane=${id}"${view === id ? raw(' aria-current="page"') : null}>${label}</a>`;
  const files = [...new Map([...works.values()].flatMap((w) => w.links).filter((l) => l.href.includes("/blob/")).map((l) => [l.href, l] as const)).values()].slice(0, 12);
  const panel =
    view === "code"
      ? files.length === 0
        ? html`<p class="muted small">No files touched yet.</p>`
        : html`<ul class="list">${files.map((f) => html`<li><a href="${f.href}">${f.label}</a></li>`)}</ul>`
      : view === "diff"
        ? pull === undefined
          ? html`<p class="muted small">No open pull yet.</p>`
          : html`<p><a class="btn" href="/${name}/pulls/${String(pull)}/files">Diff of pull #${String(pull)}</a></p>`
        : url === undefined
          ? html`<p class="muted small">Nothing running yet.</p>`
          : html`<iframe class="talk-frame" data-frame src="${url}" title="Live preview of ${name}" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>`;
  return {
    frame: ws.origin,
    html: html`<aside class="talk-pane" aria-label="Preview of ${name}">
      <p class="small"><strong>${name}</strong> · ${pull === undefined ? "Production" : `Pull #${String(pull)}`}${url === undefined ? null : html` · <a href="${url}" target="_blank" rel="noopener">Open on its own</a>`}</p>
      <nav class="tabs" aria-label="Preview, code or diff">${tab("preview", "Preview")}${tab("code", "Code")}${tab("diff", "Diff")}</nav>
      ${panel}
    </aside>`,
  };
}
