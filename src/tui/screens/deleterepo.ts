/**
 * Delete this repository, from a repository screen's `:` palette (#8031): the
 * terminal's door to Settings' danger zone. The full name is typed before
 * anything goes, and only a person who administers the repository is offered it.
 */

import { deleteRepo } from "../../actions/repos.ts";
import { canAdmin, type Repo } from "../../core/repos.ts";
import { DELETE_REPO } from "../../web/danger_words.ts";
import type { Ctx, Screen } from "../app/app.ts";
import type { Command } from "../app/palette.ts";
import type { Session } from "../session.ts";
import { promptScreen } from "./common.ts";

const GOES =
  "every issue, pull request, comment and webhook, and the git objects; forks are detached first and keep working";

/** The prompt floats over whatever is already drawn; this is the empty backdrop it asks for. */
const backdrop: Screen = {
  title: DELETE_REPO,
  keys: [],
  render() {},
  key: () => false,
};

export function deleteRepoCommands(f: Session, ctx: Ctx, repo: Repo | undefined): Command[] {
  if (repo === undefined || f.user === undefined || f.user.kind !== "user") return [];
  if (!canAdmin(f.db, repo, f.user)) return [];
  const full = `${repo.ownerName}/${repo.name}`;
  return [
    {
      id: "delete-repository",
      title: `${full} — ${DELETE_REPO}`,
      hint: "cannot be undone",
      run: () =>
        ctx.push(
          promptScreen(ctx, backdrop, {
            title: `${DELETE_REPO} (cannot be undone)`,
            label: `Removes ${GOES}. Type ${full}:`,
            placeholder: full,
            onSubmit: (typed) => {
              if (typed !== full) return `Type ${full} to confirm.`;
              // The prompt pops itself once this returns; the repository's
              // own screens unwind after the delete, never to read it again.
              return (async () => {
                const done = await deleteRepo(f.app, f.user, repo);
                if (!done.ok) {
                  ctx.toast(done.error === "not_found" ? "no such repository" : "could not delete the repository", "danger");
                  return;
                }
                ctx.toast(`deleted ${full}`, "success");
                ctx.leaveRepo(repo.id);
              })();
            },
          }),
        ),
    },
  ];
}
