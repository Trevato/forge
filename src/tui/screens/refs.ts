/**
 * The ref picker: branches and tags in one filterable list, applied to
 * whatever asked for it (a tree, a commit log, a pull's base or head).
 */

import type { Repo } from "../../core/repos.ts";
import { listRefs } from "../../git/read.ts";
import type { Ctx, Screen } from "../app/app.ts";
import type { Session } from "../session.ts";
import { pickerScreen, type PickItem } from "./common.ts";

export interface RefList {
  readonly branches: string[];
  readonly tags: string[];
}

export async function loadRefs(f: Session, repo: Repo): Promise<RefList> {
  const [heads, tags] = await Promise.all([
    listRefs(f.dir(repo), "refs/heads/"),
    listRefs(f.dir(repo), "refs/tags/"),
  ]);
  return {
    branches: heads.ok
      ? heads.value.map((r) => r.name.replace("refs/heads/", ""))
      : [],
    tags: tags.ok
      ? tags.value.map((r) => r.name.replace("refs/tags/", ""))
      : [],
  };
}

/**
 * A picker over a repo's refs. It loads inside its own `load`, so a slow
 * `for-each-ref` shows the spinner instead of freezing the caller.
 */
export function refPickerScreen(
  f: Session,
  ctx: Ctx,
  parent: Screen,
  repo: Repo,
  onPick: (ref: string) => void,
  o: { branchesOnly?: boolean; title?: string } = {},
): Screen {
  let items: PickItem[] = [];
  const picker = pickerScreen(ctx, parent, {
    title: o.title ?? "Switch ref",
    get items() {
      return items;
    },
    onPick: (ids) => {
      const chosen = ids[0];
      if (chosen !== undefined) onPick(chosen);
    },
  });
  return {
    ...picker,
    async load() {
      const refs = await loadRefs(f, repo);
      items = [
        ...refs.branches.map((name) => ({
          id: name,
          label: name,
          hint: name === repo.defaultBranch ? "default" : "branch",
        })),
        ...(o.branchesOnly === true
          ? []
          : refs.tags.map((name) => ({ id: name, label: name, hint: "tag" }))),
      ];
      ctx.invalidate();
    },
  };
}
