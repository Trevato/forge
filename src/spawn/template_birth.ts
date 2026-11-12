/**
 * A forge made from a template begins with its files (#7535). The template
 * is a copy of files at the moment of birth: one commit in a new private
 * repository in the child's organisation, no history and no upstream. Only
 * the template's tracked files travel — never a setting, secret, issue or
 * run (`docs/SPAWN.md`, "never copied"). Once: a retry finds the repository
 * with its commit and leaves it.
 */

import type { App } from "../app.ts";
import { bakedFiles as scaffoldFiles } from "../apps/template.ts";
import { createRepo, getRepo, updateRepoSettings } from "../core/repos.ts";
import { runGit } from "../git/env.ts";
import { repoDir } from "../git/repos.ts";
import { commitFiles, type FileWrite } from "../git/write.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { freshName } from "./plan.ts";

/** What `parent.json` records of the template: where the child came from. */
export interface TemplateMark {
  readonly id: string;
  readonly repo?: string;
  readonly tip?: string;
}

/** The files a built-in template holds, for the app's name and description. */
export function templateFiles(id: string, name: string, description: string): FileWrite[] | undefined {
  if (id === "starter") return scaffoldFiles({ name, description });
  return undefined;
}

/**
 * Commit the template's files into a private repository of the child's
 * organisation. The repository is named for the spawner's `fresh` sentence
 * when given (which then becomes its description), else `app`.
 * Returns what `parent.json` should record, or undefined for an unknown template.
 */
export async function birthFromTemplate(
  child: App,
  org: { readonly id: string; readonly username: string },
  input: {
    readonly template: string;
    readonly fresh?: { readonly name: string; readonly description: string };
    readonly direction: string;
    /** Names already taken by forked apps. */
    readonly taken: ReadonlySet<string>;
  },
): Promise<Result<TemplateMark | undefined, string>> {
  const description = input.fresh?.description ?? "";
  const name = input.fresh?.name ?? freshName("app", new Set([...input.taken, "forge"]));
  const files = templateFiles(input.template, name, description);
  if (files === undefined) return ok(undefined);

  let repo = getRepo(child.db, org.username, name);
  if (!repo) {
    const made = await createRepo(child.db, child.reposRoot, {
      ownerId: org.id,
      name,
      visibility: "private",
      description,
      defaultBranch: "main",
    });
    if (!made.ok) return err(`could not make ${name}: ${made.error}`);
    repo = made.value;
  }
  const dir = repoDir(child.reposRoot, org.username, name);
  const has = await runGit(["rev-parse", "--verify", "-q", `refs/heads/${repo.defaultBranch}`], { cwd: dir });
  if (!has.ok) {
    const c = await commitFiles(dir, {
      branch: repo.defaultBranch,
      message: `Start from the ${input.template} template`,
      files,
      author: { name: "forge", email: "forge@spawn.forge.invalid" },
    });
    if (!c.ok) return err(`could not start ${name} from the ${input.template} template`);
  }
  if (input.direction !== "" && repo.autonomyDirection !== input.direction)
    updateRepoSettings(child.db, repo, { autonomyDirection: input.direction });
  return ok({ id: input.template });
}
