/**
 * The terminal design system's docs page: every widget, every variant, the
 * editor, markdown, a diff, a dialog, the palette and the theme cycler — all
 * driven by the real app loop, so what you see here is what a forge screen
 * gets. Run it with `bun run src/tui/gallery.ts`.
 *
 * The rules it holds itself to are the rules every screen should: one cell of
 * padding, hairline borders in `border`, metadata in `mutedFg`, accent only
 * for focus and interaction, semantic colour only for meaning, no emoji.
 */

import { parseUnifiedDiff } from "../git/diff.ts";
import { App, type Ctx, type Screen } from "./app/app.ts";
import { binding, type Binding } from "./app/keys.ts";
import type { Command } from "./app/palette.ts";
import type { KeyEvent } from "./term/input.ts";
import { G, Screen as Surface, type Rect } from "./term/screen.ts";
import { BOLD, style } from "./term/style.ts";
import { headlessTerminal, stdioTerminal } from "./term/terminal.ts";
import { renderFileDiff } from "./ui/diff.ts";
import { fill, len, split, inset } from "./ui/layout.ts";
import { renderMarkdown } from "./ui/markdown.ts";
import { Textarea } from "./ui/textarea.ts";
import { plural } from "./screens/common.ts";
import type { Tokens } from "./ui/theme.ts";
import {
  avatar,
  badge,
  button,
  card,
  dialog,
  dot,
  emptyState,
  field,
  input,
  kbd,
  labelChip,
  menu,
  pill,
  row,
  scrollbar,
  segmented,
  spanLine,
  spinner,
  table,
  tabs,
  timelineItem,
  type Tone,
} from "./ui/widgets.ts";

const SAMPLE_MD = `# Terminal design system

A **markdown** renderer that shares its *meaning* with the web surface, so a
README reads the same in both. Inline \`code\` gets the string colour, and a
[link](https://forge.example/docs) is accent plus underline.

> Backgrounds carry add/delete. Foregrounds carry syntax.

- Grapheme-correct widths
- One tokenizer for width, wrap and truncate
- ${"Synchronized output on every frame"}

1. Draw into the cell buffer
2. Diff against the previous frame
3. Emit the minimum

\`\`\`ts
export function displayWidth(s: string): number {
  if (isAscii(s)) return s.length; // the 95% case
  return [...graphemes(s)].reduce((w, g) => w + clusterWidth(g), 0);
}
\`\`\`

---
`;

const SAMPLE_DIFF = `diff --git a/src/tui/term/render.ts b/src/tui/term/render.ts
index 1111111..2222222 100644
--- a/src/tui/term/render.ts
+++ b/src/tui/term/render.ts
@@ -12,9 +12,10 @@ export class Renderer {
   render(next: Screen, cursor: Cursor | null): string {
     const full = this.prev === null;
-    const body = this.paintAll(next);
-    return SYNC_BEGIN + body + SYNC_END;
+    const body = full ? this.paintAll(next) : this.paintDiff(this.prev, next);
+    return SYNC_BEGIN + CURSOR_HIDE + body + SYNC_END;
+    // one frame, one write
   }

   invalidate(): void {
     this.prev = null;
   }
 }
`;

interface Section {
  readonly title: string;
  readonly draw: (r: Rect, s: Surface, c: Tokens, g: GalleryState) => void;
  readonly keys?: Binding[];
}

interface GalleryState {
  tick: number;
  focus: number;
  editor: Textarea;
  showDialog: boolean;
  tab: number;
  seg: number;
  scroll: number;
  setCursor(pos: { x: number; y: number } | null): void;
}

// ---- sections ----

