/**
 * The theme registry: every theme is one complete, typed palette — surfaces,
 * text, semantic colors, diff tints, elevation, and syntax tokens. The
 * stylesheet consumes only CSS custom properties, so a theme is data, not
 * code, and adding one is adding a table to this file.
 *
 * "System" is the absence of a choice: no `data-theme` attribute, and the
 * default light/dark pair follows `prefers-color-scheme`.
 */

const TOKEN_KEYS = [
  // surfaces & text
  "bg",
  "fg",
  "card",
  "muted",
  "muted-fg",
  "faint",
  "border",
  "border-strong",
  // interactive
  "primary",
  "primary-fg",
  "accent",
  "accent-fg",
  // semantic
  "danger",
  "success",
  "attn",
  "merged",
  // diff
  "add-bg",
  "add-fg",
  "add-edge",
  "del-bg",
  "del-fg",
  "del-edge",
  "wd-add",
  "wd-del",
  // elevation
  "shadow-1",
  "shadow-2",
  // syntax
  "tok-keyword",
  "tok-string",
  "tok-comment",
  "tok-number",
  "tok-function",
  "tok-type",
  "tok-constant",
  "tok-meta",
  "tok-property",
  "tok-operator",
  "tok-punctuation",
  "tok-tag",
  "tok-attribute",
  "tok-regex",
  "tok-variable",
  "tok-decorator",
  "tok-heading",
  "tok-emphasis",
  "tok-link",
] as const;

type TokenKey = (typeof TOKEN_KEYS)[number];
export type Palette = Record<TokenKey, string>;

export interface Theme {
  /** Menu label, e.g. "Porcelain". */
  label: string;
  /** Drives `color-scheme`, so native form controls match. */
  appearance: "light" | "dark";
  tokens: Palette;
}

/** Porcelain — the default light: quiet neutrals, one confident blue. */
const porcelain: Palette = {
  bg: "#fafafa",
  fg: "#18181b",
  card: "#ffffff",
  muted: "#f4f4f5",
  "muted-fg": "#6b7280",
  faint: "#a1a1aa",
  border: "#e4e4e7",
  "border-strong": "#d4d4d8",
  primary: "#18181b",
  "primary-fg": "#fafafa",
  accent: "#2563eb",
  "accent-fg": "#ffffff",
  danger: "#dc2626",
  success: "#16a34a",
  attn: "#d97706",
  merged: "#7c3aed",
  "add-bg": "#e6ffec",
  "add-fg": "#1a7f37",
  "add-edge": "#2da44e",
  "del-bg": "#ffebe9",
  "del-fg": "#cf222e",
  "del-edge": "#cf222e",
  "wd-add": "#abf2bc",
  "wd-del": "#ffc9c2",
  "shadow-1": "0 1px 2px rgb(24 24 27 / 0.05)",
  "shadow-2": "0 8px 24px rgb(24 24 27 / 0.10)",
  "tok-keyword": "#cf222e",
  "tok-string": "#0a3069",
  "tok-comment": "#6e7781",
  "tok-number": "#0550ae",
  "tok-function": "#8250df",
  "tok-type": "#953800",
  "tok-constant": "#0550ae",
  "tok-meta": "#116329",
  "tok-property": "#0550ae",
  "tok-operator": "#57606a",
  "tok-punctuation": "#8c959f",
  "tok-tag": "#116329",
  "tok-attribute": "#953800",
  "tok-regex": "#1a7f37",
  "tok-variable": "#953800",
  "tok-decorator": "#8250df",
  "tok-heading": "#0550ae",
  "tok-emphasis": "#24292f",
  "tok-link": "#0969da",
};

