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
- `.row-facts` — the `dl` of a §5 row's facts (`row({ facts })` in `src/web/ui.ts`): label and value pairs under the
  meta, wrapping as a phone narrows, in the meta's size and colour. The row's main column is then a `<div>`, so the
  `dl` is valid. First used by Settings › Features for where an app comes from (#9770). Styled in
  `src/web/style/components.ts` (list rows).
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

## The apps list and new-app step (#9711)

`/apps` is the shelf's `.list.setting-list` of `.row`s straight on the page, no card around it; `/apps/new` is the form straight on the page. The pull page's preview card is `.card.bare` unless it is failed or needs attention, when it keeps its tone and box. No new class; `test/web-apps.test.ts` holds it.

## The audit as headings over rows (#9710)

`/audit` (`auditPage` in `src/web/pages/audit.ts`) has no boxed card. Each app's standing (its policy table with the
last probe under it, an unsound contract's problems, the Unread rows) and each "What changed" part (pulls at the wall,
contract changes, doors over time) is a `<section class="settings-block">` (#9863), no `card` at all: an `<h2>` (an
`<h3>` under "What changed") on a `.bar` line over its rows on the page's one background, with no frame, no tone and no
icon before the heading. The state is a badge's word ("contract unsound", "1 door disobeys",
"at the wall"), so dropping the tone loses nothing. The table, the `id` each app section is linked by
(`/audit#owner-name`) and the probe form do not change. No new class. Pinned by `test/audit.test.ts`.

## The profile page, rows and space (#9694)

`/:owner` (`src/web/pages/org.ts`) draws its apps, repositories, members and teams as `.card.bare` lists under
their own headings, and the new-team form as a bare card: one background, no frame. The notice for an org with no
owner keeps its tone. A person and an org share the template; team changes still go through `src/actions/orgs.ts`.
No new class.

/system (`src/web/pages/system.ts`) adds no component class. As on the home page it is headings over rows: each part (Machine,
Disks and network, Processes, Main-thread stalls, Telemetry readers, Code page caches, Forge memory) is a
`<section class="settings-block">` with one `<h2>`; the lines are `row()`s in a `.list`, the wide figures stay tables. With
nothing to show a part says so in one plain sentence. The live regions (`summary`, `cores`, `mem`, `temps`, `sys-disks`,
`sys-procs`, …) keep their ids, so `system-live.ts` still patches them. `test/system-parts.test.ts` holds the shape.

`/forges` (#9798) speaks the home page's language and adds no class: "Side by side" and "Forges" are each a `<section class="settings-block">` under an `<h2>` (the list is the same `row()`s in a `.list.setting-list`); with none sent, one headed section ("No forges sent yet") says so in a plain sentence with the New forge button. The fresh-link page, the remove confirm and the stop/remove receipts are a `.settings-block` too, no `.card`; the claim link (`claimLinkBody`) is a bare row list. Those pages stay `cache-control: no-store`. `test/forges-language.test.ts` holds the shape.
