/**
 * An app's chapters, in the terminal (#11603): the page's list (`web/pages/chapters.ts`) from the same
 * acts (`actions/chapters.ts`), so the same owner-only gate applies: anyone who can read the repository
 * sees the chapters, only a person who administers it drafts, opens, fills, ships or patches. `n`
 * drafts, `o` opens the one under the cursor, `s` ships it, `p` opens a patch chapter for a closed
 * one, `enter` shows its list, where `a` adds an issue by number and `x` takes the one under the
 * cursor out. Each act is an event on the bus, so an open web page sees it, and this screen follows
 * a change made there.
 */

import { CHAPTER_WORDS, close, draft, fill, open, patch } from "../../actions/chapters.ts";
import { getChapter, itemsOf, listChapters, progressOf, type Chapter, type Item } from "../../core/chapters.ts";
import { canAdmin, type Repo } from "../../core/repos.ts";
import type { Ctx, Screen } from "../app/app.ts";
import type { Command } from "../app/palette.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill as fillSpace, len, split } from "../ui/layout.ts";
import { ListState, confirmScreen, drawList, live, promptScreen, type ListRow } from "./common.ts";

const isChapterEvent = (kind: string): boolean => kind.startsWith("chapter.") || kind === "release.verified_live";

/** The words under a chapter's name: what done means, then how far it is. */
function chapterRow(f: Session, c: Chapter): ListRow {
  const p = progressOf(c, itemsOf(f.app.db, c), new Date());
  const progress = c.state === "closed" ? "finished" : `${p.done} of ${p.total} done`;
  return { title: `${c.name} — ${c.state}`, note: c.means === "" ? progress : `${c.means} (${progress})` };
}

function itemRow(i: Item): ListRow {
  const where = i.status === "done" ? `live ${(i.doneAt ?? "").slice(0, 10)}` : i.status === "building" ? "building now" : "left";
  return { title: `#${i.number} ${i.title}`, meta: where };
}

/** The mayor's check, as the acts make it: a person who administers the repository. */
const mayAct = (f: Session, repo: Repo): boolean => f.user !== undefined && f.user.kind !== "agent" && canAdmin(f.app.db, repo, f.user);