function drawControls(r: Rect, s: Surface, c: Tokens, g: GalleryState): void {
  const [buttons, chips, inputs] = split(r, "v", [len(6), len(6), fill(1)]);
  const bx = card(s, buttons!, c, { title: "button" });
  const variants = [
    "default",
    "secondary",
    "outline",
    "ghost",
    "danger",
    "link",
  ] as const;
  const slots = split(
    bx,
    "h",
    variants.map(() => fill(1)),
  );
  variants.forEach((v, i) => {
    const slot = slots[i];
    if (!slot) return;
    button(s, { ...slot, y: bx.y, h: 1 }, c, {
      label: v,
      variant: v,
      focused: g.focus % variants.length === i,
    });
    button(s, { ...slot, y: bx.y + 2, h: 1 }, c, {
      label: v,
      variant: v,
      disabled: true,
    });
  });

  const cx = card(s, chips!, c, {
    title: "badge · label · avatar · pill · dot",
  });
  let x = cx.x;
  const tones: Tone[] = [
    "default",
    "secondary",
    "outline",
    "success",
    "danger",
    "merged",
    "attn",
  ];
  for (const t of tones)
    x = badge(s, x, cx.y, c, { text: t, variant: t }, cx.x + cx.w) + 1;
  x = cx.x;
  x =
    labelChip(
      s,
      x,
      cx.y + 2,
      c,
      { text: "bug", color: "#d73a4a" },
      cx.x + cx.w,
    ) + 1;
  x =
    labelChip(
      s,
      x,
      cx.y + 2,
      c,
      { text: "good first issue", color: "#7057ff" },
      cx.x + cx.w,
    ) + 1;
  x =
    labelChip(
      s,
      x,
      cx.y + 2,
      c,
      { text: "docs", color: "#0e8a16" },
      cx.x + cx.w,
    ) + 2;
  x = avatar(s, x, cx.y + 2, c, { name: "trevato" }, cx.x + cx.w) + 1;
  x = avatar(s, x, cx.y + 2, c, { name: "forge bot" }, cx.x + cx.w) + 2;
  x = pill(s, x, cx.y + 2, c, { text: "12" }, cx.x + cx.w) + 1;
  x = pill(s, x, cx.y + 2, c, { text: "3", tone: "danger" }, cx.x + cx.w) + 2;
  x = dot(s, x, cx.y + 2, c, { tone: "success" }, cx.x + cx.w) + 1;
  x = dot(s, x, cx.y + 2, c, { tone: "merged" }, cx.x + cx.w) + 1;
  x = dot(s, x, cx.y + 2, c, { hollow: true }, cx.x + cx.w) + 2;
  x = kbd(s, x, cx.y + 2, c, { key: "ctrl+d" }, cx.x + cx.w) + 1;
  spinner(s, x + 1, cx.y + 2, c, g.tick);

  const ix = card(s, inputs!, c, { title: "input · field · segmented · tabs" });
  const [top, mid, bottom] = split(ix, "v", [len(3), len(2), fill(1)]);
  const cursor = field(s, top!, c, {
    label: "Title",
    value: "Make the renderer emit nothing on a no-op frame",
    cursor: 47,
    hint: "One line. Imperative mood.",
    focused: true,
  });
  g.setCursor(cursor);
  input(s, { ...mid!, h: 1 }, c, {
    value: "",
    placeholder: "Search repositories…",
  });
  input(s, { ...mid!, y: mid!.y + 1, h: 1 }, c, {
    value: "not-a-branch name",
    invalid: true,
  });
  if (bottom && bottom.h >= 3) {
    segmented(s, { ...bottom, h: 1 }, c, {
      items: ["Unified", "Split"],
      active: g.seg,
    });
    tabs(s, { ...bottom, y: bottom.y + 2, h: 2 }, c, {
      items: [
        { label: "Issues", count: 12 },
        { label: "Pulls", count: 3 },
        { label: "Actions" },
      ],
      active: g.tab,
    });
  }
}

const REPOS: {
  name: string;
  state: "open" | "closed" | "merged" | "draft";
  note: string;
  meta: string;
}[] = [
  {
    name: "trevato/forge",
    state: "open",
    note: "a forge you can hold in your head",
    meta: "2m",
  },
  {
    name: "trevato/mitosis",
    state: "merged",
    note: "the ancestry",
    meta: "3d",
  },
  {
    name: "trevato/open-platform-ts",
    state: "closed",
    note: "archived",
    meta: "1y",
  },
  { name: "trevato/scratch", state: "draft", note: "wip", meta: "4h" },
];

