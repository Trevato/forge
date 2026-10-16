/**
 * A repository's waves: the same rows, in the same order, as the web page,
 * read through `story/waves.ts`. Local repositories only — a live browse of
 * another forge has no `waves/` we can read here, and says so.
 */

import { canRead } from "../../core/repos.ts";
import { readWaves, type WaveEntry } from "../../story/waves.ts";
import type { RepoSource } from "../../view/source.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { emptyState } from "../ui/widgets.ts";
import type { Session } from "../session.ts";
import { ListState, drawList, plural, runAsync } from "./common.ts";
import { localRepo, sourceName, whereRows, whereStrip } from "./where.ts";

/** One line per wave, as the screen draws it. */
export function waveRows(entries: WaveEntry[]) {
  return entries.map((e) =>
    e.ok
      ? {
          title: e.wave.headline,
          secondary: "",
          meta: `${e.wave.version}  ${e.wave.date}`,
        }
      : { title: e.file, secondary: `Not a wave: ${e.reason}`, meta: "" },
  );
}

export function wavesScreen(f: Session, ctx: Ctx, src: RepoSource): Screen {
  const repo = localRepo(src);
  let entries: WaveEntry[] = [];
  let loaded = false;
  const state = new ListState();

  const reload = async (): Promise<void> => {
    // The web's gate, not a weaker one: whoever reaches this screen, a
    // repository they cannot read has no waves to show.
    entries =
      repo !== undefined && canRead(f.db, repo, f.user)
        ? await readWaves(f.dir(repo), repo.defaultBranch)
        : [];
    loaded = true;
    ctx.invalidate();
  };

  return {
    title: "Waves",
    keys: [binding(["j", "k"], "move"), binding(["r"], "refresh")],
    load: reload,
    render(area, s) {
      const c = ctx.theme.c;
      const [strip, head, body] = split(area, "v", [
        len(whereRows(src)),
        len(1),
        fill(1),
      ]);
      whereStrip(s, strip!, c, f, src);
      s.text(
        head!.x,
        head!.y,
        truncate(
          `${sourceName(src)} · ${plural(entries.length, "wave")}`,
          head!.w,
        ),
        style(c.mutedFg, c.bg),
        head!.x + head!.w,
      );
      if (entries.length === 0) {
        emptyState(s, body!, c, {
          title: loaded ? "No waves yet" : "Reading…",
          body: loaded ? "This repository has no waves/ directory." : "",
        });
        return;
      }
      drawList(s, body!, c, state, waveRows(entries));
    },
    key(e) {
      if (state.key(e, entries.length)) return true;
      if (e.key === "r") {
        runAsync(ctx, reload);
        return true;
      }
      return false;
    },
  };
}
