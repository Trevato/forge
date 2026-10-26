# Prose (markdown)

Markdown table cell alignment: a column whose delimiter row reads `:-:` or `--:` puts the matching class on each of its
`th` and `td` cells, written by `cells` in `src/web/markdown.ts` as `ta-${align}` and styled under `.prose` in
`src/web/style/content.ts`. A left-aligned or unmarked column carries no class.

- `.ta-c` — a centred column (`:-:`); text-align center.
- `.ta-r` — a right-aligned column (`--:`); text-align right.
