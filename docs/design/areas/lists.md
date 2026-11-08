# Lists

The plain list: a bare `<ul>` or `<ol>` whose items hold §5 `.row`s, ruled between rows, and the faint note that
trails a palette row.

- `.list` — the plain list §5's rows sit in: a rule between items (`.list > li + li`) and the muted highlight on the
  item marked `aria-current="true"`. Written as `<ul class="list">` / `<ol class="list">` by the pages under
  `src/web/pages/` that list rows — among them `settings.ts`, `audit.ts`, `system.ts`, `capacity.ts`, `chain.ts`,
  `admin-limits.ts`, `next-steps.ts`, and `stageList()` in `browse.ts` (`ol.list.stages`); `grep -rn
  'class="[^"]*\blist\b' src/web` finds every one. Styled in `src/web/style/components.ts` (list rows).
- `.cat` — the faint trailing note on a palette or finder row (a file's directory, a result's place): pushed to the
  end, ellipsised past 45% of the row. Written by `src/web/client.ts` (the file finder's rows and the command
  palette's `row()`), never in server markup. Styled in `src/web/style/components.ts` (`.palette-item .cat`) and
  `src/web/style/content.ts` (`.finder .palette-item .cat`).
- `.flow-row` — a §5 `.row` link on the flow panel (`flow-panel.ts`: idle pulls and the "and K more" row) with a 44px
  minimum height, so it is a touch target on a 360px phone. Styled in `src/web/style/components.ts` (list rows).

The proofs under a forge on `/forges` (#7959) are `row()` `children`, one per public address; the row's trail badge says "reachable" or "not reachable", so the state is a word and not only a colour. No new class.

`/pipeline` (#7703) is a `.list` of `row()`s, one per step, each folding (`fold`) to the parts inside it; no new class. The pull page's path line marks a finished path with a `badge("done")`, so the state is a word.

## The pulls list at 390 px (#9346)

`/:owner/:name/pulls` (`changesList`) is a `listCard` of `row()`s. A pull's title is the writer's words, so inside
`[data-pulls]` (an attribute, not a class) the row's title and meta wrap and break long words anywhere, in place of the
one-line ellipsis. No fixed width; the page does not scroll sideways. No new class. The owner's phone look of
`/preview-admin/sample/pulls` is attached to the pull from its preview.
- `.archived-list` — the rows of an origin's archived repositories: long names wrap, and on a phone each row's buttons drop below it.
