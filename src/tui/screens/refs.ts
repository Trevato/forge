/**
 * The ref picker: branches and tags in one filterable list, applied to
 * whatever asked for it (a tree, a commit log, a pull's base or head).
 *
 * It reads through the `RepoSource`, so the same picker switches branch on a
 * repository we hold and on one being browsed live on another forge.
 */

import { createBranch, deleteBranch } from "../../actions/branches.ts";
import { listBranches } from "../../git/branches.ts";
import type { RepoSource } from "../../view/source.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { emptyState } from "../ui/widgets.ts";
import type { Session } from "../session.ts";
import {
  Filter,
  ListState,
  confirmScreen,
  drawList,
  errorText,
  pickerScreen,
  plural,
  promptScreen,
  runAsync,
  type ListRow,
  type PickItem,
} from "./common.ts";
import { localRepo, sourceName, whereRows, whereStrip } from "./where.ts";

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

/** A branch as this screen shows it, from either side of a mirror. */
interface BranchRow {
  readonly name: string;
  readonly isDefault: boolean;
  readonly protected: boolean;
  readonly ahead: number | null;
  readonly behind: number | null;
}

/**
 * The branches screen: what exists, how far each has drifted, and the two
 * mutations that matter.
 *
 * Both mutations go through `actions/branches.ts`, which is the only reason
 * this screen is allowed to exist at all: on a mirror the ref is created or
 * deleted **on the origin first**, under the origin owner's own credential,
 * and moves here only if the origin took it. A local branch the origin refused
 * is precisely the divergence mirroring exists to prevent, so the toast names
 * the forge that answered rather than implying it was this one.
 *
 * Ahead/behind comes from `listBranches`, a local git read — a live origin
 * browse gets the names and the protected flag, and honestly shows no numbers
 * rather than inventing them.
 */
