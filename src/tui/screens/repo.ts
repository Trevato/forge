/**
 * A repository's front door: what it is, what is in it, and how to get it.
 *
 * Everything else about the repo is one key away from here, which is why the
 * about card carries the clone URLs — the single most-copied string on any
 * forge page, and the one thing a terminal can hand over without a mouse.
 */

import { pinRepo, syncRepoNow, unpinRepo } from "../../actions/origins.ts";
import { isPinned } from "../../core/pins.ts";
import { canAdmin, type Repo } from "../../core/repos.ts";
import { blobForRender, listTree, type TreeEntry } from "../../git/read.ts";
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
import { blobScreen, treeScreen } from "./tree.ts";
import { forkScreen } from "./newrepo.ts";
import { ownerScreen } from "./owner.ts";
import { refPickerScreen } from "./refs.ts";
import { settingsScreen } from "./settings.ts";

const README_NAMES = ["README.md", "readme.md", "README", "Readme.md"];
const MAX_README = 256 * 1024;

export function repoScreen(
  f: Session,
  ctx: Ctx,
  repo: Repo,
  ref = repo.defaultBranch,
): Screen {
  let entries: TreeEntry[] = [];
  let readme: Span[][] = [];
  let readmePath = "";
  let readmeSource = "";
  let width = 0;
  let pinned = false;
  const state = new ListState();
  const scroll = new Scroll();
  const admin = (): boolean => canAdmin(f.db, repo, f.user);
  const readPin = (): void => {
    pinned = f.user !== undefined && isPinned(f.db, f.user.id, repo.id);
  };

  const reload = async (): Promise<void> => {
    readPin();
    const tree = await listTree(f.dir(repo), ref, "");
    entries = tree.ok ? tree.value : [];
    readmeSource = "";
    readmePath = "";
    const found = entries.find(
      (e) => e.type === "blob" && README_NAMES.includes(e.name),
    );
    if (found) {
      const blob = await blobForRender(
        f.dir(repo),
        ref,
        found.name,
        MAX_README,
      );
      if (blob.kind === "text") {
        readmeSource = new TextDecoder().decode(blob.body);
        readmePath = found.name;
      }
    }
    width = 0;
    ctx.invalidate();
  };

  const screen: Screen = {
    title: `${repo.ownerName}/${repo.name}`,
    get keys() {
      return [
        binding(["enter"], "open"),
        binding(["i"], "issues"),
        binding(["p"], "pulls"),
        binding(["c"], "commits"),
        binding(["b"], "ref"),
        // `p` is pulls on this screen and has been since before pins
        // existed, so the toggle takes the shifted key here. Everywhere a
        // repo is a *row* — explore, the dashboard — plain `p` is free and
        // is what pins it.
        binding(["P"], pinned ? "unpin" : "pin", { disabled: !f.signedIn }),
        binding(["y"], "sync now", {
          disabled: repo.origin === null || !admin(),
        }),
        binding(["F"], "fork", { disabled: !f.signedIn }),
        binding([","], "settings", {
          disabled: !canAdmin(f.db, repo, f.user),
        }),
        binding(["r"], "refresh"),
      ];
    },
    load: reload,
    render(area, s) {
      const c = ctx.theme.c;
      const facts = originFacts(repo);
      const [about, body] = split(area, "v", [len(6 + facts.length), fill(1)]);
      const inner = card(s, about!, c, {
        title: `${repo.ownerName}/${repo.name}`,
        footer: ref,
      });
      // One inset for the whole card. A chip carries its own left pad, so the
      // badges sit a column earlier and every line of text — badge label,
      // description, clone URLs, and the card's own title — starts here.
      const lead = inner.x + 1;
      const edge = inner.x + inner.w;
      let x = badge(s, inner.x, inner.y, c, {
        text: repo.visibility,
        variant: repo.visibility === "public" ? "success" : "secondary",
      });
      if (repo.protectDefault)
        x = badge(s, x + 1, inner.y, c, {
          text: "protected",
          variant: "attn",
        });
      if (repo.forkParentId !== null)
        x = badge(s, x + 1, inner.y, c, { text: "fork", variant: "outline" });
      if (repo.origin !== null)
        x = badge(s, x + 1, inner.y, c, { text: "mirror", variant: "attn" });
      if (pinned)
        badge(s, x + 1, inner.y, c, {
          text: `${PIN_MARK} on your machine`,
          variant: "outline",
        });
      s.text(
        lead,
        inner.y + 1,
        truncate(
          repo.description === "" ? "No description." : repo.description,
          Math.max(0, edge - lead),
        ),
        style(repo.description === "" ? c.faint : c.fg, c.card),
        edge,
      );
      drawFacts(
        s,
        {
          x: lead,
          y: inner.y + 2,
          w: Math.max(0, edge - lead),
          h: 2 + facts.length,
        },
        c,
        [...facts, ...cloneFacts(f, repo)],
      );

      const [left, right] = ctx.twoPane
        ? split(body!, "h", [len(34), fill(1)])
        : [body!, undefined];
      if (entries.length === 0)
        emptyState(s, left!, c, {
          title: "Empty repository",
          body: "Push a branch to get started.",
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
          title: "No README",
          body: "Add a README.md and it shows up here.",
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
            ? treeScreen(f, ctx, repo, ref, entry.name)
            : blobScreen(f, ctx, repo, ref, entry.name),
        );
        return true;
      }
      if (e.key === "f") {
        ctx.push(treeScreen(f, ctx, repo, ref));
        return true;
      }
      if (e.key === "i") {
        ctx.push(issuesScreen(f, ctx, repo, "issue"));
        return true;
      }
      if (e.key === "p") {
        ctx.push(issuesScreen(f, ctx, repo, "pull"));
        return true;
      }
      if (e.key === "c") {
        ctx.push(commitsScreen(f, ctx, repo, ref));
        return true;
      }
      if (e.key === "o") {
        ctx.push(ownerScreen(f, ctx, repo.ownerName));
        return true;
      }
      if (e.key === "b") {
        ctx.push(
          refPickerScreen(f, ctx, screen, repo, (chosen) =>
            ctx.replace(repoScreen(f, ctx, repo, chosen)),
          ),
        );
        return true;
      }
      if (e.key === "P" && f.user) {
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
      if (e.key === "y" && repo.origin !== null && admin()) {
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
      if (e.key === "F" && f.signedIn) {
        ctx.push(forkScreen(f, ctx, repo));
        return true;
      }
      if (e.key === "," && canAdmin(f.db, repo, f.user)) {
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
 * Where a mirror came from and when it was last fetched — one line, because
 * that is the whole of what a reader needs before they trust what is on the
 * screen. A native repo has no such line rather than an empty one.
 */
function originFacts(repo: Repo): [string, string][] {
  const origin = repo.origin;
  if (origin === null) return [];
  const host = URL.parse(origin.htmlUrl)?.host ?? "";
  const fetched =
    origin.lastFetchAt === null ? "never fetched" : `fetched ${ago(origin.lastFetchAt)}`;
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
