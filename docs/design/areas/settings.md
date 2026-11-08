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

Each label is a `row()` in a `.setting-list`: its chip is the title, `N open` the meta, and a `.row-fields` form (name,
colour, Save, Delete) the trail — `labelRow()` in `src/web/pages/labels.ts`. The new-label form sits in a `.settings-block`.

- `.label-open` — a label's `N open` link in its row's meta (`unused` stays a `.muted` span). Underlined so it
  reads as a link; at the phone breakpoint a 44px tap target. Styled in `src/web/style/components.ts`.

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

## Account (#9706)

Settings › Account (`src/web/pages/account.ts`: profile, password, tokens, SSH keys) has no card and no table. Each part
is a `block()` — a `.settings-block` with an `<h2>` — and the lists (tokens, SSH keys, signed-in browsers) are
`.setting-list` rows: name and badge as the title, dates and fingerprint as the meta, Revoke/Remove/Sign out in the trail.
An empty list is one muted sentence. No new class. Pinned by `test/account-rows.test.ts`.

Settings › Accounts (`src/web/pages/accounts.ts`) adds no component class. As on the home page it is headings over rows: the
accounts are `row()`s in `<ul class="list setting-list" id="accounts-list">` under `<h2>Who is on this forge</h2>`, the acts
(Sign-ins, Verify, Suspend, Remove) in the row's `after` slot; the mail, ownerless-organization, sign-in reach and
confirm/refusal notices are plain `<section class="settings-block">` blocks with an `<h2>`. `test/accounts-rows.test.ts` holds the shape.

Settings › Cloud (`src/web/pages/cloud.ts`) adds no component class. As on the home page it is headings over rows: Cloud accounts,
Add an account and Every read are each a `<section class="settings-block">` with an `<h2>`; each account is a `row()` in
`<ul class="list setting-list">`; with none, one plain sentence says how to add one. `/settings/cloud/audit` is unchanged.
`test/cloud-page-shape.test.ts` holds the shape.

Settings › Telemetry (`telemetryPage()` in `src/web/pages/telemetry.ts`, #9806) adds no class: two `<section class="settings-block">` blocks, Telemetry grants (one plain paragraph, then each agent a `row()` with its Grant/Revoke form in a `.setting-list`) and Reads; an empty list is one plain sentence. Pinned by `test/telemetry-blocks.test.ts`.

Settings › Traffic › Scrapes (`scrapesPage()` in `src/web/pages/scrapes.ts`, #9807) adds no class and has no card: under
the day switch, What was read, Who it is, One actor across addresses and Networks on file are each a
`<section class="settings-block">` with an `<h2>`. Each repository read is an `<h3>` over its counts and path lists; a
picked capture group is an `<h3 id="group">` over its reasons, export button and requests table, inside the One actor
block. The prefix, group and request tables keep their `.table-scroll` box, `sr-only` caption and `data-dense`; the
capture and networks forms sit straight in their blocks. An empty part (no reads in the window, no prefixes, no groups
yet) is one plain sentence. Pinned by `test/scrapes-blocks.test.ts`.

Settings › Trusted (`trustedPage()` in `src/web/pages/trusted.ts`, #9792) adds no component class. As on the home page it is
headings over rows: Fold-in, Trusted sources and Trust a source are each a `<section class="settings-block">` with an
`<h2>`. Each trusted entry is a `row()` in `<ul class="list setting-list" id="trusted-list">`; its state is a badge in the
title, each with a glyph (Trusted with a check, Ends soon with a clock, Lapsed with a ban), never colour alone; the row's
`data-state` is `open`, or `draft` once lapsed, and Remove and Revert landings sit in its trail as
`.row-fields` forms. With no entry, one plain sentence: no one is trusted, so every pull waits for review. The forms post to the same routes as
before. `test/trusted-sources.test.ts` holds the shape.
