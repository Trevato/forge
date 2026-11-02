/**
 * The front page in the terminal: the apps a signed-out visitor is shown, in
 * order, each with its score parts, as MCP `front_page` answers. A site admin
 * who is a person also pins and hides after a plan; `setFront` decides, and
 * a private app is never listed because `frontJson` never lists it.
 */

import { frontJson, type FrontRowJson, frontPicksJson, setFront } from "../../actions/front.ts";
import { canRead, getRepo } from "../../core/repos.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { fill, len, split } from "../ui/layout.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { ListState, confirmScreen, drawList, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

type Signals = FrontRowJson["signals"];

interface FrontRow {
  repo: string;
  mark: "featured" | "pinned" | "hidden" | "";
  score: number | undefined;
  signals: Signals | undefined;
}

const meta = (r: FrontRow): string =>
  r.signals === undefined || r.score === undefined
    ? "kept off the page"
    : `score ${r.score} · forks ${r.signals.forks} · ships ${r.signals.ships} · use ${Math.round(r.signals.awakeHours)}h · fresh ${r.signals.shippedAt?.slice(0, 10) ?? "never"}`;

export function frontScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let rows: FrontRow[] = [];
  let pinned: string[] = [];
  let hidden: string[] = [];
  let loaded = false;

  /** A site admin who is a person: the only one who changes the page. */
  const mayEdit = (): boolean => f.user?.isAdmin === true && f.user.kind !== "agent";

  const refresh = (): void => {
    // The list is the stranger's: no viewer, whoever is looking.
    const page = frontJson(f.app, undefined);
    const shown: FrontRow[] = [];
    if (page.featured !== null)
      shown.push({ repo: page.featured.repo, mark: "featured", score: page.featured.score, signals: page.featured.signals });
    for (const a of page.apps)
      shown.push({ repo: a.repo, mark: a.pinned ? "pinned" : "", score: a.score, signals: a.signals });
    if (mayEdit()) {
      const picks = frontPicksJson(f.app);
      pinned = [...picks.pinned];
      hidden = [...picks.hidden];
      for (const name of hidden) {
        const [owner, repoName] = name.split("/");
        const repo = owner && repoName ? getRepo(f.app.db, owner, repoName) : undefined;
        // A private app is not listed for anyone, hidden or not.
        if (repo !== undefined && canRead(f.app.db, repo, undefined))
          shown.push({ repo: name, mark: "hidden", score: undefined, signals: undefined });
      }
    }
    rows = shown;
    loaded = true;
    state.clamp(rows.length);
    ctx.invalidate();
  };

  const plan = (repo: string, action: "pin" | "hide"): { pinned: string[]; hidden: string[]; line: string } => {
    const isPinned = pinned.includes(repo);
    const isHidden = hidden.includes(repo);
    if (action === "pin")
      return isPinned
        ? { pinned: pinned.filter((p) => p !== repo), hidden, line: `Unpin ${repo}: it ranks by score again.` }
        : { pinned: [repo, ...pinned], hidden: hidden.filter((h) => h !== repo), line: `Pin ${repo} first: it is featured.` };
    return isHidden
      ? { pinned, hidden: hidden.filter((h) => h !== repo), line: `Show ${repo}: strangers may see it again.` }
      : { pinned: pinned.filter((p) => p !== repo), hidden: [...hidden, repo], line: `Hide ${repo}: strangers no longer see it.` };
  };

  const ask = (action: "pin" | "hide"): void => {
    if (!mayEdit()) return;
    const row = rows[state.index];
    if (row === undefined) return;
    const next = plan(row.repo, action);
    // The plan is the action's own dry run, so it says what would be refused.
    const dry = setFront(f.app, f.user, { pinned: next.pinned, hidden: next.hidden }, true);
    if (!dry.ok) {
      ctx.toast(dry.error.kind === "forbidden" ? "Only a site admin sets the front page." : dry.error.message, "danger");
      return;
    }
    ctx.push(
      confirmScreen(ctx, screen, {
        title: action === "pin" ? "Pin" : "Hide",
        body: [
          next.line,
          `Pinned: ${dry.value.pinned.join(", ") || "none"}`,
          `Hidden: ${dry.value.hidden.join(", ") || "none"}`,
        ],
        actions: [{ label: "Apply" }, { label: "Cancel" }],
        selected: 1,
        onChoose: (choice) => {
          if (choice !== 0) return;
          const done = setFront(f.app, f.user, { pinned: next.pinned, hidden: next.hidden });
          ctx.toast(done.ok ? next.line : done.error.kind === "forbidden" ? "Only a site admin sets the front page." : done.error.message, done.ok ? undefined : "danger");
          refresh();
        },
      }),
    );
  };

  const screen: Screen = {
    title: "Front page",
    get keys() {
      return [
        binding(["j", "k"], "move cursor"),
        ...(mayEdit() ? [binding(["p"], "pin or unpin"), binding(["h"], "hide or show")] : []),
      ];
    },
    load() {
      refresh();
      return Promise.resolve();
    },
    render(area, s) {
      const c = ctx.theme.c;
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      const note = !loaded ? "Loading…" : rows.length === 0 ? "No app is on the front page." : "What a signed-out visitor sees, in order";
      s.text(head!.x, head!.y, truncate(note, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      const lines: ListRow[] = rows.map((r) => ({
        title: r.repo,
        secondary: r.mark,
        meta: meta(r),
      }));
      drawList(s, list!, c, state, lines);
    },
    key(e) {
      if (e.key === "p" && mayEdit()) {
        ask("pin");
        return true;
      }
      if (e.key === "h" && mayEdit()) {
        ask("hide");
        return true;
      }
      return state.key(e, rows.length);
    },
  };
  return screen;
}

/** The stranger's front page, ranked with its numbers, as MCP `front_page` has it. */
export const entry: PaletteEntry = {
  id: "front",
  title: "Front page",
  hint: "the apps a first visitor sees, ranked; an admin pins or hides",
  offered: () => true,
  run: (session, ctx) => ctx.push(frontScreen(session, ctx)),
};
