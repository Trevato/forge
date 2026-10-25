/**
 * Report a problem, from a repository screen's `:` palette (#810): the
 * terminal's door to what the forge toolbar's "Report this page" does on the
 * web. One text becomes an issue through `openIssueThrough`, titled by its
 * first line. A pull is commented on from its own screen.
 */

import { openIssueThrough } from "../../actions/issues.ts";
import { reportTitle } from "../../actions/page-report.ts";
import { NOT_SENT_WORDS, SAY_SOMETHING_WORDS } from "../../actions/tell_words.ts";
import { NOTE_TOO_LONG } from "../../apps/note_words.ts";
import { MAX_BODY } from "../../core/issues.ts";
import type { Repo } from "../../core/repos.ts";
import type { Ctx, Screen } from "../app/app.ts";
import type { Command } from "../app/palette.ts";
import type { Session } from "../session.ts";
import { promptScreen } from "./common.ts";

/** The palette row for `repo`: any signed-in person may report. */
export function reportCommands(f: Session, ctx: Ctx, parent: () => Screen, repo: Repo | undefined): Command[] {
  if (repo === undefined || f.user === undefined) return [];
  const name = `${repo.ownerName}/${repo.name}`;
  return [
    {
      id: "report",
      title: `${name} — Report a problem`,
      hint: "opens an issue",
      run: () =>
        ctx.push(
          promptScreen(ctx, parent(), {
            title: "Report a problem",
            label: name,
            hint: "enter sends",
            onSubmit: (said) => {
              const text = said.trim();
              if (text === "") return SAY_SOMETHING_WORDS;
              if (text.length > MAX_BODY) return NOTE_TOO_LONG;
              return (async () => {
                const opened = await openIssueThrough(f.app, f.user, repo, { title: reportTitle(text), body: text });
                if (opened.ok) ctx.toast(`Issue #${opened.value.number} opened.`, "success");
                else ctx.toast(NOT_SENT_WORDS, "danger");
              })();
            },
          }),
        ),
    },
  ];
}