function drawLists(r: Rect, s: Surface, c: Tokens, g: GalleryState): void {
  const [left, right] = split(r, "h", [fill(1), fill(1)]);
  const lx = card(s, left!, c, {
    title: "row",
    footer: plural(REPOS.length, "repo"),
  });
  const listBody = { ...lx, w: Math.max(0, lx.w - 2) };
  REPOS.forEach((repo, i) => {
    if (i >= listBody.h - 1) return;
    row(s, { ...listBody, y: listBody.y + i, h: 1 }, c, {
      title: repo.name,
      state: repo.state,
      secondary: repo.note,
      meta: repo.meta,
      selected: g.focus % REPOS.length === i,
    });
  });
  scrollbar(s, { x: lx.x + lx.w - 1, y: lx.y, w: 1, h: lx.h }, c, {
    total: 24,
    offset: g.scroll,
  });

  const rx = card(s, right!, c, { title: "table · timeline" });
  table(s, { ...rx, h: Math.min(7, rx.h) }, c, {
    columns: [
      { header: "#", width: len(5), numeric: true },
      { header: "Title", width: fill(1) },
      { header: "+", width: len(5), numeric: true, drop: 2 },
      { header: "−", width: len(5), numeric: true, drop: 1 },
    ],
    rows: [
      ["42", "Cell-diff renderer", "812", "204"],
      ["41", "Grapheme widths", "180", "12"],
      ["39", "Bracketed paste", "96", "4"],
      ["38", "Theme registry", "1204", "998"],
    ],
    selected: 1,
  });
  if (rx.h > 8)
    timelineItem(s, { ...rx, y: rx.y + 8, h: rx.h - 8 }, c, {
      kind: "comment",
      actor: "trevato",
      when: "2 minutes ago",
      body: [
        "Background carries add/delete, foreground carries syntax.",
        "Same rule as the web view — one definition, two surfaces.",
      ],
    });
}

function drawMarkdown(r: Rect, s: Surface, c: Tokens, _g: GalleryState): void {
  const inner = card(s, r, c, { title: "markdown", footer: "README.md" });
  // Reserve the scrollbar's column up front rather than painting over the
  // text: the gutter is part of the layout, not a decoration on top of it.
  const text = { ...inner, w: Math.max(0, inner.w - 2) };
  const lines = renderMarkdown(SAMPLE_MD, text.w, c);
  for (let i = 0; i < text.h && i < lines.length; i++)
    spanLine(s, text, i, lines[i]!);
  scrollbar(s, { x: inner.x + inner.w - 1, y: inner.y, w: 1, h: inner.h }, c, {
    total: lines.length,
    offset: 0,
  });
}

function drawDiff(r: Rect, s: Surface, c: Tokens, _g: GalleryState): void {
  const inner = card(s, r, c, { title: "diff", footer: "unified" });
  const diff = parseUnifiedDiff(SAMPLE_DIFF);
  const file = diff.files[0];
  if (!file) return;
  const lines = renderFileDiff(file, inner.w, c);
  for (let i = 0; i < inner.h && i < lines.length; i++)
    spanLine(s, inner, i, lines[i]!);
}

function drawEditor(r: Rect, s: Surface, c: Tokens, g: GalleryState): void {
  const [top, help] = split(r, "v", [fill(1), len(2)]);
  const inner = card(s, top!, c, {
    title: "textarea",
    footer: "ctrl+d submit · esc cancel",
    focused: true,
  });
  g.setCursor(g.editor.render(s, inner, c, true));
  if (help && help.h > 0) {
    let x = help.x + 1;
    x = kbd(s, x, help.y, c, { key: "alt+←/→" }) + 1;
    x = s.text(x, help.y, "word jump", style(c.mutedFg, c.bg)) + 2;
    x = kbd(s, x, help.y, c, { key: "ctrl+w" }) + 1;
    s.text(x, help.y, "delete word", style(c.mutedFg, c.bg));
  }
}

function drawOverlays(r: Rect, s: Surface, c: Tokens, g: GalleryState): void {
  const [left, right] = split(r, "h", [fill(1), fill(1)]);
  emptyState(s, left!, c, {
    title: "No open issues",
    body: "Everything's closed.",
    action: "New issue",
  });
  menu(s, { ...right!, h: Math.min(7, right!.h) }, c, {
    title: "menu",
    items: ["Open in browser", "Copy clone URL", "Watch", "Delete repository"],
    selected: 1,
  });
  if (g.showDialog)
    dialog(s, r, c, {
      title: "Merge pull request",
      body: [
        "This will merge 12 commits into main.",
        "Branch protection requires one approving review.",
      ],
      actions: [
        { label: "Cancel", variant: "ghost" },
        { label: "Merge", variant: "default" },
      ],
      selected: 1,
    });
}

const SECTIONS: Section[] = [
  { title: "Controls", draw: drawControls },
  { title: "Lists & tables", draw: drawLists },
  { title: "Markdown", draw: drawMarkdown },
  { title: "Diff", draw: drawDiff },
  { title: "Editor", draw: drawEditor },
  { title: "Overlays", draw: drawOverlays },
];

// ---- screens ----

