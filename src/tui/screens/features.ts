/**
 * Absorbed apps whose declared menu entry changed, in the terminal: the rows
 * Settings › Features marks "declaration changed: review". `a` accepts the
 * selected row's declaration through `acceptDeclaration`, the page's own
 * action, posting what the screen showed, so a declaration that moved since is
 * refused. Offered to a site admin who is a person, as the page is.
 */

import { acceptDeclaration, listFeatures, provenanceFacts, type FeatureView } from "../../actions/features.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { emptyState } from "../ui/widgets.ts";
import { ListState, drawList, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

export interface FeaturesScreen extends Screen {
  /** The read or accept in flight, for whoever must wait on it. */
  busy(): Promise<void>;
}

const mayReview = (f: Session): boolean => f.user !== undefined && f.user.isAdmin && f.user.kind !== "agent";

export function featuresScreen(f: Session, ctx: Ctx): FeaturesScreen {
  const state = new ListState();
  let rows: FeatureView[] = [];
  let work: Promise<void> = Promise.resolve();
  const reload = (): Promise<void> =>
    listFeatures(f.app, f.user).then((r) => {
      rows = r.ok ? r.value.filter((v) => v.pending !== null) : [];
      state.clamp(rows.length);
      ctx.invalidate();
    });
  work = reload();

  return {
    title: "Menu entries to review",
    keys: [binding(["j", "k"], "move cursor"), binding(["a"], "accept")],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      if (rows.length === 0) {
        emptyState(s, body!, c, { title: "No absorbed app has a declaration to review." });
        return;
      }
      const line = mayReview(f) ? "a accepts the app's declaration as the menu entry" : "only a site admin accepts";
      s.text(head!.x, head!.y, truncate(line, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      const list: ListRow[] = rows.map((r) => ({
        title: `${r.name} (${r.page})`,
        secondary: [`${r.repo} declares ${r.pending!.name} (${r.pending!.page})`, ...provenanceFacts(r.provenance).map((x) => `${x.label} ${x.value}`)].join(" · "),
        meta: "",
      }));
      drawList(s, body!, c, state, list);
    },
    key(e) {
      if (state.key(e, rows.length)) return true;
      if (e.ctrl || e.alt || e.key !== "a") return false;
      const row = rows[state.index];
      if (row === undefined || row.pending === null || !mayReview(f)) return false;
      work = acceptDeclaration(f.app, f.user, row.slug, row.pending).then(async (done) => {
        if (done.ok) ctx.toast(`${row.pending!.name} is now the menu's entry`, "success");
        else if (done.error === "declaration_changed") ctx.toast("the app declared something else; review it again", "danger");
        else ctx.toast("that could not be accepted", "danger");
        await reload();
      });
      return true;
    },
    busy: () => work,
  };
}

/** The pending declarations: a site admin's, as the settings page is. */
export const entry: PaletteEntry = {
  id: "feature-review",
  title: "Menu entries to review",
  hint: "absorbed apps whose declared name or page changed: accept them",
  offered: mayReview,
  run: (session, ctx) => ctx.push(featuresScreen(session, ctx)),
};
