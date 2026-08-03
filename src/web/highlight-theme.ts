/**
 * Colors for syntax tokens — the one layer the diff viewer paints as text
 * color (background and underline belong to the diff/word-diff layer). Light
 * defaults, dark via the same signals as the rest of the design system. Kept
 * separate from the base stylesheet so the palette is easy to find and retune.
 */

export const highlightCss = /* css */ `
.tok-keyword { color: #cf222e; }
.tok-string { color: #0a3069; }
.tok-comment { color: #6e7781; font-style: italic; }
.tok-number { color: #0550ae; }
.tok-function { color: #8250df; }
.tok-type { color: #953800; }
.tok-constant { color: #0550ae; }
.tok-meta { color: #116329; }
.tok-operator, .tok-punctuation, .tok-plain { color: inherit; }

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .tok-keyword { color: #ff7b72; }
  :root:not([data-theme="light"]) .tok-string { color: #a5d6ff; }
  :root:not([data-theme="light"]) .tok-comment { color: #8b949e; }
  :root:not([data-theme="light"]) .tok-number { color: #79c0ff; }
  :root:not([data-theme="light"]) .tok-function { color: #d2a8ff; }
  :root:not([data-theme="light"]) .tok-type { color: #ffa657; }
  :root:not([data-theme="light"]) .tok-constant { color: #79c0ff; }
  :root:not([data-theme="light"]) .tok-meta { color: #7ee787; }
}
:root[data-theme="dark"] .tok-keyword { color: #ff7b72; }
:root[data-theme="dark"] .tok-string { color: #a5d6ff; }
:root[data-theme="dark"] .tok-comment { color: #8b949e; }
:root[data-theme="dark"] .tok-number { color: #79c0ff; }
:root[data-theme="dark"] .tok-function { color: #d2a8ff; }
:root[data-theme="dark"] .tok-type { color: #ffa657; }
:root[data-theme="dark"] .tok-constant { color: #79c0ff; }
:root[data-theme="dark"] .tok-meta { color: #7ee787; }
`;
