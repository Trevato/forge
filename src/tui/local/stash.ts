/**
 * The stash. A short list with a diff beside it, because the one question a
 * stash raises — "what is in this?" — should not require applying it to find
 * out. `enter` applies and keeps the entry; `p` pops; `d` drops after a
 * confirm, since a dropped stash is the one thing here git cannot give back.
 */

import * as git from "../../git/local.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding, type Binding } from "../app/keys.ts";
import { G } from "../term/screen.ts";
import { style } from "../term/style.ts";
import {
  confirmScreen,
  drawList,
  ListState,
  relTime,
  type ListRow,
} from "../screens/common.ts";
import { fill, split } from "../ui/layout.ts";
import { emptyState } from "../ui/widgets.ts";
import { HunkList } from "./hunks.ts";
import { Task, track, type LocalRepo } from "./common.ts";

export function stashScreen(ctx: Ctx, repo: LocalRepo): Screen {
  const list = new ListState();
  const preview = new HunkList();
  const task = new Task(ctx);
  let stashes: git.Stash[] = [];
  let previewIndex = -1;

  preview.highlight = false;

  const current = (): git.Stash | undefined => stashes[list.index];

  const reload = async (): Promise<void> => {
    const result = await git.stashList(repo.dir);
    stashes = result.ok ? result.value : [];
    list.clamp(stashes.length);
    previewIndex = -1;
    await loadPreview();
    ctx.invalidate();
  };

  const loadPreview = async (): Promise<void> => {
    const stash = current();
    if (stash === undefined) {
      preview.setFile(null);
      return;
    }
    if (stash.index === previewIndex) return;
    previewIndex = stash.index;
    const result = await git.stashDiff(repo.dir, stash.index);
    if (previewIndex !== stash.index) return;
    preview.setFile(result.ok ? (result.value.files[0] ?? null) : null);
    ctx.invalidate();
  };

  const screen: Screen = {
    title: "Stashes",
    get keys(): Binding[] {
      const has = current() !== undefined;
      return [
        binding(["enter"], "apply", { disabled: !has }),
        binding(["p"], "pop", { disabled: !has }),
        binding(["d"], "drop", { disabled: !has }),
        binding(["esc"], "back"),
      ];
    },
    async load() {
      await reload();
    },
    render(area, s) {
      const c = ctx.theme.c;
      if (stashes.length === 0) {
        emptyState(s, area, c, {
          title: "No stashes",
          body: "`S` on the working tree screen puts one here.",
        });
        return;
      }
      if (!ctx.twoPane) {
        drawList(s, area, c, list, stashes.map(rowFor));
        return;
      }
      const [left, right] = split(area, "h", [fill(2), fill(3)]);
      drawList(s, left!, c, list, stashes.map(rowFor));
      for (let y = right!.y; y < right!.y + right!.h; y++)
        s.set(right!.x, y, G.v, style(c.border, c.bg));
      preview.render(
        s,
        { x: right!.x + 2, y: right!.y, w: right!.w - 2, h: right!.h },
        c,
      );
    },
    key(e) {
      if (task.blocked) return true;
      if (list.key(e, stashes.length)) {
        void track(loadPreview());
        return true;
      }
      const stash = current();
      if (stash === undefined) return false;

      if (e.key === "enter") {
        task.run("apply", () => git.stashApply(repo.dir, stash.index), reload);
        return true;
      }
      if (e.key === "p") {
        task.run("pop", () => git.stashPop(repo.dir, stash.index), reload);
        return true;
      }
      if (e.key === "d") {
        ctx.push(
          confirmScreen(ctx, screen, {
            title: "Drop stash",
            body: [stash.subject, "", "A dropped stash cannot be recovered."],
            actions: [
              { label: "Cancel", variant: "ghost" },
              { label: "Drop", variant: "danger" },
            ],
            onChoose: (choice) => {
              if (choice === 1)
                task.run(
                  "drop",
                  () => git.stashDrop(repo.dir, stash.index),
                  reload,
                );
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

function rowFor(stash: git.Stash): ListRow {
  return {
    title: stash.subject,
    secondary: stash.ref,
    meta: relTime(stash.date),
  };
}
