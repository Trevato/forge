/**
 * Browsing code: a persistent explorer on the left, the file under the cursor
 * on the right, loading as you move.
 *
 * The old screens were a stack — a directory, then another directory, then a
 * blob, with `esc` to climb back. That is the file system's model, not a
 * reader's. A reader moves down a list and wants to *see* what each thing is;
 * they open the explorer while reading a file, not instead of it. So this is
 * one screen with two panes and a focus, and the whole navigation model is:
 * the cursor moves, the preview follows, `tab` decides who gets the keys.
 *
 * The load discipline is the part worth reading. Moving the cursor schedules a
 * read 60ms out rather than firing one per keystroke; a held `j` down a
 * thousand-file tree therefore costs one read, not a thousand. Every read
 * carries a token, and a read whose token is stale when it lands is dropped on
 * the floor — so a slow origin answering for a file you have already moved off
 * cannot paint over the file you are looking at now. The screen's own
 * `AbortSignal` is the outer bound: popping the screen ends every one of them.
 *
 * Below 100 columns there is no room for two panes, so there is one: `tab`
 * and `esc` swap between them, and the file pane takes the full width.
 */

import type { RepoSource } from "../../view/source.ts";
import type { TreeEntry } from "../../git/read.ts";
import { detectLanguage, highlightLines } from "../../web/highlight.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding, type Binding } from "../app/keys.ts";
import type { KeyEvent } from "../term/input.ts";
import {
  G,
  type Rect,
  type Screen as Surface,
  type Span,
} from "../term/screen.ts";
import { BOLD, style } from "../term/style.ts";
import { expandTabs, pad, truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { emptyState, scrollbar } from "../ui/widgets.ts";
import type { Tokens } from "../ui/theme.ts";
import type { Session } from "../session.ts";
import { editFiles } from "../../actions/contents.ts";
import {
  Filter,
  ListState,
  Scroll,
  confirmScreen,
  errorText,
  openLink,
  runAsync,
  slug,
} from "./common.ts";
import { commitScreen } from "./commit.ts";
import { editorScreen, newFileScreen, openSaved } from "./editor.ts";
import { externalEditor, editorHint, hasExternalEditor } from "./external.ts";
import { finderScreen } from "./finder.ts";
import { refPickerScreen } from "./refs.ts";
import {
  localRepo,
  originFileUrl,
  otherSide,
  otherSideLabel,
  sourceName,
  whereRows,
  whereStrip,
} from "./where.ts";

/** How long the cursor must rest before the file under it is read. */
const PREVIEW_DEBOUNCE_MS = 60;
/** Files kept in the per-screen cache; a browse revisits the same few. */
const CACHE_LIMIT = 24;

export function formatSize(bytes: number): string {
  if (bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} K`;
  return `${(bytes / 1024 / 1024).toFixed(1)} M`;
}

// ---- the explorer's model ----

interface Node {
  readonly path: string;
  readonly name: string;
  readonly type: "tree" | "blob";
  readonly mode: string;
  readonly size: number;
  readonly depth: number;
  expanded: boolean;
  loading: boolean;
  /** Null until the directory has been listed once. */
  children: Node[] | null;
}

function nodeOf(entry: TreeEntry, parent: string, depth: number): Node {
  return {
    path: parent === "" ? entry.name : `${parent}/${entry.name}`,
    name: entry.name,
    type: entry.type === "tree" ? "tree" : "blob",
    mode: entry.mode,
    size: entry.size,
    depth,
    expanded: false,
    loading: false,
    children: null,
  };
}

/** Depth-first walk of what is currently expanded — the rows on screen. */
function flatten(nodes: readonly Node[], out: Node[] = []): Node[] {
  for (const node of nodes) {
    out.push(node);
    if (node.expanded && node.children !== null) flatten(node.children, out);
  }
  return out;
}

function findNode(nodes: readonly Node[], path: string): Node | undefined {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (path.startsWith(`${node.path}/`) && node.children !== null) {
      const hit = findNode(node.children, path);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

// ---- the file pane ----

/** What a blob turned into: styled rows, plus the plain text behind them. */
export class FileView {
  path = "";
  note = "";
  loading = false;
  plain: string[] = [];
  lines: Span[][] = [];
  /** The raw bytes, kept so `e` can hand the editor exactly what git holds. */
  raw: Uint8Array | null = null;
  editable = false;
  readonly scroll = new Scroll();
  readonly search = new Filter();
  hits: number[] = [];
  hit = 0;

  clear(): void {
    this.path = "";
    this.note = "";
    this.plain = [];
    this.lines = [];
    this.raw = null;
    this.editable = false;
    this.scroll.top = 0;
    this.hits = [];
  }

  findHits(): void {
    const q = this.search.query.toLowerCase();
    this.hits =
      q === ""
        ? []
        : this.plain.flatMap((l, i) =>
            l.toLowerCase().includes(q) ? [i] : [],
          );
    this.hit = 0;
    if (this.hits[0] !== undefined)
      this.scroll.to(this.hits[0], this.plain.length);
  }

  /** Move to the next/previous match; false when there are none. */
  step(delta: number): boolean {
    if (this.hits.length === 0) return false;
    this.hit = (this.hit + delta + this.hits.length) % this.hits.length;
    this.scroll.to(this.hits[this.hit]!, this.plain.length);
    return true;
  }

  render(s: Surface, r: Rect, c: Tokens, focused: boolean): void {
    if (r.w <= 0 || r.h <= 0) return;
    if (this.path === "") {
      emptyState(s, r, c, {
        title: "No file selected",
        body: "Move over a file in the explorer and it loads here.",
      });
      return;
    }
    if (this.note !== "") {
      emptyState(s, r, c, {
        title: this.loading ? "Reading…" : "Not shown",
        body: this.note,
      });
      return;
    }
    const from = this.scroll.window(r.h, this.lines.length);
    const width = Math.max(0, r.w - 1);
    for (let i = 0; i < r.h; i++) {
      const line = this.lines[from + i];
      if (line === undefined) break;
      const isHit = this.hits.includes(from + i);
      s.spans(
        r.x,
        r.y + i,
        isHit
          ? line.map((span) => ({
              ...span,
              style: { ...span.style, bg: c.muted },
            }))
          : line,
        r.x + width,
      );
    }
    scrollbar(s, { x: r.x + r.w - 1, y: r.y, w: 1, h: r.h }, c, {
      total: this.lines.length,
      offset: from,
    });
    if (!focused) return;
    // The focused pane says so with a hairline in the accent, the same rule
    // `card({focused})` follows everywhere else.
    for (let y = r.y; y < r.y + r.h; y++)
      s.set(r.x - 1, y, G.vHeavy, style(c.accent, c.bg));
  }
}

/** Turn a text blob into numbered, syntax-coloured rows. */
export function codeLines(
  text: string,
  path: string,
  c: Tokens,
): { plain: string[]; lines: Span[][] } {
  const body = text.replace(/\n$/, "");
  const plain = body.split("\n").map((l) => expandTabs(l));
  const width = String(plain.length).length;
  const lines = highlightLines(plain.join("\n"), detectLanguage(path)).map(
    (tokens, i): Span[] => [
      {
        text: `${pad(String(i + 1), width, "right")} `,
        style: style(c.faint, c.bg),
      },
      ...tokens.map((t) => ({
        text: t.text,
        style: style(c.tok[t.cls], c.bg),
      })),
    ],
  );
  return { plain, lines };
}

// ---- the screen ----

export interface CodeScreenOptions {
  /** Start with this file open (and its ancestors expanded). */
  readonly path?: string;
  /** Which pane has the keys on arrival. @default "explorer" */
  readonly focus?: "explorer" | "file";
}

export function codeScreen(
  f: Session,
  ctx: Ctx,
  src: RepoSource,
  ref: string,
  o: CodeScreenOptions = {},
): Screen {
  let roots: Node[] = [];
  let loaded = false;
  let focus: "explorer" | "file" = o.focus ?? "explorer";
  let want = o.path ?? "";
  const state = new ListState();
  const filter = new Filter();
  const view = new FileView();
  /** Superseded reads land with a stale token and are dropped. */
  let token = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Settles the tracked promise of a debounce that is being cancelled. */
  let settlePreview: (() => void) | null = null;
  let signal: AbortSignal | undefined;
  const cache = new Map<string, { note: string; raw: Uint8Array | null }>();

  const rows = (): Node[] => {
    const all = flatten(roots);
    if (!filter.on) return all;
    // Filtering a tree that is only partly loaded can only honestly filter
    // what is on screen; the finder (`t`) is the answer for the whole tree.
    return all.filter((n) => filter.matches(n.name));
  };

  const listDir = async (path: string): Promise<Node[]> => {
    const result = await src.tree(ref, path);
    if (!result.ok) {
      ctx.toast(
        `cannot read ${path || "/"}: ${errorText(result.error)}`,
        "danger",
      );
      return [];
    }
    const depth = path === "" ? 0 : path.split("/").length;
    return result.value.map((entry) => nodeOf(entry, path, depth));
  };

  const expand = async (node: Node): Promise<void> => {
    if (node.children !== null) {
      node.expanded = true;
      ctx.invalidate();
      return;
    }
    node.loading = true;
    ctx.invalidate();
    node.children = await listDir(node.path);
    node.loading = false;
    node.expanded = true;
    ctx.invalidate();
  };

  /**
   * Expand every directory above `path` so it becomes a visible row, and put
   * the cursor on it. A trailing slash means "this is itself a directory" —
   * which is how `treeScreen` says "open here" rather than "open this file".
   */
  const reveal = async (path: string): Promise<void> => {
    const isDir = path.endsWith("/");
    const target = isDir ? path.slice(0, -1) : path;
    if (target === "") return;
    const parts = target.split("/");
    const depth = isDir ? parts.length : parts.length - 1;
    let here = "";
    for (let i = 0; i < depth; i++) {
      here = here === "" ? parts[i]! : `${here}/${parts[i]!}`;
      const node = findNode(roots, here);
      if (node === undefined || node.type !== "tree") return;
      await expand(node);
    }
    const index = flatten(roots).findIndex((n) => n.path === target);
    if (index >= 0) state.index = index;
  };

  const readBlob = async (path: string, mine: number): Promise<void> => {
    const cached = cache.get(path);
    if (cached === undefined) {
      view.loading = true;
      view.note = `Reading ${path}`;
      ctx.invalidate();
      const read = await src.blob(ref, path);
      if (mine !== token || signal?.aborted === true) return;
      let note = "";
      let raw: Uint8Array | null = null;
      if (!read.ok)
        note =
          read.error === "not_found"
            ? "No such file at this revision."
            : errorText(read.error);
      else if (read.value.kind === "too_large")
        note = `${formatSize(read.value.size)} — too large to display.`;
      else if (read.value.kind === "binary")
        note = `Binary file, ${formatSize(read.value.size)}.`;
      else raw = read.value.body;
      cache.set(path, { note, raw });
      // A bounded cache, oldest out: a browse revisits the same handful of
      // files, and an unbounded one would hold a whole tree in memory.
      if (cache.size > CACHE_LIMIT) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
    }
    if (mine !== token || signal?.aborted === true) return;
    const entry = cache.get(path)!;
    view.loading = false;
    view.path = path;
    view.note = entry.note;
    view.raw = entry.raw;
    view.editable = entry.raw !== null && src.capabilities.write;
    view.scroll.top = 0;
    view.hits = [];
    if (entry.raw === null) {
      view.plain = [];
      view.lines = [];
    } else {
      const decoded = new TextDecoder().decode(entry.raw);
      const built = codeLines(decoded, path, ctx.theme.c);
      view.plain = built.plain;
      view.lines = built.lines;
      if (view.search.query !== "") view.findHits();
    }
    ctx.invalidate();
  };

  /** The cursor moved: schedule a read, cancelling whatever was pending. */
  const schedule = (immediate = false): void => {
    const node = rows()[state.index];
    if (timer !== null) clearTimeout(timer);
    timer = null;
    // A superseded wait still has to settle its tracked promise, or the app
    // stays busy forever on a cursor that kept moving.
    settlePreview?.();
    settlePreview = null;
    if (node === undefined || node.type !== "blob") return;
    if (node.path === view.path && view.raw !== null) return;
    const mine = ++token;
    const path = node.path;
    // The wait *and* the read are one tracked promise. Tracking only the read
    // would leave a 60ms hole in which the app calls itself settled while a
    // preview is on its way — a flaky test, and a screen that flashes "no
    // file selected" between two keystrokes.
    void ctx
      .track(
        new Promise<void>((resolve) => {
          settlePreview = resolve;
          const run = (): void => {
            timer = null;
            settlePreview = null;
            void readBlob(path, mine).finally(resolve);
          };
          if (immediate) run();
          else timer = setTimeout(run, PREVIEW_DEBOUNCE_MS);
        }),
      )
      .catch(() => undefined);
  };

  const reload = async (): Promise<void> => {
    cache.clear();
    roots = await listDir("");
    loaded = true;
    if (want !== "") {
      await reveal(want);
      const node = findNode(roots, want.replace(/\/$/, ""));
      if (node?.type === "blob") {
        if (o.focus === "file") focus = "file";
        schedule(true);
      }
      want = "";
    } else schedule(true);
    ctx.invalidate();
  };

  const current = (): Node | undefined => rows()[state.index];

  const openEditor = (
    path: string,
    body: Uint8Array,
    creating = false,
  ): void => {
    ctx.push(
      editorScreen(f, ctx, src, {
        ref,
        path,
        body,
        ...(creating ? { creating: true } : {}),
        onSaved: () => {
          cache.delete(path);
          runAsync(ctx, async () => {
            const mine = ++token;
            await readBlob(path, mine);
          });
        },
      }),
    );
  };

  const edit = (): boolean => {
    const node = current();
    const path = node?.type === "blob" ? node.path : view.path;
    if (path === "") return true;
    if (!src.capabilities.write) {
      ctx.toast(
        "this browse is read-only — W opens the workbench copy",
        "attn",
      );
      return true;
    }
    const entry = cache.get(path);
    if (entry?.raw == null) {
      ctx.toast("that file is not editable here", "attn");
      return true;
    }
    openEditor(path, entry.raw);
    return true;
  };

  const swap = (): boolean => {
    const other = otherSide(f, src);
    if (other === undefined) {
      ctx.toast("this repository has only one side", "attn");
      return true;
    }
    ctx.replace(
      codeScreen(f, ctx, other, ref, {
        ...(view.path === "" ? {} : { path: view.path }),
        focus,
      }),
    );
    return true;
  };

  const screen: Screen = {
    get title() {
      return view.path === "" ? "Files" : view.path;
    },
    get keys(): Binding[] {
      const other = otherSideLabel(f, src);
      return [
        binding(
          ["tab"],
          focus === "explorer" ? "focus file" : "focus explorer",
        ),
        ...(focus === "explorer"
          ? [
              binding(["l", "enter"], "open"),
              binding(["h"], "collapse"),
              binding(["n"], "new file", { disabled: !src.capabilities.write }),
              binding(["D"], "delete", { disabled: !src.capabilities.write }),
            ]
          : [binding(["/"], "search"), binding(["n", "N"], "next/prev match")]),
        binding(["t", "ctrl+p"], "find file"),
        binding(["e"], "edit", { disabled: !src.capabilities.write }),
        binding(
          ["E"],
          hasExternalEditor() ? "open $FORGE_EDITOR" : "external editor",
        ),
        binding(["y"], "copy path"),
        binding(["b"], "ref"),
        ...(other === undefined ? [] : [binding(["W"], other)]),
        binding(["O"], "open on origin", {
          disabled: originFileUrl(src, ref, view.path) === "",
        }),
        binding(["r"], "refresh"),
      ];
    },
    load(sig) {
      signal = sig;
      sig.addEventListener("abort", () => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        settlePreview?.();
        settlePreview = null;
      });
      return reload();
    },
    render(area, s) {
      const c = ctx.theme.c;
      const [strip, head, body] = split(area, "v", [
        len(whereRows(src)),
        len(1),
        fill(1),
      ]);
      whereStrip(s, strip!, c, f, src);
      // The breadcrumb, always the same three parts, so a reader never has to
      // hunt for which repository and which revision they are looking at.
      const right = head!.x + head!.w;
      let x = s.text(
        head!.x,
        head!.y,
        truncate(sourceName(src), Math.max(0, head!.w - 8)),
        style(c.fg, c.bg, BOLD),
        right,
      );
      x = s.text(x, head!.y, ` ${G.chevron} `, style(c.faint, c.bg), right);
      x = s.text(
        x,
        head!.y,
        truncate(ref, Math.max(0, right - x)),
        style(c.accent, c.bg),
        right,
      );
      if (view.path !== "") {
        x = s.text(x, head!.y, ` ${G.chevron} `, style(c.faint, c.bg), right);
        s.text(
          x,
          head!.y,
          truncate(view.path, Math.max(0, right - x)),
          style(c.mutedFg, c.bg),
          right,
        );
      }

      const wide = ctx.twoPane;
      const [leftArea, rightArea] = wide
        ? split(body!, "h", [
            len(Math.min(38, Math.max(24, body!.w >> 2))),
            fill(1),
          ])
        : focus === "explorer"
          ? [body!, undefined]
          : [undefined, body!];

      if (leftArea !== undefined) {
        const [box, list] = split(leftArea, "v", [len(1), fill(1)]);
        const caret = filter.render(s, box!, c, "filter this level");
        if (focus === "explorer") ctx.setCursor(caret);
        drawTree(s, list!, c, state, rows(), {
          focused: focus === "explorer",
          currentPath: view.path,
          empty: loaded ? "Empty repository" : "Reading…",
        });
      }
      if (rightArea === undefined) return;
      // One column of air between the two panes, which is also where the
      // focus hairline goes — `card({focused})`'s rule, one pane over.
      const fileArea = wide
        ? { ...rightArea, x: rightArea.x + 1, w: Math.max(1, rightArea.w - 1) }
        : rightArea;
      const [searchBox, pane] = split(fileArea, "v", [len(1), fill(1)]);
      if (view.search.on || view.search.active) {
        const caret = view.search.render(s, searchBox!, c, "search in file");
        if (focus === "file") ctx.setCursor(caret);
      } else {
        const note =
          view.path === ""
            ? ""
            : view.note !== ""
              ? ""
              : `${view.plain.length} lines${view.editable ? "" : " · read-only"}`;
        s.text(
          searchBox!.x + 1,
          searchBox!.y,
          truncate(note, Math.max(0, searchBox!.w - 1)),
          style(c.faint, c.bg),
          searchBox!.x + searchBox!.w,
        );
      }
      view.render(s, pane!, c, wide && focus === "file");
    },
    key(e) {
      // The file pane's own find box eats everything while it is open.
      if (focus === "file" && view.search.active) {
        const handled = view.search.key(e);
        if (handled) view.findHits();
        return handled;
      }
      if (focus === "explorer" && filter.active) {
        const handled = filter.key(e);
        if (handled) {
          state.clamp(rows().length);
          schedule();
        }
        return handled;
      }

      if (e.key === "tab") {
        focus = focus === "explorer" ? "file" : "explorer";
        return true;
      }
      if (e.key === "esc" && focus === "file") {
        focus = "explorer";
        return true;
      }
      if ((e.key === "t" && !e.ctrl) || (e.ctrl && e.key === "p")) {
        ctx.push(
          finderScreen(f, ctx, screen, src, ref, (path) => {
            want = path;
            focus = "file";
            runAsync(ctx, async () => {
              await reveal(path);
              schedule(true);
            });
          }),
        );
        return true;
      }
      if (e.key === "y") {
        const node = current();
        const path = focus === "file" ? view.path : (node?.path ?? "");
        if (path === "") return true;
        ctx.copy(path);
        ctx.toast(`copied ${path}`, "success");
        return true;
      }
      if (e.key === "b") {
        ctx.push(
          refPickerScreen(f, ctx, screen, src, (chosen) =>
            ctx.replace(
              codeScreen(f, ctx, src, chosen, {
                ...(view.path === "" ? {} : { path: view.path }),
                focus,
              }),
            ),
          ),
        );
        return true;
      }
      if (e.key === "W") return swap();
      if (e.key === "O") {
        const url = originFileUrl(src, ref, view.path);
        if (url === "") {
          ctx.toast("this repository has no origin page", "attn");
          return true;
        }
        openLink(ctx, url);
        return true;
      }
      if (e.key === "e") return edit();
      if (e.key === "E") {
        // Three different "no" answers, because they need three different
        // fixes: the feature is off, nothing is selected, or the bytes are
        // not text. Saying `editorHint()` to all of them would be a lie to
        // two thirds of the people who press this.
        if (!hasExternalEditor()) {
          ctx.toast(editorHint(), "attn");
          return true;
        }
        const path = focus === "file" ? view.path : (current()?.path ?? "");
        const entry = path === "" ? undefined : cache.get(path);
        if (entry?.raw == null) {
          ctx.toast(
            path === "" ? "no file selected" : "that file is not text",
            "attn",
          );
          return true;
        }
        externalEditor(f, ctx, {
          path,
          body: entry.raw,
          onEdited: (bytes) => openSaved(f, ctx, src, ref, path, bytes),
          ...(signal === undefined ? {} : { signal }),
        });
        return true;
      }
      if (e.key === "r") {
        runAsync(ctx, reload);
        return true;
      }

      if (focus === "file") return fileKey(view, e);

      const list = rows();
      const before = state.index;
      if (state.key(e, list.length)) {
        if (state.index !== before) schedule();
        return true;
      }
      const node = list[state.index];
      if (e.key === "/") {
        filter.open();
        return true;
      }
      if (e.key === "l" || e.key === "right" || e.key === "enter") {
        if (node === undefined) return true;
        if (node.type === "tree") {
          if (node.expanded) node.expanded = false;
          else runAsync(ctx, () => expand(node));
          return true;
        }
        // A file under the cursor is already loading; enter means "I want the
        // keys over there", which is the only thing left to say about it.
        schedule(true);
        focus = "file";
        return true;
      }
      if (e.key === "h" || e.key === "left") {
        if (node === undefined) return true;
        if (node.type === "tree" && node.expanded) {
          node.expanded = false;
          return true;
        }
        const parent = node.path.slice(0, node.path.lastIndexOf("/"));
        if (parent === "") return true;
        const index = flatten(roots).findIndex((n) => n.path === parent);
        if (index >= 0) {
          state.index = index;
          schedule();
        }
        return true;
      }
      if (e.key === "n" && src.capabilities.write) {
        const node2 = list[state.index];
        const dir =
          node2 === undefined
            ? ""
            : node2.type === "tree"
              ? node2.path
              : node2.path.slice(0, node2.path.lastIndexOf("/"));
        ctx.push(
          newFileScreen(f, ctx, screen, src, ref, dir, (path, body) => {
            openEditor(path, body, true);
          }),
        );
        return true;
      }
      if (e.key === "D" && src.capabilities.write) {
        const node3 = list[state.index];
        if (node3 === undefined || node3.type !== "blob") {
          ctx.toast("only files can be deleted here", "attn");
          return true;
        }
        ctx.push(
          deleteFileScreen(f, ctx, screen, src, ref, node3.path, () => {
            runAsync(ctx, reload);
          }),
        );
        return true;
      }
      return false;
    },
  };
  return screen;
}

/** The keys the file pane owns; separated so both panes stay readable. */
function fileKey(view: FileView, e: KeyEvent): boolean {
  if (e.key === "/") {
    view.search.open();
    return true;
  }
  if (e.key === "n" && !e.ctrl) return view.step(1);
  if (e.key === "N") return view.step(-1);
  return view.scroll.key(e, view.lines.length);
}

interface TreeDrawOpts {
  readonly focused: boolean;
  readonly currentPath: string;
  readonly empty: string;
}

/**
 * The explorer rows. Indentation plus a caret is the entire grammar: a
 * directory shows `▸`/`▾`, a file shows nothing, and the file currently in the
 * pane keeps its accent whether or not the explorer has focus — which is what
 * makes `tab` feel like moving between two views of one thing.
 */
function drawTree(
  s: Surface,
  r: Rect,
  c: Tokens,
  state: ListState,
  nodes: readonly Node[],
  o: TreeDrawOpts,
): void {
  if (r.w <= 0 || r.h <= 0) return;
  if (nodes.length === 0) {
    s.text(
      r.x + 2,
      r.y,
      truncate(o.empty, Math.max(0, r.w - 2)),
      style(c.faint, c.bg),
      r.x + r.w,
    );
    return;
  }
  const from = state.window(r.h, nodes.length);
  const right = r.x + r.w - 1;
  for (let i = 0; i < r.h; i++) {
    const node = nodes[from + i];
    if (node === undefined) break;
    const y = r.y + i;
    const selected = from + i === state.index;
    const bg = selected && o.focused ? c.muted : c.bg;
    s.fill({ x: r.x, y, w: r.w - 1, h: 1 }, " ", style(c.fg, bg));
    let x = r.x + Math.min(node.depth * 2, Math.max(0, r.w - 8));
    const mark =
      node.type === "tree"
        ? node.loading
          ? G.ellipsis
          : node.expanded
            ? G.caretDown
            : G.caretRight
        : " ";
    x = s.text(x, y, `${mark} `, style(c.mutedFg, bg), right);
    const isCurrent = node.type === "blob" && node.path === o.currentPath;
    const label = node.type === "tree" ? `${node.name}/` : node.name;
    const meta = node.type === "blob" ? formatSize(node.size) : "";
    const metaW = meta === "" ? 0 : meta.length + 1;
    s.text(
      x,
      y,
      truncate(label, Math.max(0, right - x - metaW)),
      style(
        isCurrent ? c.accent : node.type === "tree" ? c.fg : c.mutedFg,
        bg,
        isCurrent || selected ? BOLD : 0,
      ),
      right - metaW,
    );
    if (meta !== "")
      s.text(right - meta.length, y, meta, style(c.faint, bg), right);
  }
  scrollbar(s, { x: r.x + r.w - 1, y: r.y, w: 1, h: r.h }, c, {
    total: nodes.length,
    offset: from,
  });
}

/** `D`: confirm, then delete through `editFiles` with a null content. */
function deleteFileScreen(
  f: Session,
  ctx: Ctx,
  parent: Screen,
  src: RepoSource,
  ref: string,
  path: string,
  onDone: () => void,
): Screen {
  return confirmScreen(ctx, parent, {
    title: "Delete file",
    body: [
      `Delete ${path} from ${ref}?`,
      "This is a commit, not a local change.",
    ],
    actions: [
      { label: "Cancel", variant: "ghost" },
      { label: "Delete", variant: "danger" },
    ],
    selected: 0,
    onChoose: (index) => {
      if (index !== 1) return;
      const repo = localRepo(src);
      if (repo === undefined) {
        ctx.toast("this browse is read-only", "danger");
        return;
      }
      ctx.push(
        commitScreen(f, ctx, parent, {
          repo,
          branch: ref,
          title: "Delete file",
          subject: `Delete ${path}`,
          defaultBranchName: `${f.user?.username ?? "edit"}/delete-${slug(path)}`,
          commit: async (plan) =>
            editFiles(f.app, f.user, repo, {
              ...(plan.newBranch === undefined
                ? { branch: ref }
                : { branch: ref, base: ref, newBranch: plan.newBranch }),
              message: plan.message,
              files: [{ path, content: null }],
              ...(plan.pull === undefined ? {} : { openPull: plan.pull }),
            }),
          onDone,
        }),
      );
    },
  });
}
