/**
 * The first thing a session shows: your repositories, what has happened in
 * them, and — for a guest — the way in.
 *
 * A guest is not a degraded user. They get the same list, filtered to what is
 * public by exactly the helpers the web and the API use, plus one extra row
 * telling them how to become someone.
 */

import { listOrgsForUser } from "../../core/orgs.ts";
import { listEvents, type ForgeEvent } from "../../core/events.ts";
import { listReposVisibleTo, type Repo } from "../../core/repos.ts";
import { getUserById } from "../../core/users.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
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
import { accountScreen } from "./account.ts";
import { exploreScreen } from "./explore.ts";
import { newRepoScreen } from "./newrepo.ts";
import { ownerScreen } from "./owner.ts";
import { repoScreen } from "./repo.ts";
import { signInScreen } from "./signin.ts";

export function dashboardScreen(f: Session, ctx: Ctx): Screen {
  let repos: Repo[] = [];
  let events: ForgeEvent[] = [];
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
    events = listEvents(f.db, { limit: 30 }).filter(
      (event) =>
        event.repoId === null || all.some((repo) => repo.id === event.repoId),
    );
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

      const [feed, side] = split(right, "v", [fill(2), len(6)]);
      const inner = card(s, feed!, c, { title: "Recent activity" });
      if (events.length === 0)
        s.text(
          inner.x,
          inner.y,
          "Nothing has happened yet.",
          style(c.faint, c.card),
          inner.x + inner.w,
        );
      events.slice(0, inner.h).forEach((event, i) => {
        s.text(
          inner.x,
          inner.y + i,
          truncate(describe(f, event), inner.w),
          style(c.mutedFg, c.card),
          inner.x + inner.w,
        );
      });
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

/** One event as one line — the feed is a list of sentences, not of JSON. */
function describe(f: Session, event: ForgeEvent): string {
  const actor =
    event.actorId === null
      ? "someone"
      : (getUserById(f.db, event.actorId)?.username ?? "someone");
  const number = event.payload["number"];
  const suffix = typeof number === "number" ? ` #${number}` : "";
  return `${relTime(event.createdAt).padEnd(4)} ${actor} ${event.kind}${suffix}`;
}