/** Ink — the default dark: near-black, high legibility, no haze. */
const ink: Palette = {
  bg: "#09090b",
  fg: "#f4f4f5",
  card: "#111113",
  muted: "#1b1b1f",
  "muted-fg": "#a1a1aa",
  faint: "#70707b",
  border: "#27272a",
  "border-strong": "#3f3f46",
  primary: "#fafafa",
  "primary-fg": "#18181b",
  accent: "#58a6ff",
  "accent-fg": "#0b0b0d",
  danger: "#f85149",
  success: "#3fb950",
  attn: "#d29922",
  merged: "#a371f7",
  "add-bg": "#12261e",
  "add-fg": "#3fb950",
  "add-edge": "#2ea043",
  "del-bg": "#25171c",
  "del-fg": "#f85149",
  "del-edge": "#f85149",
  "wd-add": "#1b4721",
  "wd-del": "#5a1e21",
  "shadow-1": "0 1px 2px rgb(0 0 0 / 0.5)",
  "shadow-2": "0 12px 32px rgb(0 0 0 / 0.55)",
  "tok-keyword": "#ff7b72",
  "tok-string": "#a5d6ff",
  "tok-comment": "#8b949e",
  "tok-number": "#79c0ff",
  "tok-function": "#d2a8ff",
  "tok-type": "#ffa657",
  "tok-constant": "#79c0ff",
  "tok-meta": "#7ee787",
  "tok-property": "#79c0ff",
  "tok-operator": "#9198a1",
  "tok-punctuation": "#6e7681",
  "tok-tag": "#7ee787",
  "tok-attribute": "#ffa657",
  "tok-regex": "#56d364",
  "tok-variable": "#ffa657",
  "tok-decorator": "#d2a8ff",
  "tok-heading": "#79c0ff",
  "tok-emphasis": "#f0f6fc",
  "tok-link": "#58a6ff",
};

/** Paper — warm ivory and ink, tuned for long reading (Flexoki lineage). */
const paper: Palette = {
  bg: "#f2f0e5",
  fg: "#100f0f",
  card: "#fffcf0",
  muted: "#e6e4d9",
  "muted-fg": "#6f6e69",
  faint: "#b7b5ac",
  border: "#dad8ce",
  "border-strong": "#cecdc3",
  primary: "#100f0f",
  "primary-fg": "#fffcf0",
  accent: "#205ea6",
  "accent-fg": "#fffcf0",
  danger: "#af3029",
  success: "#66800b",
  attn: "#ad8301",
  merged: "#5e409d",
  "add-bg": "#e4e7c5",
  "add-fg": "#66800b",
  "add-edge": "#879a39",
  "del-bg": "#ffe1d5",
  "del-fg": "#af3029",
  "del-edge": "#d14d41",
  "wd-add": "#c9d18c",
  "wd-del": "#ffc5b2",
  "shadow-1": "0 1px 2px rgb(16 15 15 / 0.06)",
  "shadow-2": "0 8px 24px rgb(16 15 15 / 0.12)",
  "tok-keyword": "#af3029",
  "tok-string": "#24837b",
  "tok-comment": "#878580",
  "tok-number": "#205ea6",
  "tok-function": "#5e409d",
  "tok-type": "#bc5215",
  "tok-constant": "#205ea6",
  "tok-meta": "#66800b",
  "tok-property": "#205ea6",
  "tok-operator": "#6f6e69",
  "tok-punctuation": "#b7b5ac",
  "tok-tag": "#66800b",
  "tok-attribute": "#bc5215",
  "tok-regex": "#24837b",
  "tok-variable": "#bc5215",
  "tok-decorator": "#5e409d",
  "tok-heading": "#205ea6",
  "tok-emphasis": "#100f0f",
  "tok-link": "#205ea6",
};

/** Dawn — rosé-tinted parchment; soft, warm, unhurried (Rosé Pine Dawn). */
const dawn: Palette = {
  bg: "#faf4ed",
  fg: "#575279",
  card: "#fffaf3",
  muted: "#f2e9e1",
  "muted-fg": "#797593",
  faint: "#9893a5",
  border: "#dfdad9",
  "border-strong": "#cecacd",
  primary: "#575279",
  "primary-fg": "#faf4ed",
  accent: "#286983",
  "accent-fg": "#faf4ed",
  danger: "#b4637a",
  success: "#56949f",
  attn: "#ea9d34",
  merged: "#907aa9",
  "add-bg": "#e0ead9",
  "add-fg": "#4e7a4e",
  "add-edge": "#6f9a6f",
  "del-bg": "#f7e2dd",
  "del-fg": "#b4637a",
  "del-edge": "#d7827e",
  "wd-add": "#c3d6bb",
  "wd-del": "#f2c5bc",
  "shadow-1": "0 1px 2px rgb(87 82 121 / 0.06)",
  "shadow-2": "0 8px 24px rgb(87 82 121 / 0.12)",
  "tok-keyword": "#286983",
  "tok-string": "#ea9d34",
  "tok-comment": "#9893a5",
  "tok-number": "#b4637a",
  "tok-function": "#d7827e",
  "tok-type": "#56949f",
  "tok-constant": "#907aa9",
  "tok-meta": "#56949f",
  "tok-property": "#56949f",
  "tok-operator": "#797593",
  "tok-punctuation": "#9893a5",
  "tok-tag": "#286983",
  "tok-attribute": "#d7827e",
  "tok-regex": "#ea9d34",
  "tok-variable": "#575279",
  "tok-decorator": "#907aa9",
  "tok-heading": "#b4637a",
  "tok-emphasis": "#575279",
  "tok-link": "#286983",
};