export function branchesScreen(
  f: Session,
  ctx: Ctx,
  src: RepoSource,
  o: { onPick?: (ref: string) => void; current?: string } = {},
): Screen {
  let rows: BranchRow[] = [];
  let loaded = false;
  let compared = true;
  const state = new ListState();
  const filter = new Filter();
  const repo = localRepo(src);
  const writable = src.capabilities.write && repo !== undefined;
  const mirrored = repo?.origin ?? null;

  const shown = (): BranchRow[] => rows.filter((r) => filter.matches(r.name));

  const reload = async (): Promise<void> => {
    const listed = await src.branches();
    const base: BranchRow[] = listed.ok
      ? listed.value.map((b) => ({
          name: b.name,
          isDefault: b.isDefault,
          protected: b.protected === true,
          ahead: null,
          behind: null,
        }))
      : [];
    // Default branch first, then alphabetical — the same order `listBranches`
    // uses, so the two halves of this screen agree about what row one is.
    base.sort((a, b) =>
      a.isDefault === b.isDefault
        ? a.name.localeCompare(b.name)
        : a.isDefault
          ? -1
          : 1,
    );
    rows = base;
    if (repo !== undefined) {
      const drift = await listBranches(f.dir(repo), repo.defaultBranch);
      if (drift.ok) {
        compared = drift.value.compared;
        const byName = new Map(
          drift.value.branches.map((b) => [b.name, b] as const),
        );
        rows = base.map((row) => {
          const hit = byName.get(row.name);
          return hit === undefined
            ? row
            : { ...row, ahead: hit.ahead, behind: hit.behind };
        });
      }
    }
    loaded = true;
    ctx.invalidate();
  };

  const create = (from: string): void => {
    if (repo === undefined) return;
    ctx.push(
      promptScreen(ctx, screen, {
        title: "New branch",
        label: `branch name (from ${from})`,
        placeholder: `${f.user?.username ?? "work"}/thing`,
        hint:
          mirrored === null
            ? "created here"
            : `created on ${mirrored.fullName} first, then here`,
        onSubmit: (name) => {
          if (name === "") return "give the branch a name";
          return (async () => {
            const made = await createBranch(f.app, f.user, repo, {
              name,
              from,
            });
            if (!made.ok) {
              ctx.toast(errorText(made.error), "danger");
              return;
            }
            await reload();
            ctx.toast(
              mirrored === null
                ? `created ${name}`
                : `created ${name} on ${mirrored.fullName} and here`,
              "success",
            );
          })();
        },
      }),
    );
  };

  const remove = (row: BranchRow): void => {
    if (repo === undefined) return;
    ctx.push(
      confirmScreen(ctx, screen, {
        title: "Delete branch",
        body: [
          `Delete ${row.name}?`,
          mirrored === null
            ? "The ref goes away here."
            : `The ref is deleted on ${mirrored.fullName} first.`,
        ],
        actions: [
          { label: "Cancel", variant: "ghost" },
          { label: "Delete", variant: "danger" },
        ],
        selected: 0,
        onChoose: (index) => {
          if (index !== 1) return;
          runAsync(ctx, async () => {
            const gone = await deleteBranch(f.app, f.user, repo, row.name);
            if (!gone.ok) {
              // `default_branch` is the action's own refusal and says exactly
              // why; showing it verbatim beats a generic "that failed".
              ctx.toast(
                gone.error === "default_branch"
                  ? `${row.name} is the default branch — it cannot be deleted`
                  : errorText(gone.error),
                "danger",
              );
              return;
            }
            await reload();
            ctx.toast(`deleted ${row.name}`, "success");
          });
        },
      }),
    );
  };

  const screen: Screen = {
    title: "Branches",
    get keys() {
      return [
        binding(["j", "k"], "move"),
        binding(["enter"], "browse this ref"),
        binding(["n"], "new branch", { disabled: !writable }),
        binding(["D"], "delete", { disabled: !writable }),
        binding(["/"], "filter"),
        binding(["r"], "refresh"),
      ];
    },
    load: reload,
    render(area, s) {
      const c = ctx.theme.c;
      const [strip, head, box, body] = split(area, "v", [
        len(whereRows(src)),
        len(1),
        len(1),
        fill(1),
      ]);
      whereStrip(s, strip!, c, f, src);
      s.text(
        head!.x,
        head!.y,
        truncate(
          `${sourceName(src)} · ${plural(rows.length, "branch", "branches")}${compared ? "" : " · too many to compare"}`,
          head!.w,
        ),
        style(c.mutedFg, c.bg),
        head!.x + head!.w,
      );
      ctx.setCursor(filter.render(s, box!, c, "filter branches"));
      const list = shown();
      if (list.length === 0) {
        emptyState(s, body!, c, {
          title: loaded ? "No branches" : "Reading…",
          body: loaded ? "Push one, or press n to create one." : "",
        });
        return;
      }
      drawList(
        s,
        body!,
        c,
        state,
        list.map((row): ListRow => {
          const marks = [
            row.isDefault ? "default" : "",
            row.protected ? "protected" : "",
            o.current !== undefined && row.name === o.current ? "browsing" : "",
          ].filter((m) => m !== "");
          const drift =
            row.ahead === null || row.behind === null
              ? ""
              : row.ahead === 0 && row.behind === 0
                ? "in sync"
                : `${row.ahead === 0 ? "" : `+${row.ahead}`} ${row.behind === 0 ? "" : `-${row.behind}`}`.trim();
          return {
            title: row.name,
            secondary: marks.join(" · "),
            meta: drift,
          };
        }),
      );
    },
    key(e) {
      if (filter.key(e)) {
        state.clamp(shown().length);
        return true;
      }
      const list = shown();
      if (state.key(e, list.length)) return true;
      const row = list[state.index];
      if (e.key === "enter" && row !== undefined) {
        if (o.onPick === undefined) return true;
        ctx.pop();
        o.onPick(row.name);
        return true;
      }
      if (e.key === "n" && writable) {
        create(row?.name ?? repo?.defaultBranch ?? "");
        return true;
      }
      if (e.key === "D" && writable && row !== undefined) {
        remove(row);
        return true;
      }
      if (e.key === "r") {
        runAsync(ctx, reload);
        return true;
      }
      return false;
    },
  };
  return screen;
}
