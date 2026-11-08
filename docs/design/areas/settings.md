# Settings page

## Settings rows

A list whose rows are settings — each row a name, its current value, and a control to change it (limits, capacity,
flags, telemetry, cloud, people, crew roles, subscription headroom and budget) — is §5's list row in a list that lets
the text wrap and gives the control a place that is always visible. Use `.row-actions` only for secondary actions
(delete, wake, pin, revoke).

- `.setting-list` — the `<ul class="list setting-list">` around such rows: title and meta wrap instead of ellipsizing,
  and a row's trail takes its own line under 640px. Written by the settings pages, e.g. `appDomainsView()` and
  `appEgressView()` in `src/web/pages/settings.ts`, `limitsPage()` in `src/web/pages/admin-limits.ts`, `capacityPage()` in
  `src/web/pages/capacity.ts`, `flagsPage()` in `src/web/pages/flags.ts`, and by lists of the same shape in
  `src/web/pages/repo.ts`, `src/web/pages/pull.ts`, `src/web/pages/map.ts` and `src/web/studio/make_it_yours.ts`.
  Styled in `src/web/style/components.ts`.
- `.row-fields` — the form in a settings row's trail (input, Save, Default): always visible, never hover-gated,
  wrapping under the text before it would clip. Written in the trail of `row()` by `src/web/pages/flags.ts`,
  `src/web/pages/telemetry.ts`, `src/web/pages/cloud.ts`, `src/web/pages/people.ts`, `src/web/pages/admin-limits.ts`,
  `src/web/pages/capacity.ts`, `src/web/pages/subscriptions.ts` and `src/web/studio/crew.ts`. Styled in
  `src/web/style/components.ts`.
- `.record-value` — a DNS record's value on an app's domain row (`.setting-list` row meta): monospace, wraps instead of ellipsizing, and `user-select: all` so one click selects the whole value to copy.

## Labels

- `.preview` — the label chip at the head of a label's edit row on a repository's Labels settings, kept from
  shrinking. Written by `labelEditor()` in `src/web/pages/labels.ts`; styled in `src/web/style/components.ts` as
  `.edit-row > .preview`.

- `.label-open` — a label's `N open` link beside its chip in `labelEditor()` (`unused` stays a `.muted` span). Underlined so it
  reads as a link; at the phone breakpoint a 44px tap target. Styled under `.edit-row` in `src/web/style/components.ts`.

The terminal's Labels screen (`src/tui/screens/labels.ts`) shows the same counts to a repository admin: `N open` or `unused` after each hex, and its delete confirm says how many open issues and pulls carry the label. A reader sees neither.

Settings → Confirms (`src/web/pages/confirms.ts`, #8230) is a `listCard()` of `row()`s that fold (`fold`) open on the call's full
arguments in a `messageText()` block, with the Yes form beside the row (`after`); no new class.

## Team card: a seat's number

Each seat row (`row`) holds one child row: its title says how much the seat may do at once ("2 builds at once", "Paused"), its meta says what it is doing and spending, and its trail holds a one-line form: a number `input input-sm` (the same small control as the Crew card's role select, in a `row-fields` form) and a small Set button. No new class. At phone width the row wraps as every row does; the form stays on one line because it is a number and a button.

## People fits a 390 px phone (#9374)

`/settings/people` is one table of four columns: account, role, allowance and the role form. On a phone it does not
fit beside the settings nav, so the table sits in the existing `.table-scroll` box and scrolls inside it, never the
page. The box carries the attribute `data-people` (not a class), which wraps long words anywhere
(`overflow-wrap: anywhere`, the rule shared with `data-milestone` in `src/web/style/content.ts`), so an unbroken
username shrinks its column instead of widening the table. The role form is a `.row-fields`, which already wraps its
input over its button. Pinned by `test/people-fit.test.ts`, with a 250-character username written straight to the
table, longer than the 100 a new account may take.

## The settings shell

`settingsLayout()` in `src/web/chrome.ts` draws §5's settings shell. A section may name a group (`accountSections()` in
`src/web/pages/origins.ts` names Account, Crew and AI, Connections, Security and This forge; the last two and the admin
rows show only to a forge admin). Inside `.settings-main` a card loses its frame: its head is a small heading over a
hairline, and its rows run edge to edge, so a dense page reads as rows rather than boxes. Styled in
`src/web/style/components.ts`.

- `.settings-group` — one group of sections in the nav: its name, then its links. Hidden when a filter leaves none.
- `.settings-group-name` — a group's name, small and muted, over its links.
- `.settings-filter` — the box at the top of the nav that narrows the sections as you type (`data-settings-filter`,
  handled in `src/web/client.ts`); shown only with script.
- `.settings-jump` — on a phone, the one menu at the top in place of the nav: it names the section you are on and opens
  onto the same groups. Hidden from 860px.
- `.settings-jump-list` — the groups inside that menu, with touch-sized links.

## Settings content

A dense settings page (Security in `src/web/pages/security.ts` first) says when it checked once at the top, then shows
each thing it knows as one row: what it is, how it stands with any badge inline, and what you can do. A list only appears,
full width, when it has rows. Styled in `src/web/style/components.ts`.

- `.status-rows` — the `<dl>` of those rows, ruled by hairlines.
- `.status-row` — one row: label, state, action; one column on a phone, three from 640px.
- `.status-act` — a row's actions, at its end; absent when there are none.
- `.settings-block` — a titled block of a settings page that is not a card: a small heading and its content.
- `.segmented` — a few mutually exclusive states side by side, the one on pressed; each other state is a one-button form.
- `.segmented-on` — the state that is on, in `.segmented`.
- `.setting-table` — a table of settings rows (Limits): name and reason, value and bounds, the form to change it; each row stacks on a phone.

Settings › Capacity (`capacityPage()` in `src/web/pages/capacity.ts`, #9709) has no card: one line of what a change does,
the egress note when cells only report, then `.settings-block` sections — Capacity (the `.setting-list` of settings
rows), Changes, Errors and refused calls, Egress connections, Self-swap. No new class. Pinned by
`test/capacity-rows.test.ts`.
