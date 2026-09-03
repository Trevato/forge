/**
 * The icon sets.
 *
 * One invariant carries this whole feature: **every icon is exactly one cell
 * wide, in both sets.** The layout engine measures with `displayWidth`, the
 * cell buffer stores by grapheme cluster, and a two-column icon would shift
 * every column to its right on that row — the failure mode that made this
 * codebase have exactly one width function in the first place.
 *
 * So the first block below asserts the width of every glyph in both tables,
 * and the second asserts the property that makes it true: `width.ts` classes
 * both Private Use Areas as width 1. If a Nerd Font glyph were ever added
 * from outside the PUA — an emoji, say — the first block catches it.
 */

import { describe, expect, test } from "bun:test";
import {
  fileIcon,
  icon,
  iconNames,
  looksLikeImage,
  type IconName,
} from "../src/tui/ui/icons.ts";
import { clusterWidth, clusters, displayWidth } from "../src/tui/term/width.ts";

const SETS = ["plain", "nerd"] as const;

describe("every icon is one cell", () => {
  test("both sets, every name", () => {
    for (const set of SETS)
      for (const name of iconNames()) {
        const glyph = icon(name, set);
        expect(glyph).not.toBe("");
        expect(clusters(glyph).length).toBe(1);
        expect(displayWidth(glyph)).toBe(1);
      }
  });

  test("file icons too, across every kind of path", () => {
    const paths = [
      "src/main.ts",
      "README.md",
      "Dockerfile",
      "bun.lock",
      ".gitignore",
      "assets/logo.png",
      "vendor/thing.tar.gz",
      "no-extension",
      ".hidden",
      "",
      "weird.name.with.dots.py",
      "UPPER.TS",
      "a/b/c/d.rs",
    ];
    for (const set of SETS)
      for (const path of paths)
        for (const o of [
          {},
          { directory: true },
          { directory: true, open: true },
          { submodule: true },
        ]) {
          const glyph = fileIcon(path, set, o);
          expect(displayWidth(glyph)).toBe(1);
          expect(clusters(glyph).length).toBe(1);
        }
  });

  test("no icon is an emoji or a variation-selector sequence", () => {
    // A VS16 anywhere makes a terminal render the glyph double width, which
    // is precisely the class of bug this file exists to prevent.
    for (const set of SETS)
      for (const name of iconNames()) {
        const glyph = icon(name, set);
        expect(glyph).not.toContain("\u{FE0F}");
        expect(glyph).not.toContain("\u{200D}");
      }
  });
});

describe("width.ts classes the Private Use Areas", () => {
  test("BMP PUA U+E000–U+F8FF is width 1", () => {
    // Nerd Fonts v3 packs Font Awesome, Octicons, Devicons, seti and the
    // Powerline glyphs in here.
    for (const cp of [0xe000, 0xe200, 0xe702, 0xf07b, 0xf413, 0xf4dd, 0xf8ff])
      expect(clusterWidth(String.fromCodePoint(cp))).toBe(1);
  });

  test("Plane 15 PUA-A U+F0000–U+FFFFD is width 1", () => {
    // Nerd Fonts v3 moved the Material Design set up here when it outgrew the
    // BMP area. These sit just past the last entry in the wide table, which
    // is exactly the boundary an off-by-one gets wrong.
    for (const cp of [0xf0000, 0xf0354, 0xf021f, 0xffffd])
      expect(clusterWidth(String.fromCodePoint(cp))).toBe(1);
  });

  test("a run of Nerd glyphs measures as its count", () => {
    const run = `${icon("issue", "nerd")}${icon("pull", "nerd")}${icon("branch", "nerd")}`;
    expect(displayWidth(run)).toBe(3);
    expect(displayWidth(` ${run} x`)).toBe(6);
  });
});

describe("the two sets are genuinely different vocabularies", () => {
  test("nerd icons come from a PUA; plain ones never do", () => {
    const inPua = (glyph: string): boolean => {
      const cp = glyph.codePointAt(0)!;
      return (cp >= 0xe000 && cp <= 0xf8ff) || (cp >= 0xf0000 && cp <= 0xffffd);
    };
    // The carets are shared on purpose — a tree that changed shape with the
    // icon setting would read as a bug — so they are the only exceptions.
    const shared: IconName[] = ["caret-right", "caret-down"];
    for (const name of iconNames()) {
      expect(inPua(icon(name, "plain"))).toBe(false);
      if (!shared.includes(name)) expect(inPua(icon(name, "nerd"))).toBe(true);
    }
  });

  test("plain marks stay inside the safe glyph set", () => {
    // Everything the chrome already uses; nothing new, nothing exotic.
    const safe = new Set([..."●○◆▭↳▸▾✓✗›▲▼"]);
    for (const name of iconNames())
      expect(safe.has(icon(name, "plain"))).toBe(true);
  });
});

