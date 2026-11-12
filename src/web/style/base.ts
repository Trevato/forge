/**
 * Layer 1 and 2 of the stylesheet: the cascade layers themselves, the
 * theme-independent constants, the reset, the type scale, and the page shell
 * (topbar, main, footer). Everything here is structure and rhythm; no
 * component owns a rule in this file.
 *
 * Typography rule of the house: 14px for chrome and list rows, 15px only for
 * prose. Hierarchy comes from weight and color, not size.
 */

/**
 * The page itself does not cross-fade. Chromium's default for a cross-document
 * transition is a 250 ms plus-lighter fade of the whole root, so a page that
 * reloads itself (the "Waking up" page asks again every 3 s) pulses as a
 * second loading indicator over its own. Only the named parts (topbar, repo
 * header) are held still. These pseudo-elements fall outside the
 * reduced-motion rule's `*`, so this is also what keeps that promise.
 */
const rootHolds = [
  `::view-transition-group(root), ::view-transition-old(root), ::view-transition-new(root) { animation: none; }`,
  `::view-transition-old(root) { display: none; }`,
  `::view-transition-new(root) { mix-blend-mode: normal; }`,
].join("\n");

/**
 * The cascade order, declared once and up front, plus the one at-rule that
 * must sit outside every layer. Cross-document view transitions are pure
 * enhancement: where the browser honours them the topbar and repo header hold
 * still across a navigation, and where it does not, nothing changes.
 */
export const layers = [
  `@layer reset, base, components, content, utilities;`,
  `@view-transition { navigation: auto; }`,
  rootHolds,
].join("\n");

export const base = /* css */ `
@layer base {
/* ---- theme-independent constants ---- */
:root {
  --radius-sm: 6px;   /* controls: buttons, inputs, chips, kbd */
  --radius: 8px;      /* surfaces: cards, panels, code blocks */
  --radius-lg: 12px;  /* overlays: dialogs, palette, menus */
  --fs-min: 12px;     /* type floor: no meaningful text is smaller */
  --topbar-h: 56px;
  --page: 1120px;
  --measure: 72ch;
  --ease: cubic-bezier(.2, 0, 0, 1);
  /* One motion vocabulary: the code viewer's timings, named. A hover or a
     focus is --dur-1 to --dur-2, a thing arriving --dur-3, and a pixel
     figure changes frame every --beat (#10570). */
  --dur-1: 100ms;
  --dur-2: 140ms;
  --dur-3: 200ms;
  --beat: 450ms;
  --font: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, "Cascadia Code", "JetBrains Mono", Menlo, Consolas, "Liberation Mono", monospace;
}

html {
  -webkit-text-size-adjust: 100%;
  scroll-behavior: smooth;
  /* Root canvas colour: Chromium view-transition / nav frames use html,
     not body; leaving it transparent flashes the UA default (white). */
  background: var(--bg);
}
body {
  font-family: var(--font);
  font-size: 14px;
  line-height: 1.5;
  background: var(--bg);
  color: var(--fg);
  min-height: 100dvh;
  display: flex; flex-direction: column;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

a { color: inherit; text-decoration: none; transition: color 120ms var(--ease); }
a:hover { color: var(--accent); }
code, pre, .mono { font-family: var(--mono); font-size: 12.5px; }
.mono { overflow-wrap: anywhere; }

h1 { font-size: 20px; font-weight: 620; letter-spacing: -0.02em; line-height: 1.25; text-wrap: balance; }
h2 { font-size: 16px; font-weight: 600; letter-spacing: -0.01em; line-height: 1.3; text-wrap: balance; }
h3 { font-size: 14px; font-weight: 600; line-height: 1.4; }

::selection { background: color-mix(in srgb, var(--accent) 26%, transparent); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 3px; }

/* Anything anchorable clears the sticky topbar when it is scrolled to. */
[id] { scroll-margin-top: calc(var(--topbar-h) + 12px); }

/* Momentary class the theme switcher adds so a theme change sweeps rather
   than snaps. */
:root.theme-anim, :root.theme-anim *, :root.theme-anim *::before, :root.theme-anim *::after {
  transition: background-color 200ms var(--ease), color 200ms var(--ease),
    border-color 200ms var(--ease) !important;
}

/* ---- shell ---- */
.skip {
  position: absolute; left: 16px; top: -48px; z-index: 40;
  padding: 8px 14px; border-radius: var(--radius);
  background: var(--primary); color: var(--primary-fg);
  font-weight: 500; transition: top 140ms var(--ease);
}
.skip:focus-visible { top: 10px; color: var(--primary-fg); }

.shell { width: 100%; max-width: var(--page); margin: 0 auto; padding: 0 16px 96px; flex: 1; }
/* A bare page owns the whole window: no width, no padding, no chrome. */
.bare { flex: 1; display: flex; flex-direction: column; min-width: 0; }
/* A wide page keeps the chrome but lets the column go: a tree beside a
   file is the one layout that gets better with every pixel of a monitor,
   and holding it to the reading width leaves most of that monitor blank. */
@media (min-width: 1200px) {
  .shell-wide { max-width: none; padding-left: 24px; padding-right: 24px; }
}

.topbar {
  position: sticky; top: 0; z-index: 20;
  view-transition-name: topbar;
  min-height: var(--topbar-h);
  display: flex; align-items: center; gap: 8px;
  padding: 8px 16px;
  background: color-mix(in srgb, var(--bg) 84%, transparent);
  backdrop-filter: blur(14px) saturate(1.4);
  -webkit-backdrop-filter: blur(14px) saturate(1.4);
  border-bottom: 1px solid var(--border);
}
.wordmark {
  display: inline-flex; align-items: center; gap: 8px; flex: none;
  min-height: 44px;
  font-weight: 660; letter-spacing: -0.03em; font-size: 15px;
}
.wordmark .mark {
  width: 10px; height: 10px; border-radius: 3px; flex: none;
  background: linear-gradient(135deg, var(--accent), var(--merged));
  transition: transform 200ms var(--ease);
}
.wordmark:hover { color: var(--fg); }
.wordmark:hover .mark { transform: rotate(135deg); }
.topbar .spacer { flex: 1; }
.topbar-tools { display: flex; align-items: center; gap: 6px; flex: 0 1 auto; min-width: 0; }
.topbar-tools > a.small { display: inline-flex; align-items: center; min-height: 44px; padding: 0 8px; flex: none; }
/* The page never scrolls sideways. A strip that must — the tabs, a code
   table — scrolls inside its own box; nothing else may push the page wide.
   clip, not hidden: hidden would make the body a scroll container and
   unstick the topbar. */
body { overflow-x: clip; }
@media (max-width: 719px) {
  .topbar { gap: 6px; padding-left: 12px; padding-right: 12px; }
  .topbar-tools { gap: 4px; }
}

.foot {
  width: 100%; max-width: var(--page); margin: 0 auto;
  padding: 20px 16px 36px;
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  /* Muted, not faint: small text and links must still reach AA (4.5:1) in every theme. */
  color: var(--muted-fg); font-size: 12.5px;
}
.foot .mark {
  width: 7px; height: 7px; border-radius: 2px; opacity: .7;
  background: linear-gradient(135deg, var(--accent), var(--merged));
}
.foot a:hover { color: var(--accent); }
.foot .reduced { color: var(--muted-fg); }

@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  *, *::before, *::after {
    animation-duration: .01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .01ms !important;
  }
}

@media (forced-colors: active) {
  :focus-visible { outline-color: Highlight; }
}
}
`;