export function chapterScreen(f: Session, ctx: Ctx, repo: Repo, name: string): Screen {
  const state = new ListState();
  const items = (): Item[] => {
    const c = getChapter(f.app.db, repo.id, name);
    return c === undefined ? [] : itemsOf(f.app.db, c);
  };
  const screen: Screen = {
    title: `${repo.ownerName}/${repo.name} — ${name}`,
    keys: [binding(["j", "k"], "move cursor"), binding(["a"], "add an issue"), binding(["x"], "take it out"), binding(["o"], "open"), binding(["s"], "ship")],
    async load(signal) {
      live(f, signal, { repoId: repo.id, where: (e) => isChapterEvent(e.kind) }, () => ctx.invalidate());
    },
    render(area, s) {
      const c = ctx.theme.c;
      const chapter = getChapter(f.app.db, repo.id, name);
      const all = items();
      const [head, list] = split(area, "v", [len(1), fillSpace(1)]);
      const p = chapter === undefined ? undefined : progressOf(chapter, all, new Date());
      s.text(
        head!.x,
        head!.y,
        truncate(
          chapter === undefined ? "No such chapter." : `${chapter.state}: ${p!.done} of ${p!.total} done${p!.finishesOn === null ? "" : `, finishes ${p!.finishesOn}`}`,
          head!.w,
        ),
        style(c.mutedFg, c.bg),
        head!.x + head!.w,
      );
      drawList(s, list!, c, state, all.map(itemRow));
    },
    key(e) {
      const all = items();
      if (state.key(e, all.length)) return true;
      if (e.ctrl || e.alt) return false;
      if (e.key === "a") {
        ctx.push(
          promptScreen(ctx, screen, {
            title: `Add to ${name}`,
            label: "Issue number",
            onSubmit: (value) => {
              const n = Number(value.replace(/^#/, ""));
              if (!Number.isInteger(n) || n < 1) return "An issue number, like 12.";
              const done = fill(f.app, f.user, repo, name, n, true);
              if (!done.ok) return CHAPTER_WORDS[done.error];
              ctx.invalidate();
              return undefined;
            },
          }),
        );
        return true;
      }
      if (e.key === "x") {
        const at = all[state.index];
        if (at === undefined) return true;
        const done = fill(f.app, f.user, repo, name, at.number, false);
        ctx.toast(done.ok ? `#${at.number} is out of ${name}.` : CHAPTER_WORDS[done.error], done.ok ? undefined : "danger");
        ctx.invalidate();
        return true;
      }
      if (e.key === "o" || e.key === "s") {
        act(f, ctx, repo, screen, name, e.key);
        return true;
      }
      return false;
    },
  };
  return screen;
}

/** Open or ship a chapter by name; shipping asks first, since it tags and closes. */
function act(f: Session, ctx: Ctx, repo: Repo, parent: Screen, name: string, key: "o" | "s"): void {
  if (key === "o") {
    const done = open(f.app, f.user, repo, name);
    ctx.toast(done.ok ? `${name} is open.` : CHAPTER_WORDS[done.error], done.ok ? undefined : "danger");
    ctx.invalidate();
    return;
  }
  ctx.push(
    confirmScreen(ctx, parent, {
      title: `Ship ${name}?`,
      body: [`Tags the default branch ${name}, writes its notes and closes it;`, "what is not done moves to the next chapter."],
      actions: [{ label: "Ship it" }, { label: "Cancel", variant: "ghost" }],
      yesNo: true,
      onChoose: (i) => {
        if (i !== 0) return;
        void ctx.track(
          close(f.app, f.user, repo, name, true).then((done) => {
            ctx.toast(done.ok ? `${name} is finished.` : CHAPTER_WORDS[done.error], done.ok ? undefined : "danger");
            ctx.invalidate();
          }),
        );
      },
    }),
  );
}

export function chaptersScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  const state = new ListState();
  const all = (): Chapter[] => listChapters(f.app.db, repo.id);
  const screen: Screen = {
    title: `${repo.ownerName}/${repo.name} — Chapters`,
    keys: [
      binding(["j", "k"], "move cursor"),
      binding(["enter"], "its list"),
      binding(["n"], "draft"),
      binding(["o"], "open"),
      binding(["s"], "ship"),
      binding(["p"], "patch"),
    ],
    async load(signal) {
      live(f, signal, { repoId: repo.id, where: (e) => isChapterEvent(e.kind) }, () => ctx.invalidate());
    },
    render(area, s) {
      const c = ctx.theme.c;
      const chapters = all();
      const [head, list] = split(area, "v", [len(1), fillSpace(1)]);
      s.text(
        head!.x,
        head!.y,
        truncate(
          chapters.length === 0 ? "No chapter yet: the crew works continuously." : mayAct(f, repo) ? "n drafts, o opens, s ships, p patches, enter shows the list." : "A person who administers this app drafts and ships chapters.",
          head!.w,
        ),
        style(c.mutedFg, c.bg),
        head!.x + head!.w,
      );
      drawList(s, list!, c, state, chapters.map((ch) => chapterRow(f, ch)));
    },
    key(e) {
      const chapters = all();
      if (state.key(e, chapters.length)) return true;
      if (e.ctrl || e.alt) return false;
      const at = chapters[state.index];
      if (e.key === "n") {
        ctx.push(
          promptScreen(ctx, screen, {
            title: "Draft a chapter",
            label: "Name (it becomes the git tag)",
            placeholder: "v1.0.0",
            onSubmit: (value) => {
              const made = draft(f.app, f.user, repo, { name: value });
              if (!made.ok) return CHAPTER_WORDS[made.error];
              ctx.invalidate();
              return undefined;
            },
          }),
        );
        return true;
      }
      if (at === undefined) return e.key === "o" || e.key === "s" || e.key === "p" || e.key === "enter";
      if (e.key === "enter") {
        ctx.push(chapterScreen(f, ctx, repo, at.name));
        return true;
      }
      if (e.key === "o" || e.key === "s") {
        act(f, ctx, repo, screen, at.name, e.key);
        return true;
      }
      if (e.key === "p") {
        const done = patch(f.app, f.user, repo, at.name);
        ctx.toast(done.ok ? `${done.value.name} is open.` : CHAPTER_WORDS[done.error], done.ok ? undefined : "danger");
        ctx.invalidate();
        return true;
      }
      return false;
    },
  };
  return screen;
}

/** The palette's command while a repository is open. */
export function chaptersCommands(f: Session, ctx: Ctx, repo: Repo | undefined): Command[] {
  if (repo === undefined) return [];
  return [
    {
      id: "chapters-app",
      title: `${repo.ownerName}/${repo.name} — Chapters`,
      hint: "a version with an end: draft, fill, open, ship, patch",
      run: () => ctx.push(chaptersScreen(f, ctx, repo)),
    },
  ];
}
