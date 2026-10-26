### 6b. Code, coloured

One tokenizer, `src/web/highlight.ts`, serves the file browser, the diff
viewer, Markdown fences, the terminal UI and the browser bundle the editor
loads. It is a stateful per-line scanner over rule tables — Prism's model, not
a parser — and it is bound by three properties the tests assert for every
language: **lossless** (a line's tokens concatenate back to the line),
**linear** (10,000 characters in well under a millisecond, no backtracking
regex), and **total** (random bytes never throw).

Roughly thirty languages have rule tables, including the ones a forge actually
holds: ts/tsx/js/jsx (template literals, regex-versus-division, decorators,
JSX tags), python, go, rust, c/c++/objective-c, java, kotlin, swift, ruby,
php, lua, zig, elixir, nix, sql, json/jsonc, yaml, toml, ini, markdown,
css/scss, html, shell, dockerfile, makefile and diff. Detection is by
extension, then by whole filename (`Dockerfile`, `Makefile`, `.zshrc`), then —
only for a file that has said nothing else — by shebang or editor modeline:
`detectLanguage(path, firstLine)`.

**Two levels of token.** `cls` is the colour _every_ consumer understands —
`keyword string comment number function type operator punctuation constant
meta plain` — and it is what the terminal's theme table maps. `kind` is a
refinement only the web paints: `property tag attribute regex variable
decorator heading emphasis link inserted deleted`. A token renders as
`class="tok-<cls> tok-<kind>"`, the kind rule comes last in the stylesheet and
so wins at equal specificity, and dropping the kind leaves a page that is less
specific but never wrong. That is the whole reason the vocabulary can grow on
the web without the terminal having to agree first.

Punctuation and operators are deliberately **below** body colour
(`--tok-punctuation`, `--tok-operator`): they are a line's scaffolding, and
colouring them loudly makes code shout. Diff-inside-a-fence borrows the diff
tints (`--add-fg` / `--del-fg`) rather than inventing a colour.

**Markdown has two right answers.** A `.md` blob renders as prose by default
and offers `Source | Rendered` in its path header; `?view=source` is a plain
link, so both halves work with no JavaScript, are addressable, and survive
being sent to somebody. The rendered half is the README renderer — fenced code
is highlighted in the language the fence names, tables are tables, and a
relative link (`docs/keeping.md`) resolves, while anything carrying a scheme
other than http(s), or a protocol-relative `//host`, is left as text.
