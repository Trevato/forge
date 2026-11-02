/**
 * The working tree: what has changed, what is staged, and the eight verbs
 * that move a change from one to the other and then out to the workbench.
 *
 * Four sections, in the order you act on them — conflicted first because
 * nothing else can proceed until they are gone, then staged, changed and
 * new. A path that is half-staged appears in two sections, which is honest:
 * `space` on the staged row unstages, on the changed row stages, and there
 * is never a question about which half you just moved.
 */

import * as git from "../../git/local.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding, type Binding } from "../app/keys.ts";
import type { KeyEvent } from "../term/input.ts";
import { G, type Rect, type Screen as Surface } from "../term/screen.ts";
import { BOLD, DIM, style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { confirmScreen, errorText, ListState } from "../screens/common.ts";
import { beside, fill, len, split } from "../ui/layout.ts";
import type { Tokens } from "../ui/theme.ts";
import { emptyState, scrollbar, spinner } from "../ui/widgets.ts";
import { branchesScreen } from "./branches.ts";
import { commitScreen } from "./commit.ts";
import {
  failureText,
  SEP,
  syncText,
  Task,
  track,
  type Local,
  type LocalRepo,
} from "./common.ts";
import { HunkList, hunkScreen, sectionLabel, type Section } from "./hunks.ts";
import { logScreen } from "./log.ts";
import { dividedAside } from "./rows.ts";
import { stashScreen } from "./stash.ts";

interface Item {
  readonly header: string | null;
  readonly entry: git.FileEntry | null;
  readonly section: Section;
}

export function workScreen(local: Local, ctx: Ctx, repo: LocalRepo): Screen {
  const list = new ListState();
  const preview = new HunkList();
  const task = new Task(ctx);
  let status: git.LocalStatus | null = null;
  let seq: git.Sequence = "none";
  let items: Item[] = [];
  let previewKey = "";

  preview.highlight = false;

  const rebuild = (): void => {
    const out: Item[] = [];
    const add = (section: Section, entries: git.FileEntry[]): void => {
      if (entries.length === 0) return;
      out.push({ header: sectionLabel(section), entry: null, section });
      for (const entry of entries) out.push({ header: null, entry, section });
    };
    if (status !== null) {
      add("conflicted", status.conflicted);
      add("staged", status.staged);
      add("unstaged", status.unstaged);
      add("untracked", status.untracked);
    }
    items = out;
    list.clamp(items.length);
    if (items[list.index]?.entry === null) step(1);
  };

  /** Section headers are not selectable; skip past them in the direction. */
  const step = (dir: 1 | -1): void => {
    for (let n = 0; n < items.length; n++) {
      const item = items[list.index];
      if (item === undefined || item.entry !== null) return;
      const next = list.index + dir;
      if (next < 0 || next >= items.length) {
        list.move(-dir, items.length);
        continue;
      }
      list.index = next;
    }
  };

  const selected = (): Item | undefined => {
    const item = items[list.index];
    return item?.entry === null ? undefined : item;
  };

  const reload = async (): Promise<void> => {
    const result = await git.status(repo.dir);
    status = result.ok ? result.value : null;
    if (!result.ok) ctx.toast(failureText(result.error), "danger");
    seq = await git.sequence(repo.dir);
    rebuild();
    await loadPreview();
    ctx.invalidate();
  };

  /** The preview follows the cursor, and only re-reads when it must. */
  const loadPreview = async (): Promise<void> => {
    const item = selected();
    if (item?.entry == null) {
      previewKey = "";
      preview.setFile(null);
      return;
    }
    const key = `${item.section}\0${item.entry.path}`;
    if (key === previewKey) return;
    previewKey = key;
    const result = await git.diff(repo.dir, {
      path: item.entry.path,
      ...(item.section === "staged" ? { staged: true } : {}),
      ...(item.section === "untracked" ? { untracked: true } : {}),
      ...(item.section === "conflicted" ? { conflicted: true } : {}),
    });
    if (previewKey !== key) return; // the cursor moved on while we read
    preview.setFile(result.ok ? (result.value.files[0] ?? null) : null);
    ctx.invalidate();
  };

  const toggle = (item: Item): void => {
    const entry = item.entry;
    if (entry === null) return;
    const label = item.section === "staged" ? "unstage" : "stage";
    task.run(
      label,
      () =>
        item.section === "staged"
          ? git.unstagePath(repo.dir, entry.path)
          : git.stagePath(repo.dir, entry.path),
      reload,
    );
  };

  const screen: Screen = {
    title: repo.name,
    get keys(): Binding[] {
      const item = selected();
      const staged = item?.section === "staged";
      return [
        binding(["space"], staged ? "unstage" : "stage", {
          disabled: item === undefined,
        }),
        binding(["a"], staged ? "unstage all" : "stage all"),
        binding(["enter"], "hunks", { disabled: item === undefined }),
        binding(["d"], "discard", { disabled: item === undefined }),
        binding(["c"], "commit"),
        binding(["A"], "amend"),
        binding(["P"], "push"),
        binding(["F"], "fetch"),
        binding(["L"], "pull"),
        binding(["S"], "stash"),
        binding(["b"], "branches"),
        binding(["l"], "log"),
        binding(["z"], "stashes"),
        binding(["j", "k"], "move"),
        // One line for the pair: they are the only two ways out of a paused
        // rebase, and the help card has to fit in 24 rows.
        ...(seq === "none"
          ? []
          : [binding(["C", "X"], `${seq} continue / abort`)]),
      ];
    },
    async load() {
      await reload();
    },
    render(area, s) {
      const c = ctx.theme.c;
      const [body, foot] = split(area, "v", [fill(1), len(1)]);
      drawFooter(s, foot!, c, status, seq, task, ctx.tick);
      if (status === null) {
        emptyState(s, body!, c, {
          title: "Not a repository",
          body: repo.dir,
        });
        return;
      }
      if (items.length === 0) {
        emptyState(s, body!, c, {
          title: "Nothing to commit",
          body: "The working tree is clean.",
          action: "l — history",
        });
        return;
      }
      const {
        main: left,
        aside: right,
        stacked,
      } = beside(body!, ctx.twoPane, {
        main: fill(2),
        aside: fill(3),
        below: fill(3),
      });
      drawFiles(s, left, c, list, items);
      if (right !== undefined)
        preview.render(s, dividedAside(s, right, c, stacked), c);
    },
    key(e) {
      if (task.blocked) return true;
      if (moved(e, list, items, step)) {
        void track(loadPreview());
        return true;
      }
      const item = selected();

      if (e.key === " " && item) {
        toggle(item);
        return true;
      }
      if (e.key === "a") {
        const staged = item?.section === "staged";
        task.run(
          staged ? "unstage all" : "stage all",
          () => (staged ? git.unstageAll(repo.dir) : git.stageAll(repo.dir)),
          reload,
        );
        return true;
      }
      if (e.key === "enter" && item?.entry) {
        ctx.push(
          hunkScreen(ctx, {
            dir: repo.dir,
            path: item.entry.path,
            origPath: item.entry.origPath,
            section: item.section,
            onChange: () => {
              previewKey = "";
              void reload();
            },
          }),
        );
        return true;
      }
      if (e.key === "d" && item?.entry) {
        const entry = item.entry;
        const untracked = item.section === "untracked";
        ctx.push(
          confirmScreen(ctx, screen, {
            title: "Discard changes",
            body: [
              untracked
                ? `Delete ${entry.path}?`
                : `Throw away changes to ${entry.path}?`,
              "",
              "This cannot be undone.",
            ],
            actions: [
              { label: "Cancel", variant: "ghost" },
              { label: "Discard", variant: "danger" },
            ],
            onChoose: (choice) => {
              if (choice !== 1) return;
              previewKey = "";
              task.run(
                "discard",
                () =>
                  git.discardPath(repo.dir, entry.path, {
                    ...(untracked ? { untracked: true } : {}),
                    ...(item.section === "unstaged"
                      ? { unstagedOnly: true }
                      : {}),
                  }),
                reload,
              );
            },
          }),
        );
        return true;
      }
      if (e.key === "c" || e.key === "A") {
        const amend = e.key === "A";
        if (!amend && status !== null && status.staged.length === 0) {
          ctx.toast("nothing staged", "attn");
          return true;
        }
        ctx.push(commitScreen(ctx, repo.dir, { amend, onDone: reload }));
        return true;
      }
      if (e.key === "F") {
        task.run(
          "fetch",
          (progress) => git.fetch(repo.dir, { onProgress: progress }),
          reload,
        );
        return true;
      }
      if (e.key === "L") {
        task.run(
          "pull",
          (progress) => git.pull(repo.dir, { onProgress: progress }),
          reload,
        );
        return true;
      }
      if (e.key === "P") {
        push(ctx, screen, repo.dir, status, task, reload);
        return true;
      }
      if (e.key === "S") {
        task.run(
          "stash",
          () => git.stashPush(repo.dir, undefined, { includeUntracked: true }),
          reload,
        );
        return true;
      }
      if (e.key === "b") {
        ctx.push(branchesScreen(ctx, repo));
        return true;
      }
      if (e.key === "l") {
        ctx.push(logScreen(local, ctx, repo));
        return true;
      }
      if (e.key === "z") {
        ctx.push(stashScreen(ctx, repo));
        return true;
      }
      if (e.key === "C" && seq !== "none") {
        task.run("continue", () => git.rebaseContinue(repo.dir), reload);
        return true;
      }
      if (e.key === "X" && seq !== "none") {
        task.run("abort", () => git.rebaseAbort(repo.dir), reload);
        return true;
      }
      return false;
    },
  };
  return screen;
}

/**
 * A push is the one action here that can be refused for a reason worth
 * reading: no upstream (offer to set one) or a non-fast-forward (offer the
 * lease). Neither is done silently, and `--force` proper is not on offer.
 */
function push(
  ctx: Ctx,
  parent: Screen,
  dir: string,
  status: git.LocalStatus | null,
  task: Task,
  reload: () => Promise<void>,
): void {
  if (status === null || status.head === null) {
    ctx.toast(errorText("unknown_branch"), "danger");
    return;
  }
  const branch = status.head;
  const setUpstream = status.upstream === null;
  const send = (lease: boolean): void =>
    task.run(
      "push",
      (progress) =>
        git.push(dir, {
          branch,
          onProgress: progress,
          ...(setUpstream ? { setUpstream: true } : {}),
          ...(lease ? { forceWithLease: true } : {}),
        }),
      reload,
    );

  if (status.behind === 0) {
    send(false);
    return;
  }
  ctx.push(
    confirmScreen(ctx, parent, {
      title: "Push",
      body: [
        `${branch} is ${status.behind} behind ${status.upstream ?? "its upstream"}.`,
        "",
        "A plain push will be refused. Force with lease overwrites the",
        "remote branch, but only if nobody pushed since your last fetch.",
      ],
      actions: [
        { label: "Cancel", variant: "ghost" },
        { label: "Push anyway" },
        { label: "Force with lease", variant: "danger" },
      ],
      onChoose: (choice) => {
        if (choice === 1) send(false);
        if (choice === 2) send(true);
      },
    }),
  );
}

/** Movement, with section headers skipped in whichever direction you went. */
function moved(
  e: KeyEvent,
  list: ListState,
  items: readonly Item[],
  step: (dir: 1 | -1) => void,
): boolean {
  const before = list.index;
  if (!list.key(e, items.length)) return false;
  step(list.index >= before ? 1 : -1);
  return true;
}

function drawFiles(
  s: Surface,
  r: Rect,
  c: Tokens,
  list: ListState,
  items: readonly Item[],
): void {
  const from = list.window(r.h, items.length);
  const width = Math.max(0, r.w - 1);
  for (let i = 0; i < r.h; i++) {
    const item = items[from + i];
    if (item === undefined) break;
    const y = r.y + i;
    if (item.header !== null) {
      s.text(
        r.x + 1,
        y,
        truncate(item.header.toUpperCase(), width - 1),
        style(c.mutedFg, c.bg, DIM),
        r.x + width,
      );
      continue;
    }
    const entry = item.entry!;
    const selected = from + i === list.index;
    const bg = selected ? c.muted : c.bg;
    s.fill({ x: r.x, y, w: width, h: 1 }, " ", style(c.fg, bg));
    let x = s.text(
      r.x,
      y,
      selected ? `${G.caretRight} ` : "  ",
      style(c.accent, bg),
      r.x + width,
    );
    const letter = statusLetter(entry, item.section);
    x = s.text(
      x,
      y,
      `${letter}  `,
      style(letterTone(c, letter), bg, BOLD),
      r.x + width,
    );
    const name =
      entry.origPath === null
        ? entry.path
        : `${entry.origPath} ${G.chevron} ${entry.path}`;
    s.text(
      x,
      y,
      truncate(name, Math.max(0, r.x + width - x)),
      style(c.fg, bg, selected ? BOLD : 0),
      r.x + width,
    );
  }
  scrollbar(s, { x: r.x + r.w - 1, y: r.y, w: 1, h: r.h }, c, {
    total: items.length,
    offset: from,
  });
}

/**
 * The one letter that says what happened to this file, on this side of the
 * index. git's own two-letter code carries both sides at once ("M." vs ".M"),
 * which is precise and unreadable — and redundant here, because the section
 * the row is under already says which side you are looking at.
 */
function statusLetter(entry: git.FileEntry, section: Section): string {
  if (section === "untracked") return "?";
  if (section === "conflicted") return "U";
  const side = section === "staged" ? entry.index : entry.work;
  return side === "." || side === "" ? "M" : side;
}

/** Coloured by what the letter means, not by the section it sits in. */
function letterTone(c: Tokens, letter: string): number {
  switch (letter) {
    case "A":
      return c.success;
    case "D":
      return c.danger;
    case "U":
      return c.danger;
    case "?":
      return c.attn;
    case "R":
    case "C":
      return c.merged;
    default:
      return c.accent;
  }
}

/** Branch, upstream and tracking — plus whatever git is in the middle of. */
function drawFooter(
  s: Surface,
  r: Rect,
  c: Tokens,
  status: git.LocalStatus | null,
  seq: git.Sequence,
  task: Task,
  tick: number,
): void {
  s.fill(r, " ", style(c.mutedFg, c.muted));
  const right = r.x + r.w;
  if (status === null) {
    if (task.busy) busy(s, r, c, task, tick);
    return;
  }
  let x = s.text(
    r.x + 1,
    r.y,
    status.head ?? "detached",
    style(c.fg, c.muted, BOLD),
    right,
  );
  const say = (text: string, fg: number): void => {
    x = s.text(x, r.y, ` ${SEP} `, style(c.faint, c.muted), right);
    x = s.text(x, r.y, text, style(fg, c.muted), right);
  };
  // Both counts, always, when there is an upstream to count against: "↑2 ↓0"
  // is a fact, and a missing "↓0" reads as a question.
  if (status.upstream === null) say("no upstream", c.attn);
  else {
    say(
      syncText(status.ahead, status.behind),
      status.behind > 0 ? c.attn : status.ahead > 0 ? c.accent : c.mutedFg,
    );
    say(status.upstream, c.mutedFg);
  }
  if (seq !== "none") say(`${seq} in progress`, c.attn);
  if (task.busy) busy(s, r, c, task, tick);
}

/** The progress line and its spinner, pinned to the right of a footer. */
function busy(s: Surface, r: Rect, c: Tokens, task: Task, tick: number): void {
  s.line(
    r,
    0,
    `${truncate(task.note, Math.max(0, r.w - 4))}  `,
    style(c.accent, c.muted),
    "right",
  );
  spinner(s, r.x + r.w - 2, r.y, c, tick);
}
