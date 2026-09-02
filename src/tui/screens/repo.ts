/**
 * A repository's front door: what it is, what is in it, and how to get it.
 *
 * It renders a `RepoSource`, so this one file is the front door of a
 * repository we hold *and* of one being read live off another forge. What
 * differs between them is not the layout — it is the where-strip under the
 * title, and which keys exist: a live browse has no `,` settings and no `F`
 * fork because there is nothing here to configure or fork yet, and it has
 * `m mirror` and `O open on origin` because those are the two things you can
 * actually do with somebody else's repository.
 *
 * The about card carries the clone URLs for a local repo — the single
 * most-copied string on any forge page, and the one thing a terminal can
 * hand over without a mouse.
 */

import { pinRepo, syncRepoNow, unpinRepo } from "../../actions/origins.ts";
import { isPinned } from "../../core/pins.ts";
import { canAdmin, type Repo } from "../../core/repos.ts";
import type { TreeEntry } from "../../git/read.ts";
import type { RepoFacts, RepoSource } from "../../view/source.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Span } from "../term/screen.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { renderMarkdown } from "../ui/markdown.ts";
import { badge, card, emptyState } from "../ui/widgets.ts";
import type { Session } from "../session.ts";
import {
  ListState,
  PIN_MARK,
  Scroll,
  ago,
  drawFacts,
  drawLines,
  drawList,
  errorText,
  runAsync,
} from "./common.ts";
import { commitsScreen } from "./commits.ts";
import { issuesScreen } from "./issues.ts";
import { liveBindings, liveKey } from "./mirror.ts";
import { blobScreen, treeScreen } from "./tree.ts";
import { forkScreen } from "./newrepo.ts";
import { ownerScreen } from "./owner.ts";
import { refPickerScreen } from "./refs.ts";
import { settingsScreen } from "./settings.ts";
import {
  hostOf,
  knownDefaultRef,
  local,
  localRepo,
  liveOrigin,
  sourceName,
  whereRows,
  whereStrip,
} from "./where.ts";

/** Where a screen was when it was replaced, so the swap is not a jump. */
export interface RepoScreenState {
  readonly ref?: string;
  readonly index?: number;
  readonly top?: number;
}

