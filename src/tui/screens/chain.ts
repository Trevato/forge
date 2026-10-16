/**
 * The chain of forges this forge's code descends from, in a card. The gate is
 * the page's: only someone who can read `<org>/forge` sees it, and only that
 * repository's owner is offered Sever, which asks for the same typed word.
 */

import type { App as Forge } from "../../app.ts";
import { severForge } from "../../actions/follow.ts";
import { canAdmin, canRead, getRepo, type Repo } from "../../core/repos.ts";
import type { User } from "../../core/users.ts";
import { chainLines, chainOfRepo, forgeLinkOf, type ChainView } from "../../spawn/chain.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { card } from "../ui/widgets.ts";
import { drawFacts, promptScreen } from "./common.ts";
import { familyScreen } from "./family.ts";

/** The forge repository and its chain, when this viewer may read that repository. */
export async function readableChain(
  app: Forge,
  user: User | undefined,
): Promise<{ repo: Repo; view: ChainView } | undefined> {
  const link = await forgeLinkOf(app);
  if (link === undefined) return undefined;
  const [owner, name] = link.repo.split("/") as [string, string];
  const repo = getRepo(app.db, owner, name);
  if (!repo || !canRead(app.db, repo, user)) return undefined;
  const view = await chainOfRepo(app, repo);
  return view === undefined ? undefined : { repo, view };
}

export async function chainScreen(app: Forge, user: User | undefined, ctx: Ctx): Promise<Screen> {
  const found = await readableChain(app, user);
  if (found === undefined) return familyScreen(ctx, [["chain", "this forge follows nothing across forges"]], "Chain");
  const { repo, view } = found;
  const rows = chainLines(view);
  const owner = user !== undefined && view.severedAt === null && canAdmin(app.db, repo, user);
  if (!owner) return familyScreen(ctx, rows, "Chain");
  const self: Screen = {
    title: "Chain",
    keys: [binding(["s"], "sever"), binding(["esc"], "close")],
    render(area, s) {
      const c = ctx.theme.c;
      const w = Math.min(78, Math.max(30, area.w - 6));
      const h = Math.min(area.h, rows.length + 2);
      const r = { x: area.x + ((area.w - w) >> 1), y: area.y + ((area.h - h) >> 1), w, h };
      const inner = card(s, r, c, { title: "Chain", focused: true });
      drawFacts(s, { x: inner.x + 1, y: inner.y, w: Math.max(0, inner.w - 1), h: inner.h }, c, rows, c.card);
    },
    key(e) {
      if (e.key === "esc" || e.key === "q") ctx.pop();
      else if (e.key === "s")
        ctx.push(
          promptScreen(ctx, self, {
            title: "Sever from the parent forge",
            label: "type sever to confirm",
            onSubmit: (word) => {
              if (word.trim() !== "sever") return "Type sever to confirm.";
              return severForge(app, user, repo).then((cut) => {
                if (!cut.ok) return ctx.toast(`Not severed: ${cut.error}`, "danger");
                ctx.pop();
                ctx.toast("Severed: this forge follows nothing now", "success");
              });
            },
          }),
        );
      return true;
    },
  };
  return self;
}
