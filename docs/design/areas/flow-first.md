# Flow first

The `flow` label puts ready work first, and one button applies it: "Flow first" on an issue's header and on each row of the issues list (`src/web/flow_button.ts`), a small outline form that posts to the issue's own `/flow` and lands back where it was pressed. On the terminal the issue screen has `f` ("flow first"), a toggle through the same action.

On the list the form cannot sit inside the row's link, so a row that has a control beside it is `li.has-after` with a `.row-after` span: the link keeps the width, the control keeps its own. `.row-after` is the only new class.

## /flow on a 390 px phone (#9323)

A valve row's title and meta are one clipped line by default (`.row-title`, `.row-meta`), which cut a long repository name and the valve's sentences short. Two classes undo that inside the row: `.valve-name` wraps the repository link and its week's numbers, `.valve-body` wraps the valve form and the sentences under it; both set `white-space: normal` and `overflow-wrap: anywhere` (content.ts). `test/flow-phone-fit.test.ts` holds it.
