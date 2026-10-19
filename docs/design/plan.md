# Design plan (#2678)

The line is held by `bun scripts/design-lint.ts`: a pull may not add a colour
literal or an off-scale `font-size` beyond `docs/design/baseline.json`, nor
define a class DESIGN.md §5 does not name. Paying down lowers the baseline
(`bun scripts/design-lint.ts --update`, reviewed in the pull) and strikes
retired classes from the §5d register; neither ever grows back without a §5
entry first.

Each item is one filed issue, small enough for one run; items 4–9 wait for the screenshot sweep (#2690) in the map.

1. **#2690 Screenshot sweep** — every top-level page, desktop + 360px, light + dark,
   committed under `docs/design/shots/`; fills the gap in the audit.
2. **Home as KPIs** — #2665 (already filed).
3. **Boards selectors** — #2666 (already filed).
4. **#2691 `/system` on the system** — rebuild with `card`, `row`, `pill`, tokens only.
5. **#2692 Merge usage / spend / capacity / telemetry** into one "Usage" page with `tabs()`.
6. **#2693 Fold `/flow` into boards** as panels; drop the topbar Flow button.
7. **#2694 Fold resilience into backups.**
8. **#2695 `/map`: account for it** — what it shows that nothing else does; cut the
   rest; move its 12 off-scale sizes and 3 colours onto tokens.
9. **#2696 Operator views** (`audit`, `waves`, `variants`, `looks`, `returns`,
   `chain`): one line each on why it is a page; retire or turn into board panels.
10. **#2697 Tokenise `style/content.ts`** — 23 colours, 31 sizes; the largest debt.
11. **#2698 Tokenise `style/components.ts`, `studio/home.ts`, `pages/looks.ts`, `pages/site.ts`.**
12. **#2699 Top bar diet** — at most search, New, and the user menu on the left of the fold.
13. **#2700 Class rule against DESIGN.md §5** — done: 13 classes no page drew are gone, the other 505 page-local ones are registered in DESIGN.md §5d, and the check reads §5 rather than the baseline. Items 4–12 retire §5d entries as they redo each page.
