/**
 * Outside agents, in the terminal (#12012): the settings page's block
 * (`web/pages/proposal-tokens.ts`) from the same actions
 * (`actions/contribute_token.ts`), gated the same way: a repository's admins.
 * `a` allows outside agents or stops allowing them; `x` revokes the token under
 * the cursor, after a confirm. Each write is an event on the bus, so an open
 * settings page redraws, and this screen follows a write made there.
 */

import { revokeOutsideToken, setOutsideContributions, takesOutside } from "../../actions/contribute_token.ts";
import { contributeOpen, listContribute, type ContributeTokenInfo } from "../../core/contribute_token.ts";
import { canAdmin, type Repo } from "../../core/repos.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Command } from "../app/palette.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, confirmScreen, drawList, later, live, type ListRow } from "./common.ts";

/** Settings › Outside agents' gate: an admin of the repository. */
export const mayManageOutside = (f: Session, repo: Repo): boolean => f.user !== undefined && canAdmin(f.db, repo, f.user);

/**
 * The live tokens, for an admin; none for anyone else, and none while outside
 * agents are not allowed.
 */
export function outsideRows(f: Session, repo: Repo): ContributeTokenInfo[] {
  return mayManageOutside(f, repo) && contributeOpen(f.db, repo.id) ? listContribute(f.db, repo.id, new Date()) : [];
}

export function outsideAgentsScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  const state = new ListState();
  const where = `${repo.ownerName}/${repo.name}`;
  const screen: Screen = {
    title: `${where} — Outside agents`,
    keys: [binding(["j", "k"], "move cursor"), binding(["a"], "allow or stop allowing"), binding(["x"], "revoke token")],
    async load(signal) {
      live(f, signal, { repoId: repo.id, where: (e) => e.kind.startsWith("contribute.") }, () => ctx.invalidate());
    },
    render(area, s) {
      const c = ctx.theme.c;
      const may = mayManageOutside(f, repo);
      const open = contributeOpen(f.db, repo.id);
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      const said = !may
        ? "An admin of this repository manages outside agents."
        : !open
          ? "Outside agents may not ask for a token. a allows them."
          : takesOutside(f.app, repo)
            ? "Outside agents may ask for a day's token. a stops allowing them; x revokes."
            : "Allowed, but not offered now: only a public, original, unarchived repository takes them.";
      s.text(head!.x, head!.y, truncate(said, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      const rows: ListRow[] = outsideRows(f, repo).map((t) => ({
        title: t.agent,
        note: `${t.origin === "" ? "no origin given" : t.origin} · claimed, not verified`,
        meta: `expires ${t.expiresAt.slice(0, 16).replace("T", " ")}`,
      }));
      drawList(s, list!, c, state, rows);
    },
    key(e) {
      const all = outsideRows(f, repo);
      if (state.key(e, all.length)) return true;
      if (e.ctrl || e.alt || (e.key !== "a" && e.key !== "x")) return false;
      if (!mayManageOutside(f, repo)) {
        ctx.toast("An admin of this repository manages outside agents.", "danger");
        return true;
      }
      if (e.key === "a") {
        const on = !contributeOpen(f.db, repo.id);
        const set = setOutsideContributions(f.app, f.user, repo, on);
        ctx.toast(
          !set.ok
            ? "An admin of this repository manages outside agents."
            : on
              ? "Outside agents may ask for a token."
              : "Outside agents may no longer ask. Tokens already made work until revoked.",
          set.ok ? undefined : "danger",
        );
        ctx.invalidate();
        return true;
      }
      const at = all[state.index];
      if (at === undefined) return true;
      void later(ctx, () =>
        confirmScreen(ctx, screen, {
          title: "Revoke token",
          body: [`${at.agent}'s token stops working now. Pulls it opened stay.`],
          actions: [{ label: "Cancel", variant: "ghost" }, { label: "Revoke" }],
          selected: 0,
          onChoose: (i) => {
            if (i !== 1) return;
            const done = revokeOutsideToken(f.app, f.user, repo, at.id);
            ctx.toast(done.ok ? `${at.agent}'s token revoked.` : "No such token.", done.ok ? undefined : "danger");
            ctx.invalidate();
          },
        }),
      );
      return true;
    },
  };
  return screen;
}

/** The palette's command while a repository the viewer administers is open. */
export function outsideAgentsCommands(f: Session, ctx: Ctx, repo: Repo | undefined): Command[] {
  if (repo === undefined || !mayManageOutside(f, repo)) return [];
  return [
    {
      id: "outside-agents",
      title: `${repo.ownerName}/${repo.name} — Outside agents`,
      hint: "allow outside agents' day tokens, see and revoke the live ones",
      run: () => ctx.push(outsideAgentsScreen(f, ctx, repo)),
    },
  ];
}