describe("fileIcon", () => {
  test("whole names win over extensions", () => {
    // `Dockerfile` is a whale; `notes.dockerfile` is a plain file. Getting
    // this order backwards is the classic file-icon bug.
    expect(fileIcon("Dockerfile", "nerd")).toBe(fileIcon("dockerfile", "nerd"));
    expect(fileIcon("Dockerfile", "nerd")).not.toBe(
      fileIcon("notes.txt", "nerd"),
    );
    expect(fileIcon("notes.dockerfile", "nerd")).toBe(icon("file", "nerd"));
    expect(fileIcon("tsconfig.json", "nerd")).toBe(fileIcon("app.ts", "nerd"));
    expect(fileIcon("package.json", "nerd")).not.toBe(
      fileIcon("data.json", "nerd"),
    );
  });

  test("matching ignores case and directories", () => {
    expect(fileIcon("SRC/MAIN.TS", "nerd")).toBe(
      fileIcon("src/main.ts", "nerd"),
    );
    expect(fileIcon("a/b/README.md", "nerd")).toBe(
      fileIcon("README.md", "nerd"),
    );
  });

  test("related extensions share a glyph", () => {
    for (const group of [
      ["a.ts", "a.tsx", "a.mts", "a.cts"],
      ["a.sh", "a.bash", "a.zsh", "a.fish"],
      ["a.yaml", "a.yml"],
      ["a.png", "a.jpg", "a.jpeg", "a.gif", "a.webp"],
      ["a.zip", "a.tar", "a.gz", "a.tgz"],
    ]) {
      const first = fileIcon(group[0]!, "nerd");
      for (const path of group) expect(fileIcon(path, "nerd")).toBe(first);
    }
  });

  test("an unknown extension falls back to the generic file mark", () => {
    expect(fileIcon("thing.qqq", "nerd")).toBe(icon("file", "nerd"));
    expect(fileIcon("no-extension", "nerd")).toBe(icon("file", "nerd"));
    // A dotfile has no extension: the leading dot is not a separator.
    expect(fileIcon(".hidden", "nerd")).toBe(icon("file", "nerd"));
    expect(fileIcon("", "nerd")).toBe(icon("file", "nerd"));
  });

  test("kind beats name: a directory is a folder whatever it is called", () => {
    expect(fileIcon("src.ts", "nerd", { directory: true })).toBe(
      icon("folder", "nerd"),
    );
    expect(fileIcon("src", "nerd", { directory: true, open: true })).toBe(
      icon("folder-open", "nerd"),
    );
    expect(
      fileIcon("vendor/lib", "nerd", { submodule: true, directory: true }),
    ).toBe(icon("submodule", "nerd"));
  });

  test("the plain set distinguishes kinds, not languages", () => {
    // Six shades of ◆ would say less than nothing, so plain marks only the
    // four things a listing navigates by.
    expect(fileIcon("a.ts", "plain")).toBe(fileIcon("a.py", "plain"));
    expect(fileIcon("a.ts", "plain")).toBe(icon("file", "plain"));
    expect(fileIcon("a.png", "plain")).toBe(icon("image", "plain"));
    expect(fileIcon("a", "plain", { directory: true })).toBe(
      icon("folder", "plain"),
    );
    expect(fileIcon("a", "plain", { directory: true, open: true })).toBe(
      icon("folder-open", "plain"),
    );
  });

  test("looksLikeImage is an extension filter, not a decision", () => {
    expect(looksLikeImage("a/b/logo.PNG")).toBe(true);
    expect(looksLikeImage("shot.jpeg")).toBe(true);
    expect(looksLikeImage("chart.svg")).toBe(true);
    expect(looksLikeImage("main.ts")).toBe(false);
    expect(looksLikeImage("png")).toBe(false);
  });
});
