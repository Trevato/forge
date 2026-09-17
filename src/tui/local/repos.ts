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
import { G } from "../term/screen.ts";
import { ago, drawFacts, Filter, ListState } from "../screens/common.ts";
import { beside, fill, len, split } from "../ui/layout.ts";
import { card, emptyState } from "../ui/widgets.ts";
import type { Tokens } from "../ui/theme.ts";
import {
  asFailure,
  failureText,
  findRepos,
  Task,
  trackText,
  upstreamText,
  type Local,
  type LocalRepo,
} from "./common.ts";
import {
  cell,
  drawBusy,
  drawHeader,
  drawRows,
  type Cell,
  type Column,
} from "./rows.ts";
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
        binding(["j", "k"], "move"),
      ];
    },
    async load() {
      await reload();
    },
    render(area, s) {
      const c = ctx.theme.c;
      const [box, body, busy] = split(area, "v", [
        len(filter.on ? 1 : 0),
        fill(1),
        len(task.busy ? 1 : 0),
      ]);
      if (filter.on) ctx.setCursor(filter.render(s, box!, c, "filter"));
      if (task.busy) drawBusy(s, busy!, c, task.note, ctx.tick);
      if (entries.length === 0) {
        emptyState(s, body!, c, {
          title: "Nothing here yet",
          body: `No git repositories under ${local.root}`,
          action: "forge sync",
        });
        return;
      }
      const items = shown();
      // One host is the common case — `forge sync` writes them all under the
      // workbench you signed in to — and repeating it on every row costs the
      // repo name the width it wants. Say it once, above the list.
      const shared = sharedHost(items);
      const [head, rest] = split(body!, "v", [
        len(shared === null ? 0 : 1),
        fill(1),
      ]);
      if (shared !== null) drawHeader(s, head!, c, shared);
      const rows = items.map((entry) => rowFor(c, entry, shared !== null));
      const { main: left, aside: right } = beside(rest!, ctx.twoPane, {
        main: fill(3),
        aside: fill(2),
      });
      drawRows(s, left, c, list, COLUMNS, rows);
      if (right !== undefined) drawDetail(s, right, c, current());
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

/** state · repo · branch · changes · sync · stashes · fetched. */
const COLUMNS: readonly Column[] = [
  { gap: 0 },
  { grow: true, min: 12, gap: 1, emphasis: true },
  {},
  {},
  { align: "right" },
  { drop: 1 },
  { align: "right", drop: 2 },
];

function rowFor(c: Tokens, entry: Entry, short: boolean): Cell[] {
  const s = entry.status;
  const conflicts = s?.conflicted.length ?? 0;
  const dirty =
    s === null
      ? 0
      : s.staged.length + s.unstaged.length + s.untracked.length + conflicts;
  const tone =
    conflicts > 0
      ? c.danger
      : (s?.behind ?? 0) > 0
        ? c.attn
        : dirty > 0
          ? c.accent
          : c.faint;
  return [
    cell(G.dot, tone),
    cell(short ? shortLabel(entry.repo) : entry.repo.label, c.fg),
    cell(s?.head ?? "detached", s === null ? c.faint : c.mutedFg),
    conflicts > 0
      ? cell(`${conflicts} conflicted`, c.danger)
      : dirty > 0
        ? cell(`${dirty} changed`, c.accent)
        : cell(""),
    cell(s === null ? "" : trackText(s.ahead, s.behind), c.attn),
    entry.stashes > 0 ? cell(`${entry.stashes} stashed`, c.mutedFg) : cell(""),
    cell(fetched(entry.lastFetch), c.faint),
  ];
}

/** "forge.local", when every repo in view came from the same one. */
function sharedHost(entries: readonly Entry[]): string | null {
  if (entries.length === 0) return null;
  const first = hostOf(entries[0]!.repo);
  if (first === null) return null;
  return entries.every((e) => hostOf(e.repo) === first) ? first : null;
}

/** The `<host>` of `<host>/<owner>/<name>`, or null for a shallower clone. */
function hostOf(repo: LocalRepo): string | null {
  const parts = repo.label.split("/");
  return parts.length >= 3 ? (parts[0] ?? null) : null;
}

function shortLabel(repo: LocalRepo): string {
  return repo.label.split("/").slice(-2).join("/");
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
    ["tracking", status === null ? "—" : upstreamText(status)],
    [
      "changes",
      status === null
        ? "—"
        : `${status.staged.length} staged, ${status.unstaged.length} changed, ${status.untracked.length} new`,
    ],
    ["conflicts", String(status?.conflicted.length ?? 0)],
    ["stashes", String(entry.stashes)],
    ["last fetch", fetched(entry.lastFetch)],
    ["pinned", entry.pinned ? "yes" : "no"],
  ]);
}

/** "never fetched" reads as a state; a bare "never" reads as a shrug. */
function fetched(when: Date | null): string {
  return when === null ? "never fetched" : ago(when.toISOString());
}
