### 6a. Counts and marks on a row

Three glyphs carry the at-a-glance numbers, all of them BMP, all width 1, all
present in every default terminal font in wide use — no Nerd Font (we cannot
assume a patched font over SSH) and no emoji (their width is genuinely
inconsistent, and one column of error shifts an entire row):

| glyph | means       | where                    |
| ----- | ----------- | ------------------------ |
| `○`   | open issues | every repo row           |
| `↳`   | open pulls  | every repo row           |
| `▭`   | comments    | every issue and pull row |

They render muted, right-aligned in the row's meta column, and **tabular**:
the widths are computed once across the whole page so the numbers form a
column instead of jittering row to row. **Zero is absent, not `○ 0`** — an
empty queue should read as quiet, and a column of zeroes reads as noise.

The numbers come from grouped reads (`countsForRepos` / `withCounts`,
`commentCountsFor`) and never from a query per row. `test/counts.test.ts` and
`test/tui-code.test.ts` both assert that; a list is where N+1 hurts most.
