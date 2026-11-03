/**
 * The sources a repository follows (#9003) in the terminal, a repository
 * admin's: the list Settings → Followed sources has, with the same doors —
 * `a` adds sources (one per line in the web's box; here one at a time,
 * `<url> [branch] [as account]`), `x` stops following the one under the
 * cursor, `u` checks them all now. Each goes through
 * `actions/follow_sources.ts`, so it is the same gate, the same audit and
 * the same event as the page's, and an open settings page updates as this
 * one writes. Anyone who is not an admin of the repository is shown nothing.
 */

import {
  addFollowSources,
  checkSourcesNow,
  removeFollowSource,
  SOURCE_REFUSALS,
  sourceStanding,
} from "../../actions/follow_sources.ts";
import { upstreamShort } from "../../actions/upstream_follow.ts";
import { listSources, stampOf, type FollowSource } from "../../core/follow_sources.ts";
import { canAdmin, getRepoById, type Repo } from "../../core/repos.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, confirmScreen, drawList, live, promptScreen, runAsync, type ListRow } from "./common.ts";

export function sourcesScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  const state = new ListState();
  // The row as it is now: the gate is read at use, never remembered.
  const may = (): boolean => f.user !== undefined && canAdmin(f.db, getRepoById(f.db, repo.id) ?? repo, f.user);
  const sources = (): FollowSource[] => (may() ? listSources(f.db, repo.id) : []);

  const rows = (): ListRow[] =>
    sources().map((s) => {
      const stamp = stampOf(s);
      return {
        title: `${upstreamShort(s.url)}  ${s.branch}`,
        meta: `${stamp === undefined ? "" : `${stamp.account}@${stamp.host} · `}${sourceStanding(s)}`,
      };
    });

  const screen: Screen = {
    title: "Followed sources",
    keys: [binding(["j", "k"], "move cursor"), binding(["a"], "follow"), binding(["x"], "stop following"), binding(["u"], "check now"), binding(["esc"], "close")],
    load(signal) {
      live(f, signal, { repoId: repo.id, kinds: ["repo.source_added", "repo.source_removed", "repo.upstream_checked"] }, () => ctx.invalidate());
      return Promise.resolve();
    },
    render(area, s) {
      const c = ctx.theme.c;
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      const text = may()
        ? "A trusted account's commits fold in as one pull; anyone else's wait as a guest."
        : "Only an admin of this repository changes what it follows.";
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, body!, c, state, rows());
    },
    key(e) {
      if (!may() || e.ctrl || e.alt) return false;
      if (state.key(e, sources().length)) return true;
      const user = f.user;
      const at = sources()[state.index];
      if (e.key === "a") {
        ctx.push(
          promptScreen(ctx, screen, {
            title: "Follow a source",
            label: "address [branch] [as account], e.g. https://git.open-platform.sh/jmoran/forge.git main",
            hint: "address, branch, trusted account",
            onSubmit: (raw) => {
              const done = addFollowSources(f.app, user, repo, raw.split("\n")[0] ?? "");
              if (!done.ok) return SOURCE_REFUSALS.not_found;
              const one = done.value[0]?.result;
              if (one === undefined || !one.ok) return SOURCE_REFUSALS[one?.error ?? "invalid_url"];
              ctx.toast(`following ${upstreamShort(one.value.url)} ${one.value.branch}`, "success");
              ctx.invalidate();
              return undefined;
            },
          }),
        );
        return true;
      }
      if (e.key === "u") {
        ctx.toast("checking the sources…", "default");
        runAsync(ctx, async () => {
          const done = await checkSourcesNow(f.app, user, repo);
          ctx.toast(done.ok ? `checked ${done.value.length} source${done.value.length === 1 ? "" : "s"}` : SOURCE_REFUSALS.not_found, done.ok ? "success" : "danger");
          ctx.invalidate();
        });
        return true;
      }
      if (at === undefined) return false;
      if (e.key === "x") {
        ctx.push(
          confirmScreen(ctx, screen, {
            title: "Stop following",
            body: [`${upstreamShort(at.url)} ${at.branch} will no longer be checked.`],
            actions: [{ label: "Keep", variant: "ghost" }, { label: "Stop following", variant: "default" }],
            onChoose: (i) => {
              if (i !== 1) return;
              const gone = removeFollowSource(f.app, user, repo, at.id);
              ctx.toast(gone.ok ? "no longer following it" : SOURCE_REFUSALS.not_found, gone.ok ? "success" : "danger");
              ctx.invalidate();
            },
          }),
        );
        return true;
      }
      return false;
    },
  };
  return screen;
}
