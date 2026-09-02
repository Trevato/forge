/**
 * The first thing a session shows: your repositories, what has happened in
 * them, and — for a guest — the way in.
 *
 * A guest is not a degraded user. They get the same list, filtered to what is
 * public by exactly the helpers the web and the API use, plus one extra row
 * telling them how to become someone.
 */

import { getIssue } from "../../core/issues.ts";
import { listOrgsForUser } from "../../core/orgs.ts";
import { listEvents, type ForgeEvent } from "../../core/events.ts";
import { listReposVisibleTo, type Repo } from "../../core/repos.ts";
import { getUserById } from "../../core/users.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Rect } from "../term/screen.ts";
import { style } from "../term/style.ts";
import type { Tokens } from "../ui/theme.ts";
import { pad, truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { card, emptyState } from "../ui/widgets.ts";
import type { Session } from "../session.ts";
import {
  Filter,
  ListState,
  drawList,
  relTime,
  runAsync,
  type ListRow,
} from "./common.ts";
import { describeEvent, type FeedLine } from "./activity.ts";
import { accountScreen } from "./account.ts";
import { exploreScreen } from "./explore.ts";
import { newRepoScreen } from "./newrepo.ts";
import { ownerScreen } from "./owner.ts";
import { repoScreen } from "./repo.ts";
import { signInScreen } from "./signin.ts";

export function dashboardScreen(f: Session, ctx: Ctx): Screen {
  let repos: Repo[] = [];
  let feed: FeedItem[] = [];
  let orgs: string[] = [];
  const state = new ListState();
  const filter = new Filter();

  const reload = (): void => {
    const all = listReposVisibleTo(f.db, f.user, { limit: 200 });
    // "Yours" is ownership plus the orgs you are on a team of; everything
    // else lives in Explore, one key away.
    orgs = f.user
      ? listOrgsForUser(f.db, f.user.id).map((o) => o.username)
      : [];
    repos = f.user
      ? all.filter(
          (repo) =>
            repo.ownerId === f.user?.id || orgs.includes(repo.ownerName),
        )
      : all;
    const visible = listEvents(f.db, { limit: 60 }).filter(
      (event) =>
        event.repoId === null || all.some((repo) => repo.id === event.repoId),
    );
    feed = visible.flatMap((event) => item(f, event, all) ?? []);
    ctx.invalidate();
  };

  const shown = (): Repo[] =>
    repos.filter((repo) =>
      filter.matches(`${repo.ownerName}/${repo.name} ${repo.description}`),
    );

  return {
    title: f.user ? f.user.username : "Guest",
    get keys() {
      return [
        binding(["j", "k"], "move"),
        binding(["enter"], "open"),
        binding(["/"], "filter"),
        binding(["e"], "explore"),
        binding(["n"], "new repo", { disabled: !f.signedIn }),
        binding(["A"], "account", { disabled: !f.signedIn }),
        binding(["s"], "sign in", { disabled: f.signedIn }),
        binding(["r"], "refresh"),
      ];
    },
    load() {
      reload();
      return Promise.resolve();
    },
    render(area, s) {
      const c = ctx.theme.c;
      const [left, right] = ctx.twoPane
        ? split(area, "h", [fill(3), fill(2)])
        : [area, undefined];
      const [box, list] = split(left, "v", [len(1), fill(1)]);
      ctx.setCursor(filter.render(s, box!, c, "filter repositories"));
      const rows = shown();
      if (rows.length === 0)
        emptyState(s, list!, c, {
          title: f.signedIn ? "No repositories yet" : "Nothing public yet",
          body: f.signedIn
            ? "Press n to create one, or e to explore."
            : "Press s to sign in, or e to explore.",
        });
      else
        drawList(
          s,
          list!,
          c,
          state,
          rows.map(
            (repo): ListRow => ({
              title: `${repo.ownerName}/${repo.name}`,
              secondary: repo.description,
              meta: repo.visibility === "private" ? "private" : "",
            }),
          ),
        );
      if (right === undefined) return;

      const [activity, side] = split(right, "v", [fill(2), len(6)]);
      const inner = card(s, activity!, c, { title: "Recent activity" });
      if (feed.length === 0)
        s.text(
          inner.x,
          inner.y,
          "Nothing has happened yet.",
          style(c.faint, c.card),
          inner.x + inner.w,
        );
      else drawFeed(s, inner, c, feed);
      const sideInner = card(s, side!, c, {
        title: f.signedIn ? "Organizations" : "Sign in",
      });
      const notes = f.signedIn
        ? orgs.length > 0
          ? orgs
          : ["You are not in any organization."]
        : [
            "s   sign in with a username and password",
            "    (your key is linked, so next time is instant)",
          ];
      notes
        .slice(0, sideInner.h)
        .forEach((line, i) =>
          s.text(
            sideInner.x,
            sideInner.y + i,
            truncate(line, sideInner.w),
            style(c.mutedFg, c.card),
            sideInner.x + sideInner.w,
          ),
        );
    },
    key(e) {
      if (filter.key(e)) {
        state.clamp(shown().length);
        return true;
      }
      if (state.key(e, shown().length)) return true;
      if (e.key === "enter") {
        const repo = shown()[state.index];
        if (repo) ctx.push(repoScreen(f, ctx, repo));
        return true;
      }
      if (e.key === "e") {
        ctx.push(exploreScreen(f, ctx));
        return true;
      }
      if (e.key === "n" && f.signedIn) {
        ctx.push(newRepoScreen(f, ctx));
        return true;
      }
      if (e.key === "A" && f.user) {
        ctx.push(accountScreen(f, ctx));
        return true;
      }
      if (e.key === "o" && f.user) {
        ctx.push(ownerScreen(f, ctx, f.user.username));
        return true;
      }
      if (e.key === "s" && !f.signedIn) {
        ctx.push(signInScreen(f, ctx, reload));
        return true;
      }
      if (e.key === "r") {
        runAsync(ctx, async () => reload());
        return true;
      }
      return false;
    },
  };
}

interface FeedItem extends FeedLine {
  /** Relative, and short enough to right-align in its own column. */
  readonly when: string;
}

/** Time gets a fixed column so the stamps line up as a rule down the edge. */
const WHEN = 4;
/** Below this the second line has nothing left to say after truncation. */
const TWO_LINE = 40;

/**
 * Resolve everything `describeEvent` needs — the actor, the repo, and the
 * title of whatever the event numbered — and hand it the finished nouns.
 */
function item(
  f: Session,
  event: ForgeEvent,
  repos: readonly Repo[],
): FeedItem | null {
  const actor =
    event.actorId === null
      ? "someone"
      : (getUserById(f.db, event.actorId)?.username ?? "someone");
  const repo = repos.find((r) => r.id === event.repoId);
  const number = event.payload["number"];
  const title =
    repo !== undefined && typeof number === "number"
      ? getIssue(f.db, repo.id, number)?.title
      : undefined;
  const line = describeEvent(event, {
    actor,
    ...(repo === undefined ? {} : { repo: `${repo.ownerName}/${repo.name}` }),
    ...(title === undefined ? {} : { title }),
  });
  return line === null ? null : { ...line, when: relTime(event.createdAt) };
}

/**
 * Two rows an item when there is room for the object of the sentence, one
 * truncated row when there is not. Either way the time is a right-hand
 * column, never a prefix that pushes the words around.
 */
function drawFeed(
  s: Parameters<typeof card>[0],
  r: Rect,
  c: Tokens,
  items: readonly FeedItem[],
): void {
  const right = r.x + r.w;
  const wide = r.w >= TWO_LINE;
  let y = r.y;
  for (const entry of items) {
    if (y >= r.y + r.h) return;
    if (!wide) {
      const tail = entry.subject === "" ? "" : ` · ${entry.subject}`;
      s.text(
        r.x,
        y,
        pad(entry.when, WHEN, "right"),
        style(c.faint, c.card),
        right,
      );
      s.text(
        r.x + WHEN + 1,
        y,
        truncate(`${entry.headline}${tail}`, Math.max(0, r.w - WHEN - 1)),
        style(c.mutedFg, c.card),
        right,
      );
      y += 1;
      continue;
    }
    s.text(
      r.x,
      y,
      truncate(entry.headline, Math.max(0, r.w - WHEN - 1)),
      style(c.fg, c.card),
      right,
    );
    s.text(
      right - WHEN,
      y,
      pad(entry.when, WHEN, "right"),
      style(c.faint, c.card),
      right,
    );
    y += 1;
    if (entry.detail !== "" && y < r.y + r.h) {
      s.text(
        r.x + 2,
        y,
        truncate(entry.detail, Math.max(0, r.w - 2)),
        style(c.faint, c.card),
        right,
      );
      y += 1;
    }
  }
}
