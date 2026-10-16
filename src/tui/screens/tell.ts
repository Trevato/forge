/**
 * Tell the crew, from a repository screen's `:` palette (#1788): one line,
 * the same `tell()` the web row calls, answered in the web flash's words.
 * The row is the screen's own and only for who `mayDirectCrew` there — the
 * gate `tellRow` in `src/web/scope.ts` asks. `from` is null: a terminal
 * screen has no page path of its own.
 */

import { tell, toldWords, TOO_LONG_WORDS, UNVERIFIED_WORDS, type Told, type TellError } from "../../actions/tell.ts";
import type { Repo } from "../../core/repos.ts";
import { DIRECTION_NOTE, mayDirectCrew } from "../../crew/direct.ts";
import type { Result } from "../../kernel/result.ts";
import type { Ctx, Screen } from "../app/app.ts";
import type { Command } from "../app/palette.ts";
import type { Session } from "../session.ts";
import { promptScreen } from "./common.ts";

/** The words of one tell, refused or told, with the tone they are shown in. */
export function tellAnswer(told: Result<Told, TellError>): { text: string; tone: "success" | "danger" } {
  if (told.ok) return { tone: told.value.routed === undefined || told.value.assigned ? "success" : "danger", text: toldWords(told.value) };
  return {
    tone: "danger",
    text:
      told.error === "forbidden"
        ? DIRECTION_NOTE
        : told.error === "unverified"
          ? UNVERIFIED_WORDS
          : told.error === "body_too_long"
            ? TOO_LONG_WORDS
            : "That could not be told.",
  };
}

/** The palette row for `repo`, or none for a reader who may not direct the crew. */
export function tellCommands(f: Session, ctx: Ctx, parent: () => Screen, repo: Repo | undefined): Command[] {
  if (repo === undefined || !mayDirectCrew(f.db, repo, f.user)) return [];
  const name = `${repo.ownerName}/${repo.name}`;
  return [
    {
      id: "tell",
      title: `${name} — Tell the crew`,
      hint: "one line",
      run: () =>
        ctx.push(
          promptScreen(ctx, parent(), {
            title: "Tell the crew",
            label: name,
            hint: "enter sends",
            onSubmit: (said) => {
              if (said === "") return "Say something first.";
              return (async () => {
                const answer = tellAnswer(await tell(f.app, f.user, repo, said));
                ctx.toast(answer.text, answer.tone);
              })();
            },
          }),
        ),
    },
  ];
}
