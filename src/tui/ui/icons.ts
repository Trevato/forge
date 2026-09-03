/**
 * Two icon vocabularies for one interface.
 *
 * `plain` is the safe set — the glyphs in `term/screen.ts`'s `G`, which are
 * BMP, width 1, and in every default terminal font. `nerd` is the same
 * vocabulary drawn from a Nerd Font (v3; codepoints taken from the project's
 * own `glyphnames.json` 3.5.x), which looks enormously better and is a bet on
 * the user's *font* — a thing `TERM` cannot tell us.
 *
 * So the bet is opt-outable in one keypress (`icons: plain`) and its failure
 * mode is bounded: a missing Nerd glyph renders as a tofu box in exactly one
 * cell, never as a shifted row, because every codepoint here lives in a
 * Private Use Area — U+E000–U+F8FF, and U+F0000–U+FFFFD for Material Design
 * icons — which `term/width.ts` measures as width 1. `test/tui-icons.test.ts`
 * asserts that, because it is the invariant the whole layout rests on.
 *
 * Codepoints are written as `\u{…}` escapes with their official `nf-` name in
 * the comment, never as literal glyphs: a literal is invisible in a diff, in
 * a review, and in any editor without the font installed.
 */

import type { IconSet } from "../term/graphics.ts";
import { G } from "../term/screen.ts";

export type { IconSet };

export type IconName =
  // structure
  | "folder"
  | "folder-open"
  | "file"
  | "repo"
  | "fork"
  | "submodule"
  // the forge's nouns
  | "issue"
  | "issue-closed"
  | "pull"
  | "pull-merged"
  | "pull-draft"
  | "comment"
  | "review"
  | "branch"
  | "tag"
  | "commit"
  | "merge"
  | "diff"
  | "milestone"
  // people and places
  | "person"
  | "org"
  | "star"
  | "pin"
  | "origin"
  | "github"
  | "forgejo"
  | "gitlab"
  // marks
  | "warning"
  | "check"
  | "cross"
  | "clock"
  | "lock"
  | "eye"
  | "search"
  | "settings"
  | "terminal"
  | "image"
  | "caret-right"
  | "caret-down";

interface Pair {
  readonly plain: string;
  readonly nerd: string;
}

/**
 * The table. Plain glyphs come from `G` wherever one exists, so the icon set
 * and the chrome that uses no icons cannot drift apart.
 */