export const utilities = /* css */ `
@layer utilities {
.muted { color: var(--muted-fg); }
.small { font-size: 13px; }
.num { font-variant-numeric: tabular-nums; }
.grow { flex: 1; min-width: 0; }
.spacer { flex: 1; }
.truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nowrap { white-space: nowrap; }
.break { overflow-wrap: anywhere; }
.stack { display: flex; flex-direction: column; gap: 12px; }
.stack-tight { gap: 4px; }
.bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.bar:has(> .field) { align-items: flex-end; }
.bar > .field { margin: 0; }
.mt { margin-top: 12px; }
.mb { margin-bottom: 12px; }
.narrow { max-width: 400px; margin: 8dvh auto 0; }
.narrow-wide { max-width: 760px; }
.hide-sm { display: none; }
/* Revealed by the shell script — a control that needs JavaScript must not be
   on the page when there is none to run. */
.js-only { display: none; }
:root.js .js-only { display: inline-flex; }
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0;
}
[hidden] { display: none !important; }
[data-region] { display: contents; }

@media (min-width: 720px) {
  .shell { padding: 0 24px 96px; }
  .topbar { padding: 8px 24px; }
  .foot { padding: 20px 24px 36px; }
  .hide-sm { display: inline-flex; }
  .hide-lg { display: none; }
}

/* viewport-fit=cover lets the page run to the glass, so the chrome steps
   in from the notch, the rounded corners and the home indicator itself.
   max() keeps the ordinary gutter wherever the inset is zero, which is
   everywhere but a phone held sideways or an installed app. */
@supports (padding: max(0px)) {
  .topbar {
    padding-top: max(8px, env(safe-area-inset-top));
    padding-left: max(12px, env(safe-area-inset-left));
    padding-right: max(12px, env(safe-area-inset-right));
  }
  .shell {
    padding-left: max(16px, env(safe-area-inset-left));
    padding-right: max(16px, env(safe-area-inset-right));
  }
  .foot { padding-bottom: max(36px, env(safe-area-inset-bottom)); }
  @media (min-width: 720px) {
    .topbar {
      padding-left: max(24px, env(safe-area-inset-left));
      padding-right: max(24px, env(safe-area-inset-right));
    }
    .shell {
      padding-left: max(24px, env(safe-area-inset-left));
      padding-right: max(24px, env(safe-area-inset-right));
    }
  }
}

@media print {
  .topbar, .foot, .live-news, .sticky-action, .toast, [data-print-hide] { display: none !important; }
  .card { box-shadow: none; }
  /* A page that prints alone (an app's statement) drops the repository's chrome. */
  body:has([data-print-alone]) :is(.repo-nav, .settings-jump, .settings-nav) { display: none !important; }
}
}
`;

export const reset = /* css */ `
@layer reset {
* { box-sizing: border-box; margin: 0; }
button, input, select, textarea { font: inherit; color: inherit; }
img, svg, video { max-width: 100%; }
table { border-collapse: collapse; }
ul, ol { list-style: none; padding: 0; }
summary::-webkit-details-marker { display: none; }
}
`;
