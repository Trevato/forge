/**
 * A feature's feed items in the terminal: the page's "In the feed" under
 * Settings › Features. The list is the apps absorbed as features that this
 * person may read (`absorbedForNav`, the menu's own read); `enter` opens one
 * and shows what `feedOf` gives, as the page and `GET /api/v1/features/:slug/feed`
 * do: the viewer's own feed items about that repository, muted or not.
 */

import { absorbedForNav, feedOf, getFeature, type NavFeature } from "../../actions/features.ts";
import type { FeedItem } from "../../feed/rank.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { emptyState } from "../ui/widgets.ts";
import { ListState, ago, drawList, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

const oneLine = (text: string): string => text.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ");

/** One feature's items. A feature that cannot be read, or a guest, has none. */
export function featureFeedScreen(f: Session, ctx: Ctx, feature: NavFeature): Screen {
  const state = new ListState();
  let items: readonly FeedItem[] = [];
  void getFeature(f.app, f.user, feature.slug).then((found) => {
    items = found.ok ? feedOf(f.app, f.user, found.value) : [];
    ctx.invalidate();
  });
  return {
    title: `In the feed: ${feature.name}`,
    keys: [binding(["j", "k"], "move"), binding(["esc", "q"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      if (items.length === 0) {
        emptyState(s, area, c, { title: "Nothing yet." });
        return;
      }
      const rows: ListRow[] = items.map((i) => ({ title: oneLine(i.what), secondary: oneLine(i.actor ?? i.app), meta: ago(i.at) }));
      drawList(s, area, c, state, rows);
    },
    key(e) {
      if (e.key === "esc" || e.key === "q") ctx.pop();
      else state.key(e, items.length);
      return true;
    },
  };
}

export function featureFeedPicker(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  const features = absorbedForNav(f.app, f.user);
  return {
    title: "Feature feeds",
    keys: [binding(["j", "k"], "move"), binding(["enter"], "open"), binding(["esc", "q"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      if (features.length === 0) {
        emptyState(s, area, c, { title: "No absorbed app to show." });
        return;
      }
      drawList(s, area, c, state, features.map((x): ListRow => ({ title: x.name, secondary: x.repo, meta: "" })));
    },
    key(e) {
      if (e.key === "esc" || e.key === "q") ctx.pop();
      else if (e.key === "enter") {
        const at = features[state.index];
        if (at !== undefined) ctx.push(featureFeedScreen(f, ctx, at));
      } else state.key(e, features.length);
      return true;
    },
  };
}

export const entry: PaletteEntry = {
  id: "feature-feed",
  title: "Feature feeds",
  hint: "the feed items about an absorbed app, as Settings › Features shows them",
  after: ["feature-review"],
  offered: (session) => session.user !== undefined,
  run: (session, ctx) => ctx.push(featureFeedPicker(session, ctx)),
};