const ICONS: Readonly<Record<IconName, Pair>> = {
  folder: { plain: G.caretRight, nerd: "\u{f413}" }, // nf-oct-file_directory
  "folder-open": { plain: G.caretDown, nerd: "\u{f4d4}" }, // nf-oct-file_directory_open_fill
  file: { plain: G.comment, nerd: "\u{f4a5}" }, // nf-oct-file
  repo: { plain: G.diamond, nerd: "\u{f401}" }, // nf-oct-repo
  fork: { plain: G.pull, nerd: "\u{f402}" }, // nf-oct-repo_forked
  submodule: { plain: G.diamond, nerd: "\u{f414}" }, // nf-oct-file_submodule
  issue: { plain: G.ring, nerd: "\u{f41b}" }, // nf-oct-issue_opened
  "issue-closed": { plain: G.dot, nerd: "\u{f41d}" }, // nf-oct-issue_closed
  pull: { plain: G.pull, nerd: "\u{f407}" }, // nf-oct-git_pull_request
  "pull-merged": { plain: G.dot, nerd: "\u{f419}" }, // nf-oct-git_merge
  "pull-draft": { plain: G.ring, nerd: "\u{f4dd}" }, // nf-oct-git_pull_request_draft
  comment: { plain: G.comment, nerd: "\u{f41f}" }, // nf-oct-comment
  review: { plain: G.check, nerd: "\u{f442}" }, // nf-oct-comment_discussion
  branch: { plain: G.pull, nerd: "\u{f418}" }, // nf-oct-git_branch
  tag: { plain: G.diamond, nerd: "\u{f412}" }, // nf-oct-tag
  commit: { plain: G.dot, nerd: "\u{f417}" }, // nf-oct-git_commit
  merge: { plain: G.pull, nerd: "\u{f419}" }, // nf-oct-git_merge
  diff: { plain: G.comment, nerd: "\u{f440}" }, // nf-oct-diff
  milestone: { plain: G.diamond, nerd: "\u{f45d}" }, // nf-oct-milestone
  person: { plain: G.ring, nerd: "\u{f415}" }, // nf-oct-person
  org: { plain: G.diamond, nerd: "\u{f42b}" }, // nf-oct-organization
  star: { plain: G.diamond, nerd: "\u{f41e}" }, // nf-oct-star
  pin: { plain: G.dot, nerd: "\u{f435}" }, // nf-oct-pin
  origin: { plain: G.chevron, nerd: "\u{f484}" }, // nf-oct-globe
  github: { plain: G.diamond, nerd: "\u{f408}" }, // nf-oct-mark_github
  forgejo: { plain: G.diamond, nerd: "\u{e910}" }, // nf-dev-forgejo
  gitlab: { plain: G.diamond, nerd: "\u{f296}" }, // nf-fa-gitlab
  warning: { plain: G.up, nerd: "\u{f421}" }, // nf-oct-alert
  check: { plain: G.check, nerd: "\u{f42e}" }, // nf-oct-check
  cross: { plain: G.cross, nerd: "\u{f467}" }, // nf-oct-x
  clock: { plain: G.ring, nerd: "\u{f43a}" }, // nf-oct-clock
  lock: { plain: G.dot, nerd: "\u{f456}" }, // nf-oct-lock
  eye: { plain: G.ring, nerd: "\u{f441}" }, // nf-oct-eye
  search: { plain: G.ring, nerd: "\u{f422}" }, // nf-oct-search
  settings: { plain: G.diamond, nerd: "\u{f423}" }, // nf-oct-gear
  terminal: { plain: G.chevron, nerd: "\u{f489}" }, // nf-oct-terminal
  image: { plain: G.comment, nerd: "\u{f03e}" }, // nf-fa-image
  // The carets are the same either way: a Nerd Font has no better triangle,
  // and a tree that changed shape with the icon setting would read as a bug.
  "caret-right": { plain: G.caretRight, nerd: G.caretRight },
  "caret-down": { plain: G.caretDown, nerd: G.caretDown },
};

export function icon(name: IconName, set: IconSet): string {
  const pair = ICONS[name];
  return set === "nerd" ? pair.nerd : pair.plain;
}

/** Every name in the table — what a settings preview iterates. */
export function iconNames(): IconName[] {
  return Object.keys(ICONS) as IconName[];
}

// ---------------------------------------------------------------------------
// File icons
// ---------------------------------------------------------------------------

/**
 * Whole-filename matches, checked before extensions: these are files whose
 * *name* is the type. That order is what makes `Dockerfile` a whale and
 * `notes.dockerfile` a plain file, which is the right way round.
 */
const BY_NAME: Readonly<Record<string, string>> = {
  dockerfile: "\u{e650}", // nf-seti-docker
  "docker-compose.yml": "\u{e650}",
  "docker-compose.yaml": "\u{e650}",
  makefile: "\u{e615}", // nf-seti-config
  license: "\u{e60a}", // nf-seti-license
  "license.md": "\u{e60a}",
  "license.txt": "\u{e60a}",
  "readme.md": "\u{e609}", // nf-seti-markdown
  "package.json": "\u{e616}", // nf-seti-npm
  "tsconfig.json": "\u{e628}", // nf-seti-typescript
  "bun.lock": "\u{f023}", // nf-fa-lock
  "bun.lockb": "\u{f023}",
  "package-lock.json": "\u{f023}",
  "cargo.lock": "\u{f023}",
  "go.sum": "\u{f023}",
  ".gitignore": "\u{e702}", // nf-dev-git
  ".gitattributes": "\u{e702}",
  ".gitmodules": "\u{e702}",
};

