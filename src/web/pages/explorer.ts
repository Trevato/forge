/**
 * The file explorer: the column that stays open while you read code.
 *
 * The complaint this answers is a small one that ruins a whole afternoon —
 * you open a file, the tree disappears, and every next file costs a trip back
 * up. So tree and blob pages share one layout: the directory you are standing
 * in on the left, permanently, and the content on the right.
 *
 * Three rules keep it honest.
 *
 * - **It works with no script at all.** Every directory is a `<details>`; the
 *   ancestors of the path you asked for arrive open, with their siblings, so
 *   the column is already useful before a byte of JavaScript runs. A folder
 *   you open that the server did not expand shows one link to its own page —
 *   one extra click without JS, none with, and never a dead control.
 * - **The spine, not the tree.** A page renders the path's ancestors and their
 *   siblings — never the whole repository — so a monorepo costs the same
 *   markup as a toy. Depth is capped; `source.tree` is asked once per level,
 *   all levels in parallel.
 * - **One layout, both worlds.** It takes a `RepoScope`, so a repository we
 *   hold and one we are reading live off another forge get the same column
 *   with the same URLs underneath.
 */

import type { TreeEntry } from "../../git/read.ts";
import type { RepoSource } from "../../view/source.ts";
import { html, raw, when, type Html } from "../html.ts";
import { icon } from "../icons.ts";
import type { RepoScope } from "../scope.ts";

/** How deep the expanded spine goes. Past it, the column stops expanding. */
export const MAX_EXPLORER_DEPTH = 12;

export interface ExplorerLevel {
  /** "" for the repository root. */
  readonly path: string;
  readonly entries: readonly TreeEntry[];
}

export interface ExplorerData {
  readonly ref: string;
  /** The root, then each ancestor directory of `current`, in order. */
  readonly levels: readonly ExplorerLevel[];
  /** The path being read — a file, or the directory being listed. */
  readonly current: string;
  readonly currentIsFile: boolean;
}

/** The directories to expand for a path: the root, then every ancestor. */
export function spineOf(path: string, isFile: boolean): string[] {
  const parts = path === "" ? [] : path.split("/");
  const dirs = isFile ? parts.slice(0, -1) : parts;
  const spine = [""];
  for (let i = 0; i < Math.min(dirs.length, MAX_EXPLORER_DEPTH); i++) {
    spine.push(dirs.slice(0, i + 1).join("/"));
  }
  return spine;
}

/**
 * Read every level of the spine at once. A level the source refuses (a path
 * that vanished between the two reads) contributes an empty list rather than
 * failing the page — the column is navigation, not the content.
 */
export async function loadExplorer(
  source: RepoSource,
  ref: string,
  path: string,
  isFile: boolean,
): Promise<ExplorerData> {
  const spine = spineOf(path, isFile);
  const read = await Promise.all(spine.map((dir) => source.tree(ref, dir)));
  return {
    ref,
    current: path,
    currentIsFile: isFile,
    levels: spine.map((dir, i) => ({
      path: dir,
      entries: read[i]?.ok === true ? read[i]!.value : [],
    })),
  };
}

/** The most entries a directory page lists before it links to the rest. */
export const TREE_WINDOW = 300;

/** The side column is navigation, not the listing: it keeps fewer rows per directory. */
export const COLUMN_WINDOW = 100;

/** Directories first, then files, the first TREE_WINDOW of them. */
export function treeWindow(
  entries: readonly TreeEntry[],
  limit = TREE_WINDOW,
): TreeEntry[] {
  const dirs = entries.filter((e) => e.type === "tree");
  const rest = entries.filter((e) => e.type !== "tree");
  return [...dirs, ...rest].slice(0, limit);
}

/** Directories first, then files, each alphabetical — a readable column. */
function ordered(entries: readonly TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) =>
    a.type === b.type
      ? a.name.localeCompare(b.name)
      : a.type === "tree"
        ? -1
        : 1,
  );
}

const join = (dir: string, name: string): string =>
  dir === "" ? name : `${dir}/${name}`;

/**
 * One directory's rows. `at` indexes into the spine: a child directory that
 * is the next spine entry is rendered open with its own rows beneath it;
 * every other directory is closed, and carries the one link that makes it
 * reachable without a script.
 */
function levelList(data: ExplorerData, base: string, at: number): Html {
  const level = data.levels[at];
  if (level === undefined) return html``;
  const encoded = encodeURIComponent(data.ref);
  const next = data.levels[at + 1];
  const shown = treeWindow(ordered(level.entries), COLUMN_WINDOW);
  const hidden = level.entries.length - shown.length;
  const rows = shown.map((entry) => {
    const path = join(level.path, entry.name);
    if (entry.type === "tree") {
      const open = next !== undefined && next.path === path;
      const current = !data.currentIsFile && data.current === path;
      return html`<li>
        <details
          class="ex-dir"
          data-path="${path}"
          data-url="${`${base}/tree/${encoded}/${path}`}"
          ${open ? raw("open") : null}
        >
          <summary ${current ? raw('data-current=""') : null}>
            ${icon("chevronRight")}<span class="truncate">${entry.name}</span>
          </summary>
          ${open
            ? levelList(data, base, at + 1)
            : html`<ul data-stub>
                <li>
                  <a class="ex-more" href="${`${base}/tree/${encoded}/${path}`}"
                    >${icon("folder")}Open ${entry.name}/</a
                  >
                </li>
              </ul>`}
        </details>
      </li>`;
    }
    const current = data.currentIsFile && data.current === path;
    return html`<li>
      <a
        class="ex-file"
        data-ex-file
        data-nav
        tabindex="-1"
        href="${`${base}/blob/${encoded}/${path}`}"
        ${current ? raw('aria-current="page"') : null}
        title="${path}"
        >${icon("file")}<span class="truncate">${entry.name}</span></a
      >
    </li>`;
  });
  return html`<ul>
    ${rows.length === 0
      ? html`<li><span class="muted small">empty</span></li>`
      : rows}
    ${hidden > 0
      ? html`<li>
          <a
            class="ex-more"
            href="${`${base}/tree/${encoded}${level.path === "" ? "" : `/${level.path}`}?all=1`}"
            >Show all ${level.entries.length.toLocaleString("en-US")} entries</a
          >
        </li>`
      : null}
  </ul>`;
}

