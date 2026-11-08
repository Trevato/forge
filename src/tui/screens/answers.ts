/**
 * Your tells on an app, and what the crew said back — the page's own rows
 * (`answersFor`), behind the page's own gate (`canSeeAnswers`): the owner of
 * an app sees their tells; anyone else gets an empty screen, never a name.
 * `enter` opens the tell on the web, `r` reads again, and `t` tells the crew
 * more (#7416): one line through the same `tell()` and `tellAnswer` words the
 * palette's tell uses, told from the row's page when the cursor is on one.
 */

import { answersFor, canSeeAnswers } from "../../web/studio/answers.ts";
import { CREW_WORKING } from "../../actions/ask_state_words.ts";
import { tell } from "../../actions/tell.ts";
import { SAY_SOMETHING_WORDS } from "../../actions/tell_words.ts";
import type { Repo } from "../../core/repos.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { emptyState } from "../ui/widgets.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { ListState, drawList, hitList, metaOf, openOnWeb, promptScreen, relTime, type ListRow } from "./common.ts";
import { tellAnswer } from "./tell.ts";

/** One line of plain text: a tell or an answer may carry escapes the terminal must not obey. */
const plain = (text: string): string =>
  // eslint-disable-next-line no-control-regex
  text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();

export interface AnswerLine extends ListRow {
  readonly path: string;
}

/** The rows for `repo`; none unless the viewer may see the answers. */
export function answerLines(f: Session, repo: Repo): AnswerLine[] {
  if (!canSeeAnswers(f.db, repo, f.user)) return [];
  return answersFor(f.db, repo, f.user).map(({ issue, said, working }) => ({
    title: plain(issue.title),
    secondary:
      said === undefined
        ? working
          ? CREW_WORKING
          : "Waiting for the crew."
        : `${plain(said.who)}: ${plain(said.text)}`,
    meta: metaOf(said === undefined ? (working ? "working" : "waiting") : "answered", relTime(said?.at ?? issue.createdAt)),
    path: `/${repo.ownerName}/${repo.name}/issues/${issue.number}`,
  }));
}

export function answersScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  const state = new ListState();
  let lines: AnswerLine[] = [];
  const read = (): void => {
    lines = answerLines(f, repo);
    state.clamp(lines.length);
  };
  const open = (index: number): void => {
    const line = lines[index];
    if (line !== undefined) openOnWeb(f, ctx, line.path, "That tell");
  };
  const more = (): void => {
    if (!canSeeAnswers(f.db, repo, f.user)) return;
    // The row's page goes in as the tell's `from`, as a toolbar tell's does.
    const from = lines[state.index]?.path ?? null;
    ctx.push(
      promptScreen(ctx, screen, {
        title: "Tell the crew",
        label: from ?? `${repo.ownerName}/${repo.name}`,
        hint: "enter sends",
        onSubmit: (said) => {
          if (said === "") return SAY_SOMETHING_WORDS;
          return (async () => {
            const answer = tellAnswer(await tell(f.app, f.user, repo, said, 1, from));
            ctx.toast(answer.text, answer.tone);
            read();
            ctx.invalidate();
          })();
        },
      }),
    );
  };
  const screen: Screen = {
    title: "Your tells",
    keys: [binding(["j", "k"], "move"), binding(["enter"], "open"), binding(["t"], "tell"), binding(["r"], "refresh")],
    load: async () => read(),
    render(area, s) {
      const c = ctx.theme.c;
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      s.text(
        head!.x,
        head!.y,
        truncate(`${repo.ownerName}/${repo.name} · what the crew said back`, head!.w),
        style(c.mutedFg, c.bg),
        head!.x + head!.w,
      );
      if (lines.length === 0) {
        emptyState(s, body!, c, {
          title: "No issues yet",
          body: "What you tell the crew about this app shows up here, with its answer.",
        });
        return;
      }
      drawList(s, body!, c, state, lines);
      hitList(ctx, body!, state, lines.length, { open });
    },
    key(e) {
      if (state.key(e, lines.length)) return true;
      if (e.key === "enter") {
        open(state.index);
        return true;
      }
      if (e.key === "t") {
        more();
        return true;
      }
      if (e.key === "r") {
        read();
        ctx.invalidate();
        return true;
      }
      return false;
    },
  };
  return screen;
}