/** Extension → Nerd Font glyph. */
const BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: "\u{e628}", // nf-seti-typescript
  tsx: "\u{e628}",
  mts: "\u{e628}",
  cts: "\u{e628}",
  js: "\u{e60c}", // nf-seti-javascript
  mjs: "\u{e60c}",
  cjs: "\u{e60c}",
  jsx: "\u{e7ba}", // nf-dev-react
  json: "\u{e60b}", // nf-seti-json
  jsonc: "\u{e60b}",
  md: "\u{e609}", // nf-seti-markdown
  mdx: "\u{e609}",
  py: "\u{e606}", // nf-seti-python
  go: "\u{e627}", // nf-seti-go
  rs: "\u{e68b}", // nf-seti-rust
  sh: "\u{e691}", // nf-seti-shell
  bash: "\u{e691}",
  zsh: "\u{e691}",
  fish: "\u{e691}",
  yaml: "\u{e8eb}", // nf-dev-yaml
  yml: "\u{e8eb}",
  toml: "\u{e6b2}", // nf-custom-toml
  ini: "\u{e615}", // nf-seti-config
  conf: "\u{e615}",
  lock: "\u{f023}", // nf-fa-lock
  html: "\u{e60e}", // nf-seti-html
  css: "\u{e614}", // nf-seti-css
  scss: "\u{e614}",
  c: "\u{e649}", // nf-seti-c
  h: "\u{e649}",
  cc: "\u{e646}", // nf-seti-cpp
  cpp: "\u{e646}",
  hpp: "\u{e646}",
  java: "\u{e66d}", // nf-seti-java
  kt: "\u{e634}", // nf-seti-kotlin
  swift: "\u{e699}", // nf-seti-swift
  rb: "\u{e605}", // nf-seti-ruby
  php: "\u{e608}", // nf-seti-php
  lua: "\u{e620}", // nf-seti-lua
  sql: "\u{e64d}", // nf-seti-db
  db: "\u{e64d}",
  sqlite: "\u{e64d}",
  xml: "\u{e619}", // nf-seti-xml
  svg: "\u{e698}", // nf-seti-svg
  png: "\u{f03e}", // nf-fa-image
  jpg: "\u{f03e}",
  jpeg: "\u{f03e}",
  gif: "\u{f03e}",
  webp: "\u{f03e}",
  bmp: "\u{f03e}",
  ico: "\u{f03e}",
  avif: "\u{f03e}",
  mp4: "\u{e69f}", // nf-seti-video
  mov: "\u{e69f}",
  webm: "\u{e69f}",
  mp3: "\u{e638}", // nf-seti-audio
  wav: "\u{e638}",
  flac: "\u{e638}",
  ttf: "\u{e659}", // nf-seti-font
  otf: "\u{e659}",
  woff: "\u{e659}",
  woff2: "\u{e659}",
  pdf: "\u{e67d}", // nf-seti-pdf
  zip: "\u{e6aa}", // nf-seti-zip
  gz: "\u{e6aa}",
  tar: "\u{e6aa}",
  tgz: "\u{e6aa}",
  xz: "\u{e6aa}",
  zst: "\u{e6aa}",
};

/** Extensions the plain set marks as pictures rather than as generic files. */
const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "avif",
  "svg",
]);

export interface FileIconOpts {
  /** A directory gets a folder whatever its name says. */
  readonly directory?: boolean;
  readonly open?: boolean;
  readonly submodule?: boolean;
}

/**
 * The icon for a path: whole filename first, then extension, then a generic
 * file mark.
 *
 * The plain set deliberately attempts no per-language marks — six shades of
 * `◆` says less than nothing. It distinguishes only the kinds a listing
 * actually navigates by: directory, submodule, image, file.
 */
export function fileIcon(
  path: string,
  set: IconSet,
  o: FileIconOpts = {},
): string {
  if (o.submodule === true) return icon("submodule", set);
  if (o.directory === true)
    return icon(o.open === true ? "folder-open" : "folder", set);

  const name = basename(path).toLowerCase();
  if (set === "plain")
    return IMAGE_EXTENSIONS.has(extension(name))
      ? icon("image", set)
      : icon("file", set);

  const exact = BY_NAME[name];
  if (exact !== undefined) return exact;
  return BY_EXTENSION[extension(name)] ?? icon("file", set);
}

/** Whether a path's extension is one the image pipeline will even try. */
export function looksLikeImage(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extension(basename(path).toLowerCase()));
}

function basename(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? path : path.slice(cut + 1);
}

/** The last dot's suffix; "" for a dotfile or a name with no dot at all. */
function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1);
}