/**
 * A directory's rows on their own, for the lazy expansion of a folder the
 * server did not put on the spine. Same markup as a level inside the column,
 * so the script can drop it straight in.
 */
export function explorerFragment(
  base: string,
  ref: string,
  path: string,
  entries: readonly TreeEntry[],
): Html {
  return levelList(
    {
      ref,
      current: path,
      currentIsFile: false,
      levels: [{ path, entries }],
    },
    base,
    0,
  );
}

export interface ExplorerColumnOptions {
  /** Offer the fuzzy finder button (needs the paths route). */
  finder?: boolean;
  /** The "New file" affordance, when the viewer may write. */
  actions?: Html;
}

/**
 * The column itself.
 *
 * One `<details>`, two shapes. Below 900px it is the "Files" drawer above the
 * content, closed until you want it. Above 900px the stylesheet forces its
 * content visible (`::details-content`) and hides the handle, so it is simply
 * the column — and in a browser too old for that rule the handle stays, and
 * one click opens it. No state, no script, and nothing that can end up
 * invisible with no way back.
 */
export function explorerColumn(
  scope: RepoScope,
  data: ExplorerData,
  o: ExplorerColumnOptions = {},
): Html {
  const base = scope.base;
  return html`<details class="explorer-panel">
    <summary>
      ${icon("folder")}<span class="grow">Files</span>
      <span class="mono muted small">${data.ref}</span>
    </summary>
    <nav class="explorer" aria-label="Files" data-current="${data.current}">
      <div>
        ${when(o.finder === true, () => finderButton())}${o.actions ?? null}
      </div>
      ${levelList(data, base, 0)}
    </nav>
  </details>`;
}

/**
 * What the code script reads its configuration from: which repository, which
 * ref, and where the path list lives. A data element rather than interpolated
 * script text, because the CSP forbids the latter and this is greppable.
 */
export function codeMount(
  scope: RepoScope,
  ref: string,
  o: { finder?: boolean } = {},
): Html {
  const encoded = encodeURIComponent(ref);
  return html`<div
    id="code"
    hidden
    data-base="${scope.base}"
    data-ref="${ref}"
    data-paths="${o.finder === false ? "" : `${scope.base}/paths/${encoded}`}"
  ></div>`;
}

/** The control that opens the finder. It needs a script, so it says so. */
export function finderButton(): Html {
  return html`<button
    class="btn js-only"
    data-size="sm"
    data-variant="outline"
    type="button"
    data-finder
    data-shortcut="t"
    title="Go to file"
  >
    ${icon("search")}<span class="grow">Go to file</span><kbd>t</kbd>
  </button>`;
}

/**
 * The finder dialog. Empty markup: the rows are built from the path list the
 * script fetches, as DOM nodes, never as interpolated HTML. Without a script
 * the dialog never opens and the explorer beside it is the answer.
 */
export function finderDialog(): Html {
  return html`<dialog
    class="dialog palette finder"
    id="finder"
    role="dialog"
    aria-modal="true"
    aria-label="Go to file"
  >
    <input
      class="input palette-input"
      type="text"
      placeholder="Go to file…"
      aria-label="Go to file"
      autocomplete="off"
      spellcheck="false"
    />
    <div class="palette-list" role="listbox" aria-label="Files"></div>
    <div class="palette-foot">
      <span class="muted small num"></span><span class="spacer"></span> <kbd>↑</kbd
      ><kbd>↓</kbd> navigate <kbd>↵</kbd> open <kbd>esc</kbd> close
    </div>
  </dialog>`;
}

/** Where the explorer column starts, and how narrow either side may go. */
export const SPLIT = { min: 200, start: 300, minMain: 480 } as const;

/**
 * The two-column frame. The explorer is first in the DOM because that is
 * also the reading order and the tab order; the grid puts it on the left
 * above 900px and above the content below it.
 *
 * Between the two sits one divider. It is a real ARIA separator — focusable,
 * with a value in pixels — so the width can be dragged with a pointer or
 * nudged with the arrow keys, and it is invisible until a script arrives:
 * without one the columns keep the stylesheet's width and nothing is lost.
 */
export function codeLayout(explorer: Html, content: Html): Html {
  return html`<div class="code-layout">
    ${explorer}
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the file tree"
      aria-valuemin="${SPLIT.min}"
      aria-valuenow="${SPLIT.start}"
      tabindex="0"
      title="Drag to resize · double-click to reset"
      data-split
    ></div>
    <div id="code-main">${content}</div>
  </div>`;
}
