# Code, coloured

The highlighter's token colours (§6b): one component, written as `tok-${kind}` by `tokenClasses` in `src/web/highlight-html.ts` and coloured by the `--tok-*` tokens in `src/design/themes.ts`. A token span carries its colour class, plus a finer kind class when it has one; the file browser, the diff viewer and the editor all draw the same spans.

- `.tok-attribute` — an attribute name, as in markup.
- `.tok-comment` — a comment.
- `.tok-constant` — a constant: `true`, `null`, a named constant.
- `.tok-decorator` — a decorator or annotation.
- `.tok-emphasis` — emphasised prose, as in markdown.
- `.tok-function` — a function name.
- `.tok-heading` — a heading, as in markdown.
- `.tok-keyword` — a language keyword.
- `.tok-link` — a link, as in markdown.
- `.tok-meta` — meta syntax: a preprocessor line, a front-matter fence.
- `.tok-number` — a numeric literal.
- `.tok-operator` — an operator; muted, it is a line's scaffolding.
- `.tok-property` — a property or key name.
- `.tok-punctuation` — punctuation; muted, it is a line's scaffolding.
- `.tok-regex` — a regular-expression literal.
- `.tok-string` — a string literal.
- `.tok-tag` — a tag name, as in markup.
- `.tok-type` — a type name.
- `.tok-variable` — a variable or parameter name.