function sectionScreen(ctx: Ctx, index: number, state: GalleryState): Screen {
  const section = SECTIONS[index]!;
  return {
    title: section.title,
    keys: [
      binding(["esc", "q"], "back"),
      binding(["d"], "dialog"),
      binding(["space"], "cycle"),
    ],
    render(area, s) {
      section.draw(inset(area, 1, 0), s, ctx.theme.c, state);
    },
    paste(text) {
      if (index !== 4) return false;
      state.editor.paste(text);
      return true;
    },
    key(e) {
      if (index === 4) {
        const out = state.editor.key(e);
        if (out === "submit") {
          ctx.toast("Comment submitted", "success");
          return true;
        }
        if (out === "cancel") return false;
        if (out !== "ignored") return true;
      }
      if (e.key === "d") {
        state.showDialog = !state.showDialog;
        return true;
      }
      if (e.key === " ") {
        state.focus++;
        state.tab = (state.tab + 1) % 3;
        state.seg = (state.seg + 1) % 2;
        state.scroll = (state.scroll + 3) % 20;
        return true;
      }
      return false;
    },
  };
}

export function galleryRoot(ctx: Ctx): Screen {
  const state: GalleryState = {
    tick: 0,
    focus: 0,
    editor: new Textarea(
      "Ctrl+D submits, Enter inserts a newline.\n\nSoft wrap keeps the trailing space at each break so the caret does not jump when you navigate past a wrap point.",
    ),
    showDialog: false,
    tab: 0,
    seg: 0,
    scroll: 0,
    setCursor: (pos) => ctx.setCursor(pos),
  };
  let selected = 0;

  return {
    title: "Gallery",
    keys: [
      binding(["j", "down"], "next"),
      binding(["k", "up"], "prev"),
      binding(["enter"], "open"),
      binding(["space"], "cycle state"),
    ],
    render(area, s) {
      const c = ctx.theme.c;
      state.tick = ctx.tick;
      // The responsive rule: list plus live preview at ≥100 columns, the list
      // alone below it, with Enter pushing the section as its own screen.
      const [list, preview] = ctx.twoPane
        ? split(area, "h", [len(24), fill(1)])
        : [area, undefined];
      const lx = card(s, list!, c, { title: "Components" });
      SECTIONS.forEach((section, i) => {
        if (i >= lx.h) return;
        row(s, { ...lx, y: lx.y + i, h: 1 }, c, {
          title: section.title,
          selected: i === selected,
        });
      });
      if (preview !== undefined)
        SECTIONS[selected]!.draw(inset(preview, 1, 0), s, c, state);
      else
        s.text(
          list!.x + 2,
          list!.y + SECTIONS.length + 2,
          `${G.chevron} enter to open`,
          style(c.faint, c.bg),
          list!.x + list!.w,
        );
    },
    key(e: KeyEvent) {
      if (e.key === "j" || e.key === "down") {
        selected = (selected + 1) % SECTIONS.length;
        return true;
      }
      if (e.key === "k" || e.key === "up") {
        selected = (selected - 1 + SECTIONS.length) % SECTIONS.length;
        return true;
      }
      if (e.key === "enter") {
        ctx.push(sectionScreen(ctx, selected, state));
        return true;
      }
      if (e.key === " ") {
        state.focus++;
        state.tab = (state.tab + 1) % 3;
        state.seg = (state.seg + 1) % 2;
        state.showDialog = false;
        return true;
      }
      return false;
    },
  };
}

export function galleryCommands(ctx: Ctx): Command[] {
  const jump = (i: number): Command => ({
    id: `section:${i}`,
    title: SECTIONS[i]!.title,
    hint: "section",
    run: () => {
      ctx.push(
        sectionScreen(ctx, i, {
          tick: 0,
          focus: 0,
          editor: new Textarea(""),
          showDialog: false,
          tab: 0,
          seg: 0,
          scroll: 0,
          setCursor: (p) => ctx.setCursor(p),
        }),
      );
    },
  });
  return [
    ...SECTIONS.map((_, i) => jump(i)),
    {
      id: "toast",
      title: "Show a toast",
      run: () => ctx.toast("Hello from the palette", "success"),
    },
    { id: "quit", title: "Quit", run: () => ctx.quit() },
  ];
}

/** Draw one frame at a given size and return the plain grid — the layout check. */
export function galleryFrame(
  cols: number,
  rows: number,
  keys: string[] = [],
): string {
  const terminal = headlessTerminal(cols, rows);
  const app = new App({
    terminal,
    theme: "dark",
    root: galleryRoot,
    commands: galleryCommands,
  });
  for (const key of keys)
    app.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
  app.frame();
  return app.screen.toText();
}

if (import.meta.main) {
  const app = new App({
    terminal: stdioTerminal(),
    theme: "dark",
    root: galleryRoot,
    commands: galleryCommands,
    exitHooks: true,
  });
  app.start();
}
