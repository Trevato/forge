/**
 * A feature's feed items in the terminal: the page's "In the feed" under
 * Settings › Features. The list is the apps absorbed as features that this
 * person may read (`absorbedForNav`, the menu's own read); `enter` opens one
 * and shows what `feedOf` gives, as the page and `GET /api/v1/features/:slug/feed`
 * do: the viewer's own feed items about that repository, muted or not.
 */

import { runNow } from "../../apps/feature_run.ts";
import { runLine, runtimeReach } from "../../apps/feature_schedule.ts";
import { getAppBySlug } from "../../core/apps.ts";
import { absorbedForNav, feedOf, getFeature, type NavFeature } from "../../actions/features.ts";
import type { Fired, Run } from "../../core/feature_fires.ts";
import type { FeedItem } from "../../feed/rank.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { emptyState } from "../ui/widgets.ts";
import { ListState, ago, drawList, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

const oneLine = (text: string): string => text.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ");

/** One feature's items. A feature that cannot be read, or a guest, has none. */
export function featureFeedScreen(f: Session, ctx: Ctx, feature: NavFeature): Screen {
  const state = new ListState();
  let items: readonly FeedItem[] = [];
  let fires: readonly Fired[] = [];
  let lines: readonly string[] = [];
  let history: readonly Run[] = [];
  let showHistory = false;
  void getFeature(f.app, f.user, feature.slug).then((found) => {
    items = found.ok ? feedOf(f.app, f.user, found.value) : [];
    fires = found.ok ? found.value.fires : [];
    lines = found.ok ? found.value.schedule.map((x) => x.line) : [];
    history = found.ok ? found.value.history : [];
    ctx.invalidate();
  });
  const mayRun = (): boolean => f.user?.isAdmin === true && f.user.kind !== "agent" && fires.length > 0;
  let running = false;
  /** Run every tool on the Scheduled line now, saying the page's sentences. */
  async function runAll(): Promise<void> {
    const record = getAppBySlug(f.app.db, feature.slug);
    if (record === undefined || running) return;
    running = true;
    try {
      for (const tool of fires.map((x) => x.tool)) {
        const said = await runNow(f.app.db, record.id, tool, runtimeReach(f.app, record), "terminal");
        ctx.toast(said.message, said.ok ? "success" : "danger");
      }
      const found = await getFeature(f.app, f.user, feature.slug);
      fires = found.ok ? found.value.fires : fires;
      lines = found.ok ? found.value.schedule.map((x) => x.line) : lines;
      history = found.ok ? found.value.history : history;
    } finally {
      running = false;
      ctx.invalidate();
    }
  }
  return {
    title: `In the feed: ${feature.name}`,
    keys: [binding(["j", "k"], "move"), ...(history.length > 0 ? [binding(["h"], showHistory ? "show the feed" : "show run history")] : []), ...(mayRun() ? [binding(["r"], "run scheduled now")] : []), binding(["esc", "q"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      // One line per scheduled tool (`print_today at 07:15 America/Chicago · last …`).
      const [head, body] = lines.length === 0 ? [undefined, area] : split(area, "v", [len(lines.length), fill(1)]);
      if (head !== undefined)
        lines.forEach((l, i) => s.text(head.x, head.y + i, truncate(oneLine(i === 0 ? `Scheduled: ${l}` : `           ${l}`), head.w), style(c.mutedFg, c.bg), head.x + head.w));
      if (showHistory) {
        drawList(s, body!, c, state, history.map((r): ListRow => ({ title: oneLine(runLine(r)), secondary: "", meta: ago(new Date(r.at).toISOString()) })));
        return;
      }
      if (items.length === 0) {
        emptyState(s, body!, c, { title: "Nothing yet." });
        return;
      }
      const rows: ListRow[] = items.map((i) => ({ title: oneLine(i.what), secondary: oneLine(i.actor ?? i.app), meta: ago(i.at) }));
      drawList(s, body!, c, state, rows);
    },
    key(e) {
      if (e.key === "esc" || e.key === "q") ctx.pop();
      else if (e.key === "h" && history.length > 0) showHistory = !showHistory;
      else if (e.key === "r" && mayRun()) void runAll();
      else state.key(e, showHistory ? history.length : items.length);
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
