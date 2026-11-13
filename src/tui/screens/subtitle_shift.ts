/**
 * Shift a subtitle file's cues, in the terminal: the same action as the file
 * page's form (`actions/subtitle_shift.ts`), so the same gate (a writer only;
 * a reader or guest is offered nothing), the same range and the same commit
 * message. The action writes through `editFiles`, which announces a push on
 * the bus, so an open web page of the file follows.
 */

import { requireWriter } from "../../actions/access.ts";
import { isSubtitlePath, shiftSubtitles } from "../../actions/subtitle_shift.ts";
import type { Repo } from "../../core/repos.ts";
import type { Ctx, Screen } from "../app/app.ts";
import type { Command } from "../app/palette.ts";
import type { Session } from "../session.ts";
import { later, promptScreen } from "./common.ts";

/** The palette's command while a repository is open and this viewer may write to it. */
export function shiftCommands(f: Session, ctx: Ctx, repo: Repo | undefined, parent: () => Screen): Command[] {
  if (repo === undefined || !requireWriter(f.app, f.user, repo).ok) return [];
  return [
    {
      id: "subtitle-shift",
      title: `${repo.ownerName}/${repo.name} — Shift subtitles`,
      hint: "move every cue of a .srt or .vtt file, saved as a commit",
      run: () =>
        ctx.push(
          promptScreen(ctx, parent(), {
            title: "Shift subtitles",
            label: "Path of the .srt or .vtt file",
            placeholder: "subs/movie.srt",
            onSubmit: (path) => {
              if (!isSubtitlePath(path)) return "Give the path of a .srt or .vtt file.";
              return later(ctx, () =>
                promptScreen(ctx, parent(), {
                  title: "Shift subtitles",
                  label: "Seconds, like 2.5 or -1",
                  value: "0",
                  onSubmit: async (offset) => {
                    const done = await shiftSubtitles(f.app, f.user, repo, { ref: repo.defaultBranch, path, offset });
                    if (done.ok) {
                      ctx.toast(done.value.pull === undefined ? `Committed to ${done.value.branch}.` : `Opened a pull from ${done.value.branch}.`);
                      return;
                    }
                    const e = done.error;
                    ctx.toast(
                      typeof e === "object" && e.kind === "refused" ? e.why : typeof e === "object" && e.kind === "missing" ? "No such file." : "That shift could not be saved.",
                      "danger",
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
