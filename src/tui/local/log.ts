/**
 * History. The graph column comes from `graphLanes` in `git/local.ts` — lanes
 * we assign ourselves rather than `--graph` art we would have to unpick — so
 * it survives a narrow pane and takes the theme's colours like everything
 * else.
 *
 * `enter` opens the commit with its diff, in the forge's own `DiffView`: the
 * same widget the pull request screen uses, so a commit reads identically
 * whether you found it here or on the workbench.
 */

import * as git from "../../git/local.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding, type Binding } from "../app/keys.ts";
import { BOLD, style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { DiffView } from "../screens/commits.ts";
import { drawFacts, Filter, ListState, relTime } from "../screens/common.ts";
import { fill, len, split } from "../ui/layout.ts";
import type { Tokens } from "../ui/theme.ts";
import { emptyState } from "../ui/widgets.ts";
import {
  failureText,
  Task,
  type Local,
  type LocalRepo,
} from "./common.ts";
import { cell, drawBusy, drawRows, type Cell, type Column } from "./rows.ts";

export function logScreen(local: Local, ctx: Ctx, repo: LocalRepo): Screen {
  const list = new ListState();
  const filter = new Filter();
  const task = new Task(ctx);
  let commits: git.LocalCommit[] = [];

  const shown = (): git.LocalCommit[] =>
    commits.filter(
      (c) => filter.matches(c.subject) || filter.matches(c.author),
    );
  const current = (): git.LocalCommit | undefined => shown()[list.index];

  const reload = async (): Promise<void> => {
    const result = await git.log(repo.dir, { limit: 400 });
    if (!result.ok) ctx.toast(failureText(result.error), "danger");
    commits = result.ok ? result.value : [];
    list.clamp(shown().length);
    ctx.invalidate();
  };

  return {
    title: "Log",
    get keys(): Binding[] {
      const has = current() !== undefined;
      return [
        binding(["enter"], "open", { disabled: !has }),
        binding(["c"], "cherry-pick", { disabled: !has }),
        binding(["v"], "revert", { disabled: !has }),
        binding(["y"], "copy sha", { disabled: !has }),
        binding(["/"], "filter"),
        binding(["j", "k"], "move"),
      ];
    },
    async load() {
      await reload();
    },
    render(area, s) {
      const c = ctx.theme.c;
      const [box, body, busy] = split(area, "v", [
        len(filter.on ? 1 : 0),
        fill(1),
        len(task.busy ? 1 : 0),
      ]);
      if (filter.on)
        ctx.setCursor(filter.render(s, box!, c, "subject or author"));
      if (task.busy) drawBusy(s, busy!, c, task.note, ctx.tick);
      const items = shown();
      if (items.length === 0) {
        emptyState(s, body!, c, {
          title: "No commits",
          body: "Nothing has been committed here yet.",
        });
        return;
      }
      const width = graphWidth(items);
      drawRows(
        s,
        body!,
        c,
        list,
        COLUMNS,
        items.map((commit) => rowFor(c, commit, width)),
      );
    },
    key(e) {
      if (task.blocked) return true;
      if (filter.key(e)) {
        list.clamp(shown().length);
        return true;
      }
      if (list.key(e, shown().length)) return true;
      const commit = current();
      if (commit === undefined) return false;

      if (e.key === "enter") {
        ctx.push(commitDetailScreen(ctx, repo, commit));
        return true;
      }
      if (e.key === "y") {
        local.copy(commit.oid);
        ctx.toast(`copied ${commit.short}`, "success");
        return true;
      }
      if (e.key === "c") {
        task.run(
          "cherry-pick",
          () => git.cherryPick(repo.dir, commit.oid),
          () => ctx.toast(`picked ${commit.short}`, "success"),
        );
        return true;
      }
      if (e.key === "v") {
        task.run(
          "revert",
          () => git.revert(repo.dir, commit.oid),
          () => ctx.toast(`reverted ${commit.short}`, "success"),
        );
        return true;
      }
      return false;
    },
  };
}

/** One commit, with its diff. */
function commitDetailScreen(
  ctx: Ctx,
  repo: LocalRepo,
  commit: git.LocalCommit,
): Screen {
  const view = new DiffView();
  return {
    title: commit.short,
    get keys(): Binding[] {
      return [...view.keys, binding(["esc"], "back")];
    },
    async load() {
      const result = await git.commitDiff(repo.dir, commit.oid);
      if (result.ok) view.setFiles(result.value.files);
      else ctx.toast(failureText(result.error), "danger");
      ctx.invalidate();
    },
    render(area, s) {
      const c = ctx.theme.c;
      const [head, body] = split(area, "v", [len(5), fill(1)]);
      s.text(
        head!.x,
        head!.y,
        truncate(commit.subject, head!.w),
        style(c.fg, c.bg, BOLD),
        head!.x + head!.w,
      );
      drawFacts(s, { ...head!, y: head!.y + 1, h: 4 }, c, [
        ["commit", commit.oid],
        ["author", `${commit.author} <${commit.email}>`],
        ["when", `${relTime(commit.date)} ago`],
        ["changes", view.summary()],
      ]);
      view.render(s, body!, c);
    },
    key(e) {
      return view.key(e, ctx);
    },
  };
}

function graphWidth(commits: readonly git.LocalCommit[]): number {
  let max = 0;
  for (const commit of commits) max = Math.max(max, commit.graph.length);
  // Cap it: a repo with twenty concurrent lanes must not push the subject
  // off the screen — the subject is what people are reading for.
  return Math.min(max, 10);
}

/** lane . subject . sha . author . age. */
const COLUMNS: readonly Column[] = [
  { gap: 0 },
  { grow: true, min: 16, emphasis: true },
  {},
  { align: "right", drop: 2 },
  { align: "right", drop: 1 },
];

function rowFor(c: Tokens, commit: git.LocalCommit, width: number): Cell[] {
  const graph = commit.graph.slice(0, width).padEnd(width, " ");
  const head = commit.refs.includes("HEAD");
  return [
    // The lane is the one cell that holds more than one colour: the commit is
    // the reader's place in the graph and the lanes around it are scenery, so
    // the two cannot share a tone.
    {
      text: graph,
      spans: [...graph].map((glyph) => ({
        text: glyph,
        fg: glyph === "\u25cf" ? (head ? c.success : c.accent) : c.border,
      })),
    },
    cell(commit.subject, c.fg),
    cell(commit.short, c.mutedFg),
    cell(commit.author, c.mutedFg),
    cell(relTime(commit.date), c.faint),
  ];
}