/** Midnight — deep indigo night; electric, focused (Tokyo Night lineage). */
const midnight: Palette = {
  bg: "#16161e",
  fg: "#c0caf5",
  card: "#1a1b26",
  muted: "#1f2335",
  "muted-fg": "#9aa5ce",
  faint: "#565f89",
  border: "#292e42",
  "border-strong": "#3b4261",
  primary: "#c0caf5",
  "primary-fg": "#16161e",
  accent: "#7aa2f7",
  "accent-fg": "#16161e",
  danger: "#f7768e",
  success: "#9ece6a",
  attn: "#e0af68",
  merged: "#bb9af7",
  "add-bg": "#1e2f26",
  "add-fg": "#9ece6a",
  "add-edge": "#58a460",
  "del-bg": "#37222c",
  "del-fg": "#f7768e",
  "del-edge": "#f7768e",
  "wd-add": "#2c4a35",
  "wd-del": "#5a2f3f",
  "shadow-1": "0 1px 2px rgb(0 0 0 / 0.45)",
  "shadow-2": "0 12px 32px rgb(0 0 0 / 0.5)",
  "tok-keyword": "#bb9af7",
  "tok-string": "#9ece6a",
  "tok-comment": "#565f89",
  "tok-number": "#ff9e64",
  "tok-function": "#7aa2f7",
  "tok-type": "#2ac3de",
  "tok-constant": "#ff9e64",
  "tok-meta": "#73daca",
  "tok-property": "#7dcfff",
  "tok-operator": "#89ddff",
  "tok-punctuation": "#7982a9",
  "tok-tag": "#f7768e",
  "tok-attribute": "#bb9af7",
  "tok-regex": "#b4f9f8",
  "tok-variable": "#c0caf5",
  "tok-decorator": "#e0af68",
  "tok-heading": "#7aa2f7",
  "tok-emphasis": "#c0caf5",
  "tok-link": "#73daca",
};

/** Aurora — polar blue-grey with glacial accents (Nord lineage). */
const aurora: Palette = {
  bg: "#272c36",
  fg: "#e5e9f0",
  card: "#2e3440",
  muted: "#3b4252",
  "muted-fg": "#aeb9cf",
  faint: "#616e88",
  border: "#3b4252",
  "border-strong": "#4c566a",
  primary: "#eceff4",
  "primary-fg": "#2e3440",
  accent: "#88c0d0",
  "accent-fg": "#2e3440",
  danger: "#bf616a",
  success: "#a3be8c",
  attn: "#ebcb8b",
  merged: "#b48ead",
  "add-bg": "#333f39",
  "add-fg": "#a3be8c",
  "add-edge": "#a3be8c",
  "del-bg": "#3f3239",
  "del-fg": "#bf616a",
  "del-edge": "#bf616a",
  "wd-add": "#4a5f4d",
  "wd-del": "#5f3f47",
  "shadow-1": "0 1px 2px rgb(0 0 0 / 0.35)",
  "shadow-2": "0 12px 32px rgb(0 0 0 / 0.45)",
  "tok-keyword": "#81a1c1",
  "tok-string": "#a3be8c",
  "tok-comment": "#616e88",
  "tok-number": "#b48ead",
  "tok-function": "#88c0d0",
  "tok-type": "#8fbcbb",
  "tok-constant": "#d08770",
  "tok-meta": "#ebcb8b",
  "tok-property": "#88c0d0",
  "tok-operator": "#81a1c1",
  "tok-punctuation": "#7b88a1",
  "tok-tag": "#81a1c1",
  "tok-attribute": "#8fbcbb",
  "tok-regex": "#ebcb8b",
  "tok-variable": "#d8dee9",
  "tok-decorator": "#ebcb8b",
  "tok-heading": "#88c0d0",
  "tok-emphasis": "#eceff4",
  "tok-link": "#88c0d0",
};

