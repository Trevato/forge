/**
 * Hosts an app's cells were refused, in the terminal (#10456): the web
 * page's rows (`web/studio/blocked.ts`) from the same actions
 * (`actions/egress_refused.ts`), gated the same way — a repository's admins
 * only, offered while the repository is open. `a` allows the host under the
 * cursor, `i` ignores it. Each write is an event, so an open web page
 * updates, and this screen follows a write made there.
 */

import { allowBlocked, blockedView, ignoreBlocked, type BlockedError } from "../../actions/egress_refused.ts";
import { getAppByRepo } from "../../core/apps.ts";
import { canAdmin, type Repo } from "../../core/repos.ts";
import type { Ctx, Screen } from "../app/app.ts";
import type { Command } from "../app/palette.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, drawList, live, type ListRow } from "./common.ts";

const WORDS: Record<BlockedError, string> = {
  not_found: "That is not yours to change.",
  invalid: "That is not a host and port.",
  not_refused: "The app was not refused that.",
  needs_site_admin: "A private destination needs a site admin's yes.",
  needs_human: "An agent proposes the forge.json change in a pull.",
};

const mayOpen = (f: Session, repo: Repo | undefined): repo is Repo =>
  repo !== undefined && f.user !== undefined && canAdmin(f.db, repo, f.user) && getAppByRepo(f.db, repo.id) !== undefined;

export function blockedScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  const state = new ListState();
  const rows = () => {
    const view = blockedView(f.app, f.user, repo);
    return view.ok ? view.value.rows : [];
  };
  return {
    title: `${repo.ownerName}/${repo.name} — Blocked hosts`,
    keys: [binding(["j", "k"], "move cursor"), binding(["a"], "allow"), binding(["i"], "ignore")],
    async load(signal) {
      live(f, signal, { repoId: repo.id, where: (e) => e.kind.startsWith("app.egress.") }, () => ctx.invalidate());
    },
    render(area, s) {
      const c = ctx.theme.c;
      const all = rows();
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      s.text(
        head!.x,
        head!.y,
        truncate(all.length === 0 ? "Nothing is blocked." : "a allows the host, i ignores it.", head!.w),
        style(c.mutedFg, c.bg),
        head!.x + head!.w,
      );
      const lines: ListRow[] = all.map((r) => ({ title: r.line, ...(r.private ? { meta: "private: a site admin allows it" } : {}) }));
      drawList(s, list!, c, state, lines);
    },
    key(e) {
      const all = rows();
      if (state.key(e, all.length)) return true;
      if (e.ctrl || e.alt) return false;
      const at = all[state.index];
      if (at === undefined || (e.key !== "a" && e.key !== "i")) return false;
      const said = (ok: boolean, text: string): void => {
        ctx.toast(text, ok ? undefined : "danger");
        ctx.invalidate();
      };
      if (e.key === "a")
        void allowBlocked(f.app, f.user, repo, at.destination).then((r) =>
          said(r.ok, r.ok ? `${r.value.entry} is allowed.` : WORDS[r.error]),
        );
      else {
        const r = ignoreBlocked(f.app, f.user, repo, at.destination);
        said(r.ok, r.ok ? `Ignoring ${r.value}.` : WORDS[r.error]);
      }
      return true;
    },
  };
}

/** The palette's command while a repository is open, to the repository's admins. */
export function blockedCommands(f: Session, ctx: Ctx, repo: Repo | undefined): Command[] {
  if (!mayOpen(f, repo)) return [];
  return [
    {
      id: "blocked-hosts-app",
      title: `${repo.ownerName}/${repo.name} — Blocked hosts`,
      hint: "hosts this app was refused: allow or ignore them",
      run: () => ctx.push(blockedScreen(f, ctx, repo)),
    },
  ];
}
