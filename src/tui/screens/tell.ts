/**
 * Tell the crew, from a repository screen's `:` palette (#1788): one line,
 * the same `tell()` the web row calls, answered in the web flash's words.
 * The row is the screen's own and only for who `mayDirectCrew` there — the
 * gate `tellRow` in `src/web/scope.ts` asks. `from` is null: a terminal
 * screen has no page path of its own. A second row tells from a page: it asks
 * for the page's address and the pull, checked and written into the tell by
 * the same `parseContext` and `contextNote` the pill's tell and the MCP use.
 */

import { SENT_WORDS, tell, toldWords, TOO_LONG_WORDS, UNVERIFIED_WORDS, type Told, type TellError } from "../../actions/tell.ts";
import { contextNote, parseContext } from "../../actions/tell_context.ts";
import { NOT_TOLD_FROM_WORDS, NOT_TOLD_WORDS, SAY_SOMETHING_WORDS } from "../../actions/tell_words.ts";
import type { Repo } from "../../core/repos.ts";
import { DIRECTION_NOTE, mayDirectCrew } from "../../crew/direct.ts";
import type { Result } from "../../kernel/result.ts";
import type { Ctx, Screen } from "../app/app.ts";
import type { Command } from "../app/palette.ts";
import type { Session } from "../session.ts";
import { later, promptScreen } from "./common.ts";

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
            : NOT_TOLD_WORDS,
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
              if (said === "") return SAY_SOMETHING_WORDS;
              return (async () => {
                const answer = tellAnswer(await tell(f.app, f.user, repo, said));
                ctx.toast(answer.text, answer.tone);
              })();
            },
          }),
        ),
    },
    {
      id: "tell-page",
      title: `${name} — Tell the crew from a page`,
      hint: "page, pull, then one line",
      run: () =>
        ctx.push(
          promptScreen(ctx, parent(), {
            title: "Page address",
            label: name,
            hint: "http(s) address of the page; enter continues",
            onSubmit: (page) => {
              if (parseContext({ page }) === null) return "That is not an http(s) address.";
              return later(ctx, () =>
                promptScreen(ctx, parent(), {
                  title: "Pull",
                  label: name,
                  hint: "the pull number on a preview, or leave empty",
                  onSubmit: (pull) => {
                    const number = pull === "" ? undefined : /^\d{1,9}$/.test(pull) ? Number(pull) : -1;
                    if (parseContext({ page, ...(number === undefined ? {} : { pull: number }) }) === null)
                      return "A pull is a number, like 7.";
                    return later(ctx, () =>
                      promptScreen(ctx, parent(), {
                        title: "Tell the crew",
                        label: name,
                        hint: "enter sends",
                        onSubmit: (said) => {
                          if (said === "") return SAY_SOMETHING_WORDS;
                          return tellFromPage(f, ctx, repo, said, page, number);
                        },
                      }),
                    );
                  },
                }),
              );
            },
          }),
        ),
    },
  ];
}

/** One tell with the page (and pull) it is said from, answered in the web's words. */
export async function tellFromPage(
  f: Session,
  ctx: Ctx,
  repo: Repo,
  said: string,
  page: string,
  pull: number | undefined,
): Promise<void> {
  const where = parseContext({ page, ...(pull === undefined ? {} : { pull }) });
  if (where === null || where === undefined) {
    ctx.toast(NOT_TOLD_FROM_WORDS, "danger");
    return;
  }
  const answer = tellAnswer(await tell(f.app, f.user, repo, `${said}${contextNote(where, { preview: true })}`));
  ctx.toast(answer.text, answer.tone);
}

/** A client's "Ask for something" on the first screen: one line to the app's crew, answered in the web's words. */
export function askForSomething(f: Session, ctx: Ctx, parent: () => Screen, repo: Repo): void {
  if (!mayDirectCrew(f.db, repo, f.user)) return;
  ctx.push(
    promptScreen(ctx, parent(), {
      title: "Ask for something",
      label: repo.name,
      hint: "enter sends",
      onSubmit: (said) => {
        if (said === "") return SAY_SOMETHING_WORDS;
        return (async () => {
          const told = await tell(f.app, f.user, repo, said, 1, "/");
          const answer = told.ok ? { text: SENT_WORDS, tone: "success" as const } : tellAnswer(told);
          ctx.toast(answer.text, answer.tone);
        })();
      },
    }),
  );
}