export function repoScreen(
  f: Session,
  ctx: Ctx,
  src: RepoSource,
  keep: RepoScreenState = {},
): Screen {
  let facts: RepoFacts | undefined;
  let ref = keep.ref ?? knownDefaultRef(src) ?? "";
  let entries: TreeEntry[] = [];
  let readme: Span[][] = [];
  let readmePath = "";
  let readmeSource = "";
  let width = 0;
  let pinned = false;
  /** Which reads have answered, so nothing on screen claims "empty" early. */
  const read = { tree: false, readme: false };
  const state = new ListState();
  const scroll = new Scroll();
  const repo = localRepo(src);
  const live = liveOrigin(src);
  state.index = keep.index ?? 0;
  scroll.top = keep.top ?? 0;

  const admin = (): boolean =>
    repo !== undefined && canAdmin(f.db, repo, f.user);
  const readPin = (): void => {
    pinned =
      repo !== undefined &&
      f.user !== undefined &&
      isPinned(f.db, f.user.id, repo.id);
  };

  /**
   * Three reads, each painting the moment it lands. The description arrives
   * first (it carries the default branch everything else needs), then the
   * tree and the README race each other in — a repo screen that waits for
   * its README before drawing its file list is a repo screen that feels slow
   * on somebody else's forge.
   */
  const reload = async (): Promise<void> => {
    readPin();
    const described = await src.describe();
    if (described.ok) {
      facts = described.value;
      if (ref === "") ref = described.value.defaultBranch;
      ctx.invalidate();
    } else if (ref === "") {
      ctx.toast(errorText(described.error), "danger");
      return;
    }
    const at = ref;
    await Promise.all([
      (async () => {
        const tree = await src.tree(at, "");
        entries = tree.ok ? tree.value : [];
        read.tree = true;
        ctx.invalidate();
      })(),
      (async () => {
        const found = await src.readme(at);
        readmeSource =
          found.ok && found.value !== null ? found.value.markdown : "";
        readmePath = found.ok && found.value !== null ? found.value.path : "";
        read.readme = true;
        width = 0;
        ctx.invalidate();
      })(),
    ]);
  };

  const openLocal = (next: Repo): void => {
    ctx.replace(
      repoScreen(f, ctx, local(f, next), {
        index: state.index,
        top: scroll.top,
      }),
    );
  };

  const screen: Screen = {
    title: sourceName(src),
    get keys() {
      return [
        binding(["enter"], "open"),
        // On a live browse these two are the *only* things you can do to the
        // repository, so they come before the navigation — at 80 columns the
        // help bar shows about six bindings and these must be among them.
        ...liveBindings(src),
        ...(live?.mirroredAs === undefined
          ? []
          : [binding(["w"], "open the workbench copy")]),
        binding(["i"], "issues"),
        binding(["p"], "pulls"),
        binding(["c"], "commits"),
        binding(["b"], "ref"),
        // `p` is pulls on this screen and has been since before pins
        // existed, so the toggle takes the shifted key here. Everywhere a
        // repo is a *row* — explore, the dashboard — plain `p` is free and
        // is what pins it.
        ...(repo === undefined
          ? []
          : [
              binding(["P"], pinned ? "unpin" : "pin", {
                disabled: !f.signedIn,
              }),
              binding(["y"], "sync now", {
                disabled: repo.origin === null || !admin(),
              }),
              binding(["F"], "fork", { disabled: !f.signedIn }),
              binding([","], "settings", { disabled: !admin() }),
            ]),
        binding(["r"], "refresh"),
      ];
    },
    load: reload,
    render(area, s) {
      const c = ctx.theme.c;
      const rows = aboutFacts(f, src, facts);
      const [strip, about, body] = split(area, "v", [
        len(whereRows(src)),
        len(Math.min(Math.max(2, area.h - 4), 4 + rows.length)),
        fill(1),
      ]);
      whereStrip(s, strip!, c, f, src);
      const inner = card(s, about!, c, {
        title: sourceName(src),
        footer: ref,
      });
      // One inset for the whole card. A chip carries its own left pad, so the
      // badges sit a column earlier and every line of text — badge label,
      // description, clone URLs, and the card's own title — starts here.
      const lead = inner.x + 1;
      const edge = inner.x + inner.w;
      const visibility = facts?.visibility ?? repo?.visibility ?? "public";
      let x = badge(s, inner.x, inner.y, c, {
        text: visibility,
        variant: visibility === "public" ? "success" : "secondary",
      });
      if (repo?.protectDefault === true)
        x = badge(s, x + 1, inner.y, c, { text: "protected", variant: "attn" });
      if (repo !== undefined && repo.forkParentId !== null)
        x = badge(s, x + 1, inner.y, c, { text: "fork", variant: "outline" });
      if (repo !== undefined && repo.origin !== null)
        x = badge(s, x + 1, inner.y, c, { text: "mirror", variant: "attn" });
      if (repo === undefined)
        x = badge(s, x + 1, inner.y, c, {
          text: "read-only",
          variant: "outline",
        });
      if (pinned)
        badge(s, x + 1, inner.y, c, {
          text: `${PIN_MARK} on your machine`,
          variant: "outline",
        });
      const description = facts?.description ?? repo?.description ?? "";
      s.text(
        lead,
        inner.y + 1,
        truncate(
          description === "" ? "No description." : description,
          Math.max(0, edge - lead),
        ),
        style(description === "" ? c.faint : c.fg, c.card),
        edge,
      );
      drawFacts(
        s,
        {
          x: lead,
          y: inner.y + 2,
          w: Math.max(0, edge - lead),
          h: Math.max(0, inner.h - 2),
        },
        c,
        rows,
      );

      const [left, right] = ctx.twoPane
        ? split(body!, "h", [len(34), fill(1)])
        : [body!, undefined];
      if (entries.length === 0)
        emptyState(s, left!, c, {
          // Before the first read lands, "empty" would be a lie: the screen
          // is on the stack from the keypress, and the bytes are on the way.
          title: read.tree ? "Empty repository" : "Reading…",
          body: read.tree
            ? "Push a branch to get started."
            : `Listing ${sourceName(src)}`,
        });
      else
        drawList(
          s,
          left!,
          c,
          state,
          entries.map((e) => ({
            title: e.type === "tree" ? `${e.name}/` : e.name,
          })),
        );
      if (right === undefined) return;
      if (width !== right.w) {
        width = right.w;
        readme =
          readmeSource === ""
            ? []
            : renderMarkdown(readmeSource, Math.max(20, right.w - 2), c);
      }
      if (readme.length === 0)
        emptyState(s, right, c, {
          title: read.readme ? "No README" : "Reading…",
          body: read.readme
            ? "Add a README.md and it shows up here."
            : `Looking for a README in ${ref === "" ? "the default branch" : ref}`,
        });
      else {
        const inner2 = card(s, right, c, { title: readmePath });
        drawLines(s, inner2, c, scroll, readme);
      }
    },
    key(e) {
      if (state.key(e, entries.length)) return true;
      if (e.key === "enter") {
        const entry = entries[state.index];
        if (!entry) return true;
        ctx.push(
          entry.type === "tree"
            ? treeScreen(f, ctx, src, ref, entry.name)
            : blobScreen(f, ctx, src, ref, entry.name),
        );
        return true;
      }
      if (e.key === "f") {
        ctx.push(treeScreen(f, ctx, src, ref));
        return true;
      }
      if (e.key === "i") {
        ctx.push(issuesScreen(f, ctx, src, "issue"));
        return true;
      }
      if (e.key === "p") {
        ctx.push(issuesScreen(f, ctx, src, "pull"));
        return true;
      }
      if (e.key === "c") {
        ctx.push(commitsScreen(f, ctx, src, ref));
        return true;
      }
      if (e.key === "o" && repo !== undefined) {
        ctx.push(ownerScreen(f, ctx, repo.ownerName));
        return true;
      }
      if (e.key === "b") {
        ctx.push(
          refPickerScreen(f, ctx, screen, src, (chosen) =>
            ctx.replace(repoScreen(f, ctx, src, { ref: chosen })),
          ),
        );
        return true;
      }
      if (liveKey(f, ctx, e, src, { parent: screen, onDone: openLocal }))
        return true;
      if (e.key === "w" && live?.mirroredAs !== undefined) {
        openLocal(live.mirroredAs);
        return true;
      }
      if (e.key === "P" && f.user && repo !== undefined) {
        const wanted = !pinned;
        const done = wanted
          ? pinRepo(f.app, f.user, repo)
          : unpinRepo(f.app, f.user, repo);
        if (!done.ok && wanted) ctx.toast(errorText(done.error), "danger");
        else {
          readPin();
          ctx.invalidate();
          ctx.toast(wanted ? "pinned" : "unpinned", "success");
        }
        return true;
      }
      if (
        e.key === "y" &&
        repo !== undefined &&
        repo.origin !== null &&
        admin()
      ) {
        runAsync(ctx, async () => {
          const synced = await syncRepoNow(f.app, f.user, repo);
          if (!synced.ok) ctx.toast(errorText(synced.error), "danger");
          else if (synced.value.error !== "")
            ctx.toast(synced.value.error, "danger");
          else {
            await reload();
            ctx.toast("synced from the origin", "success");
          }
        });
        return true;
      }
      if (e.key === "F" && f.signedIn && repo !== undefined) {
        ctx.push(forkScreen(f, ctx, repo));
        return true;
      }
      if (e.key === "," && repo !== undefined && admin()) {
        ctx.push(settingsScreen(f, ctx, repo));
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

/**
 * The label/value block under the description. A local repo gets the clone
 * URLs (and where it was mirrored from); a live browse gets the page it is
 * reading and the branch it is on, because there is nothing here to clone.
 */
function aboutFacts(
  f: Session,
  src: RepoSource,
  facts: RepoFacts | undefined,
): [string, string][] {
  const repo = localRepo(src);
  if (repo !== undefined) return [...originFacts(repo), ...cloneFacts(f, repo)];
  const live = liveOrigin(src);
  const rows: [string, string][] = [];
  if (live !== undefined)
    rows.push([
      "reading",
      `${hostOf(live.origin.webUrl)} · ${live.origin.login}'s connection`,
    ]);
  if (facts !== undefined) {
    rows.push(["default branch", facts.defaultBranch]);
    if (facts.pushedAt !== null) rows.push(["last push", ago(facts.pushedAt)]);
  }
  if (live !== undefined) rows.push(["page", live.htmlUrl]);
  return rows;
}

/**
 * Where a mirror came from and when it was last fetched — one line, because
 * that is the whole of what a reader needs before they trust what is on the
 * screen. A native repo has no such line rather than an empty one.
 */
function originFacts(repo: Repo): [string, string][] {
  const origin = repo.origin;
  if (origin === null) return [];
  const host = hostOf(origin.htmlUrl);
  const fetched =
    origin.lastFetchAt === null
      ? "never fetched"
      : `fetched ${ago(origin.lastFetchAt)}`;
  const error = origin.fetchError === "" ? "" : ` · ${origin.fetchError}`;
  return [
    [
      "mirrored from",
      `${origin.fullName}${host === "" ? "" : ` @ ${host}`} · ${fetched}${error}`,
    ],
  ];
}

/** The two clone URLs, from the ports this forge is actually listening on. */
export function cloneFacts(f: Session, repo: Repo): [string, string][] {
  const host = f.app.config.host ?? "localhost";
  const path = `${repo.ownerName}/${repo.name}.git`;
  const facts: [string, string][] = [
    ["clone (http)", `http://${host}:${f.app.config.port ?? 3000}/${path}`],
  ];
  // Matches what the web hands out, `git@` and all: a URL a reader copies is
  // wrong the moment the two surfaces disagree about it.
  if (f.app.config.sshPort !== undefined)
    facts.push([
      "clone (ssh)",
      `ssh://git@${host}:${f.app.config.sshPort}/${path}`,
    ]);
  return facts;
}
