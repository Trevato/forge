## 3. Typography

```
--font: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif
--mono: ui-monospace, "SF Mono", SFMono-Regular, "Cascadia Code", Menlo, Consolas, monospace
```

| role                             | size     | weight | tracking | line-height |
| -------------------------------- | -------- | ------ | -------- | ----------- |
| page title `h1`                  | 20px     | 620    | −0.02em  | 1.25        |
| section `h2`                     | 16px     | 600    | −0.01em  | 1.3         |
| sub `h3`                         | 14px     | 600    | 0        | 1.4         |
| **body, rows, chrome**           | **14px** | 400    | 0        | 1.5         |
| **prose (`.prose` only)**        | **15px** | 400    | 0        | 1.65        |
| metadata                         | 13px     | 400    | 0        | 1.45        |
| mono (code, sha, diff)           | 12.5px   | 400    | 0        | 1.55        |
| micro (`kbd`, `.pill`, `.badge`) | 11.5px   | 500    | 0        | 1           |

Rules:

- **Headings tighten as they grow.** Body text is never tracked.
- `font-variant-numeric: tabular-nums` on every count, date, line number,
  diff stat and file size — a count going 9 → 10 must not shift its neighbours.
  That is `.num`, `.pill`, `.badge`, `.sha`, `.dn`, `.table td`.
- `text-wrap: balance` on headings and empty-state titles; `pretty` on prose
  and descriptions.
- **Truncation is honest**: one line, ellipsis, and a `title` with the whole
  string. Never a fade-out mask — masks lie about whether there is more.
- **A token count is shown where a byte size is shown, never as a badge on
  its own.** Tokens are a unit, like KB: they sit beside a file's size, a
  directory's total, a run's cost or a window's dollars and percentage, so
  the context intuition grows next to the storage and money ones. One
  formatter (`kernel/tokens-format.ts`, rendered by `tokenCount()` /
  `sizeWithTokens()` in `web/ui.ts`) writes them all: `850 tok`, `1.2k tok`,
  `48k tok`, `1.1M tok`. A count the provider reported is bare; an estimate
  (bytes ÷ a stated bytes-per-token ratio for prose, code or data) carries a
  `~`, and every count's `title` says which tokenizer and whether it is an
  estimate. A binary file has no token count — no number beats a wrong one.