export const THEMES = {
  light: { label: "Porcelain", appearance: "light", tokens: porcelain },
  paper: { label: "Paper", appearance: "light", tokens: paper },
  dawn: { label: "Dawn", appearance: "light", tokens: dawn },
  dark: { label: "Ink", appearance: "dark", tokens: ink },
  midnight: { label: "Midnight", appearance: "dark", tokens: midnight },
  aurora: { label: "Aurora", appearance: "dark", tokens: aurora },
} as const satisfies Record<string, Theme>;

export type ThemeName = keyof typeof THEMES;
export const THEME_NAMES = Object.keys(THEMES) as ThemeName[];

export function isThemeName(value: string): value is ThemeName {
  return Object.hasOwn(THEMES, value);
}

/**
 * Colours every theme shares, because their meaning does not depend on the
 * surface: the chart series are the Okabe–Ito palette (told apart with the
 * common colour-vision deficiencies; the folded "others" series is grey),
 * and a QR code keeps a white ground because a scanner reads dark modules on
 * light and refuses the inverse.
 */
export const FIXED_TOKENS = {
  "series-0": "#0072b2",
  "series-1": "#e69f00",
  "series-2": "#009e73",
  "series-3": "#cc79a7",
  "series-4": "#56b4e9",
  "series-5": "#d55e00",
  "series-6": "#c9b800",
  "series-7": "#8a8a8a",
  "qr-ground": "#ffffff",
} as const;

function vars(theme: Theme): string {
  const lines = TOKEN_KEYS.map((key) => `  --${key}: ${theme.tokens[key]};`);
  lines.push(`  color-scheme: ${theme.appearance};`);
  return lines.join("\n");
}

/**
 * The variable blocks the stylesheet is built on. Explicit themes win via
 * `data-theme`; with no attribute the default pair follows the OS. A box that
 * names a theme in `data-look` wears it whatever the page wears: the previews
 * of the settings gallery.
 */
export const themeCss = [
  `:root {\n${Object.entries(FIXED_TOKENS).map(([key, value]) => `  --${key}: ${value};`).join("\n")}\n}`,
  `:root {\n${vars(THEMES.light)}\n}`,
  `@media (prefers-color-scheme: dark) {\n:root:not([data-theme]) {\n${vars(THEMES.dark)}\n}\n}`,
  ...THEME_NAMES.map(
    (name) => `:root[data-theme="${name}"], [data-look="${name}"] {\n${vars(THEMES[name])}\n}`,
  ),
].join("\n");

/** The browser-chrome color for a page: the theme's page background. */
export function metaThemeColor(name: ThemeName): string {
  return THEMES[name].tokens.bg;
}

/**
 * Critical paint for the document head: Chromium paints an unstyled frame
 * white between same-origin navigations (worse with `@view-transition`),
 * while Safari often keeps the prior paint. Matching `html`/`body` to the
 * theme before the external stylesheet arrives kills that flash. Kept tiny
 * and nonce'd — CSP forbids unnonce'd inline style.
 *
 * The same for every page, whatever theme it was rendered with: the theme
 * menu flips `data-theme` on the root without a reload, so the ground must
 * follow the attribute, not the theme the server saw. With no attribute the
 * system pair follows the OS; each `html[data-theme]` rule outranks it.
 */
export const bootCss = [
  `html,body{background-color:${THEMES.light.tokens.bg};color-scheme:light}`,
  `@media (prefers-color-scheme: dark){html,body{background-color:${THEMES.dark.tokens.bg};color-scheme:dark}}`,
  ...THEME_NAMES.map((name) => {
    const t = THEMES[name];
    const root = `html[data-theme="${name}"]`;
    return `${root},${root} body{background-color:${t.tokens.bg};color-scheme:${t.appearance}}`;
  }),
].join("");
