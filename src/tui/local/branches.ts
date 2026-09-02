/**
 * The branch list. Six verbs, and the two that can lose work (delete, force
 * delete) both go through a confirm — the difference between them is stated
 * in the dialog rather than assumed from the capital letter.
 *
 * A rebase or merge that conflicts does not open a screen of its own: it
 * leaves the repo mid-operation, and the work screen already knows how to
 * show that, with `continue` and `abort` live. One place shows conflicts.
 */

import * as git from "../../git/local.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding, type Binding } from "../app/keys.ts";
import { G } from "../term/screen.ts";
import {
  confirmScreen,
  drawList,
  Filter,
  ListState,
  promptScreen,
  relTime,
  type ListRow,
} from "../screens/common.ts";
import { fill, len, split } from "../ui/layout.ts";
import { emptyState } from "../ui/widgets.ts";
import { Task, trackText, type LocalRepo } from "./common.ts";

export function branchesScreen(ctx: Ctx, repo: LocalRepo): Screen {
  const list = new ListState();
  const filter = new Filter();
  const task = new Task(ctx);
  let branches: git.LocalBranch[] = [];

  const shown = (): git.LocalBranch[] =>
    branches.filter((b) => filter.matches(b.name));
  const current = (): git.LocalBranch | undefined => shown()[list.index];

  const reload = async (): Promise<void> => {
    const result = await git.branches(repo.dir);
    branches = result.ok ? result.value : [];
    list.clamp(shown().length);
    ctx.invalidate();
  };

  const screen: Screen = {
    title: "Branches",
    get keys(): Binding[] {
      const branch = current();
      const other = branch !== undefined && !branch.current;
      return [
        binding(["enter"], "checkout", { disabled: !other }),
        binding(["n"], "new from here"),
        binding(["d"], "delete", { disabled: !other }),
        binding(["D"], "force delete", { disabled: !other }),
        binding(["r"], "rename", { disabled: branch === undefined }),
        binding(["R"], "rebase onto", { disabled: !other }),
        binding(["m"], "merge into current", { disabled: !other }),
        binding(["/"], "filter"),
      ];
    },
    async load() {
      await reload();
    },
    render(area, s) {
      const c = ctx.theme.c;
      const [box, body] = split(area, "v", [len(filter.on ? 1 : 0), fill(1)]);
      if (filter.on) ctx.setCursor(filter.render(s, box!, c, "filter"));
      const items = shown();
      if (items.length === 0) {
        emptyState(s, body!, c, {
          title: "No branches",
          body: "This repo has no local branches yet.",
        });
        return;
      }
      drawList(s, body!, c, list, items.map(rowFor));
    },
    key(e) {
      if (task.blocked) return true;
      if (filter.key(e)) {
        list.clamp(shown().length);
        return true;
      }
      const items = shown();
      if (list.key(e, items.length)) return true;
      const branch = current();

      if (e.key === "enter" && branch && !branch.current) {
        task.run("checkout", () => git.checkout(repo.dir, branch.name), reload);
        return true;
      }
      if (e.key === "n") {
        ctx.push(
          promptScreen(ctx, screen, {
            title: "New branch",
            label: `Branch off ${branch?.name ?? "HEAD"}`,
            placeholder: "feature/name",
            onSubmit: (value) => {
              if (value === "") return "a name is required";
              task.run(
                "branch",
                () => git.createBranch(repo.dir, value, branch?.name),
                reload,
              );
              return undefined;
            },
          }),
        );
        return true;
      }
      if ((e.key === "d" || e.key === "D") && branch && !branch.current) {
        const force = e.key === "D";
        ctx.push(
          confirmScreen(ctx, screen, {
            title: force ? "Force delete branch" : "Delete branch",
            body: force
              ? [
                  `Delete ${branch.name} even if it is not merged.`,
                  "",
                  "Commits only on this branch become unreachable.",
                ]
              : [
                  `Delete ${branch.name}?`,
                  "",
                  "git will refuse if it holds unmerged commits.",
                ],
            actions: [
              { label: "Cancel", variant: "ghost" },
              { label: "Delete", variant: force ? "danger" : "default" },
            ],
            onChoose: (choice) => {
              if (choice === 1)
                task.run(
                  "delete",
                  () => git.deleteBranch(repo.dir, branch.name, force),
                  reload,
                );
            },
          }),
        );
        return true;
      }
      if (e.key === "r" && branch) {
        ctx.push(
          promptScreen(ctx, screen, {
            title: "Rename branch",
            label: `New name for ${branch.name}`,
            value: branch.name,
            onSubmit: (value) => {
              if (value === "") return "a name is required";
              task.run(
                "rename",
                () => git.renameBranch(repo.dir, branch.name, value),
                reload,
              );
              return undefined;
            },
          }),
        );
        return true;
      }
      if (e.key === "R" && branch && !branch.current) {
        ctx.push(
          confirmScreen(ctx, screen, {
            title: "Rebase",
            body: [
              `Replay the current branch onto ${branch.name}.`,
              "",
              "A conflict pauses the rebase; finish or abort it from the",
              "working tree screen.",
            ],
            actions: [
              { label: "Cancel", variant: "ghost" },
              { label: "Rebase" },
            ],
            onChoose: (choice) => {
              if (choice === 1)
                task.run(
                  "rebase",
                  () => git.rebase(repo.dir, branch.name),
                  () => {
                    ctx.pop();
                  },
                );
            },
          }),
        );
        return true;
      }
      if (e.key === "m" && branch && !branch.current) {
        task.run(
          "merge",
          () => git.mergeBranch(repo.dir, branch.name),
          () => {
            ctx.pop();
          },
        );
        return true;
      }
      return false;
    },
  };
  return screen;
}

function rowFor(branch: git.LocalBranch): ListRow {
  const track = trackText(branch.ahead, branch.behind);
  const upstream = branch.gone
    ? "upstream gone"
    : (branch.upstream ?? "no upstream");
  return {
    title: `${branch.current ? `${G.dot} ` : "  "}${branch.name}`,
    secondary: upstream,
    meta: [track, relTime(branch.date)].filter((p) => p !== "").join("  "),
    ...(branch.gone ? { state: "closed" as const } : {}),
  };
}
