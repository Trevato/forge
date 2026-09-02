/**
 * The library: everything under your root, with the one line of state that
 * decides whether you need to do anything about it — branch, ahead/behind,
 * dirty, last fetch.
 *
 * The filesystem is the index here, exactly as git is the index on the
 * server. There is no local database of "your repos"; the walk finds them,
 * and a repo you cloned by hand shows up beside the ones `forge sync`
 * brought down, which is the behaviour that makes the tool trustworthy.
 */

import { err, ok } from "../../kernel/result.ts";
import * as git from "../../git/local.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding, type Binding } from "../app/keys.ts";
import {
  drawFacts,
  drawList,
  Filter,
  ListState,
  relTime,
  type ListRow,
} from "../screens/common.ts";
import { fill, len, split } from "../ui/layout.ts";
import { card, emptyState } from "../ui/widgets.ts";
import {
  asFailure,
  failureText,
  findRepos,
  Task,
  trackText,
  type Local,
  type LocalRepo,
} from "./common.ts";
import { workScreen } from "./work.ts";

interface Entry {
  readonly repo: LocalRepo;
  readonly status: git.LocalStatus | null;
  readonly stashes: number;
  readonly lastFetch: Date | null;
  readonly pinned: boolean;
}

export function reposScreen(local: Local, ctx: Ctx): Screen {
  const list = new ListState();
  const filter = new Filter();
  const task = new Task(ctx);
  let entries: Entry[] = [];
  let pins = new Set<string>();

  const shown = (): Entry[] =>
    entries.filter((e) => filter.matches(e.repo.label));
  const current = (): Entry | undefined => shown()[list.index];

  const reload = async (): Promise<void> => {
    const found = await findRepos(local.root);
    if (local.api !== null) {
      const listed = await local.api.pins();
      if (listed.ok)
        pins = new Set(listed.value.map((p) => `${p.owner}/${p.name}`));
    }
    entries = await Promise.all(
      found.map(async (repo) => {
        const status = await git.status(repo.dir);
        const stashes = await git.stashList(repo.dir);
        return {
          repo,
          status: status.ok ? status.value : null,
          stashes: stashes.ok ? stashes.value.length : 0,
          lastFetch: await git.lastFetch(repo.dir),
          pinned: pins.has(`${repo.owner}/${repo.name}`),
        };
      }),
    );
    list.clamp(shown().length);
    ctx.invalidate();
  };

  return {
    title: "Repos",
    get keys(): Binding[] {
      const has = current() !== undefined;
      return [
        binding(["enter"], "open", { disabled: !has }),
        binding(["f"], "fetch all"),
        binding(["p"], local.api === null ? "pin (sign in)" : "pin / unpin", {
          disabled: !has || local.api === null,
        }),
        binding(["r"], "refresh"),
        binding(["/"], "filter"),
      ];
    },
    async load() {
      await reload();
    },
    render(area, s) {
      const c = ctx.theme.c;
      const [box, body] = split(area, "v", [len(filter.on ? 1 : 0), fill(1)]);
      if (filter.on) ctx.setCursor(filter.render(s, box!, c, "filter"));
      if (entries.length === 0) {
        emptyState(s, body!, c, {
          title: "Nothing here yet",
          body: `No git repositories under ${local.root}`,
          action: "forge sync",
        });
        return;
      }
      const items = shown();
      if (!ctx.twoPane) {
        drawList(s, body!, c, list, items.map(rowFor));
        return;
      }
      const [left, right] = split(body!, "h", [fill(3), fill(2)]);
      drawList(s, left!, c, list, items.map(rowFor));
      drawDetail(s, right!, c, current());
    },
    key(e) {
      if (task.blocked) return true;
      if (filter.key(e)) {
        list.clamp(shown().length);
        return true;
      }
      if (list.key(e, shown().length)) return true;
      const entry = current();

      if (e.key === "enter" && entry) {
        ctx.push(workScreen(local, ctx, entry.repo));
        return true;
      }
      if (e.key === "r") {
        task.run("refresh", async () => ok(), reload);
        return true;
      }
      if (e.key === "f") {
        const all = shown().map((x) => x.repo.dir);
        task.run(
          "fetch",
          async (progress) => {
            // Serial rather than parallel: the point of the progress line is
            // that it says which repo it is on.
            for (const dir of all) {
              progress(dir.split("/").slice(-2).join("/"));
              const result = await git.fetch(dir, {});
              if (!result.ok) ctx.toast(failureText(result.error), "danger");
            }
            return ok();
          },
          reload,
        );
        return true;
      }
      if (e.key === "p" && entry && local.api !== null) {
        const api = local.api;
        const { owner, name } = entry.repo;
        const on = !entry.pinned;
        task.run(
          on ? "pin" : "unpin",
          async () => {
            const result = on
              ? await api.pin(owner, name)
              : await api.unpin(owner, name);
            return result.ok
              ? ok()
              : err(asFailure(result.error.message, on ? "pin" : "unpin"));
          },
          reload,
        );
        return true;
      }
      return false;
    },
  };
}

function rowFor(entry: Entry): ListRow {
  const s = entry.status;
  const dirty =
    s === null
      ? 0
      : s.staged.length +
        s.unstaged.length +
        s.untracked.length +
        s.conflicted.length;
  const bits = [
    s === null ? "" : trackText(s.ahead, s.behind),
    dirty > 0 ? `${dirty} changed` : "",
    entry.stashes > 0 ? `${entry.stashes} stashed` : "",
  ].filter((p) => p !== "");
  return {
    title: entry.repo.label,
    secondary: s?.head ?? "detached",
    meta: [bits.join("  "), fetched(entry.lastFetch)]
      .filter((p) => p !== "")
      .join("  "),
    ...(s !== null && s.conflicted.length > 0
      ? { state: "closed" as const }
      : dirty > 0
        ? { state: "draft" as const }
        : {}),
  };
}

function drawDetail(
  s: Parameters<Screen["render"]>[1],
  r: Parameters<Screen["render"]>[0],
  c: Parameters<typeof card>[2],
  entry: Entry | undefined,
): void {
  if (entry === undefined) return;
  const inner = card(s, r, c, { title: entry.repo.name });
  const status = entry.status;
  drawFacts(s, inner, c, [
    ["path", entry.repo.dir],
    ["branch", status?.head ?? "detached"],
    ["upstream", status?.upstream ?? "none"],
    [
      "tracking",
      status === null ? "—" : trackText(status.ahead, status.behind) || "level",
    ],
    [
      "changes",
      status === null
        ? "—"
        : `${status.staged.length} staged, ${status.unstaged.length} changed, ${status.untracked.length} new`,
    ],
    ["conflicts", String(status?.conflicted.length ?? 0)],
    ["stashes", String(entry.stashes)],
    ["fetched", fetched(entry.lastFetch) || "never"],
    ["pinned", entry.pinned ? "yes" : "no"],
  ]);
}

function fetched(when: Date | null): string {
  return when === null ? "never" : relTime(when.toISOString());
}
