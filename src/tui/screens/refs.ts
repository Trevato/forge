/**
 * The ref picker: branches and tags in one filterable list, applied to
 * whatever asked for it (a tree, a commit log, a pull's base or head).
 *
 * It reads through the `RepoSource`, so the same picker switches branch on a
 * repository we hold and on one being browsed live on another forge.
 */

import type { RepoSource } from "../../view/source.ts";
import type { Ctx, Screen } from "../app/app.ts";
import type { Session } from "../session.ts";
import { pickerScreen, type PickItem } from "./common.ts";

export interface RefList {
  readonly branches: string[];
  readonly tags: string[];
  readonly defaultBranch: string;
}

export async function loadRefs(src: RepoSource): Promise<RefList> {
  const [heads, tags] = await Promise.all([src.branches(), src.tags()]);
  const branches = heads.ok ? heads.value : [];
  return {
    branches: branches.map((b) => b.name),
    tags: tags.ok ? tags.value.map((t) => t.name) : [],
    defaultBranch: branches.find((b) => b.isDefault)?.name ?? "",
  };
}

/**
 * A picker over a repo's refs. It loads inside its own `load`, so a slow
 * `for-each-ref` — or a round trip to another forge — shows the spinner
 * instead of freezing the caller.
 */
export function refPickerScreen(
  f: Session,
  ctx: Ctx,
  parent: Screen,
  src: RepoSource,
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
      const refs = await loadRefs(src);
      items = [
        ...refs.branches.map((name) => ({
          id: name,
          label: name,
          hint: name === refs.defaultBranch ? "default" : "branch",
        })),
        ...(o.branchesOnly === true
          ? []
          : refs.tags.map((name) => ({ id: name, label: name, hint: "tag" }))),
      ];
      ctx.invalidate();
    },
  };
}
