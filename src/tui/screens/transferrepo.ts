/**
 * Move this repository to another owner, from a repository screen's `:`
 * palette (#569): the terminal's door to `POST …/transfer`. The new owner's
 * name is typed; the move refuses what the API refuses, in the same words.
 * Only a person who administers the repository is offered it.
 */

import { TRANSFER_SAID, transferRepository } from "../../actions/transfer.ts";
import { canAdmin, type Repo } from "../../core/repos.ts";
import type { Ctx, Screen } from "../app/app.ts";
import type { Command } from "../app/palette.ts";
import type { Session } from "../session.ts";
import { promptScreen } from "./common.ts";

export const TRANSFER_REPO = "Move this repository to another owner";

/** The prompt floats over whatever is already drawn; this is the empty backdrop it asks for. */
const backdrop: Screen = {
  title: TRANSFER_REPO,
  keys: [],
  render() {},
  key: () => false,
};

export function transferRepoCommands(f: Session, ctx: Ctx, repo: Repo | undefined): Command[] {
  if (repo === undefined || f.user === undefined || f.user.kind !== "user") return [];
  if (!canAdmin(f.db, repo, f.user)) return [];
  const full = `${repo.ownerName}/${repo.name}`;
  return [
    {
      id: "transfer-repository",
      title: `${full} — ${TRANSFER_REPO}`,
      hint: "old links answer with the new place",
      run: () =>
        ctx.push(
          promptScreen(ctx, backdrop, {
            title: TRANSFER_REPO,
            label: `Moves ${full} with its issues, pulls, app and crew. New owner:`,
            placeholder: "an account or organisation",
            onSubmit: (typed) => {
              const newOwner = typed.trim();
              if (newOwner === "") return "Type the new owner's name.";
              return (async () => {
                const moved = await transferRepository(f.app, f.user, repo, newOwner);
                if (!moved.ok) {
                  ctx.toast(moved.error === "not_found" ? "no such repository" : TRANSFER_SAID[moved.error], "danger");
                  return;
                }
                ctx.toast(`moved ${full} to ${moved.value.ownerName}/${moved.value.name}`, "success");
                ctx.leaveRepo(repo.id);
              })();
            },
          }),
        ),
    },
  ];
}
