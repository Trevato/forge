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

Settings › Origins (`src/web/pages/origins.ts`) adds no component class. As on the home page it is headings over rows: Connected
origins, Frozen mirrors, Trusted internal hosts (admin) and Connect an origin are each a `<section class="settings-block">`
with an `<h2>`; each origin and each frozen mirror is a `row()` in a `.list`; with no origins, one plain sentence says how to
connect one. An origin's error, notes (re-authorize, another forge, writes paused) and acts sit in the row's `after`
slot; the list carries the attribute `data-origins` (not a class), which stacks that slot as a full-width block under
the row at every width, so nothing squeezes beside the title on a 390 px phone. `test/origins-page-shape.test.ts` holds the shape.

`/oauth/authorize` (`src/web/pages/oauth.ts`) adds no component class. The consent, sign-in and can't-connect parts are each a `<section class="settings-block">` with an `<h2>` (What it gets, What it learns; the can't-connect part is the message alone) under the `pageHead`, no `.card`. The client's name, the return host, the token kind, name and lifetime fields are as they were. `test/oauth-page-shape.test.ts` holds the shape.

Settings › Cloud (`src/web/pages/cloud.ts`) adds no component class. As on the home page it is headings over rows: Cloud accounts,
Add an account and Every read are each a `<section class="settings-block">` with an `<h2>`; each account is a `row()` in
`<ul class="list setting-list">`; with none, one plain sentence says how to add one. `/settings/cloud/audit` is one `settings-block`, Today's vendor calls,
its rows in a `.list` or one plain sentence when there are none (#9878). `test/cloud-page-shape.test.ts` holds the shape.

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

Settings › Traffic (`trafficPage()` in `src/web/pages/traffic.ts`, #9775) adds no class and has no card: one sentence of purpose, the window switch, one
line of numbers (requests, answering time, refused, addresses), then `<section class="settings-block">` blocks — Who asked
(chart, legend, table) and one per top list (Repository read, User agent, Address prefix, Country, Request signature), each
with an `<h2>` over `row()`s in a `.setting-list`: the key as title, requests and anonymous as meta, its share of time in the trail. Its terminal door is the admin palette entry `traffic` (`src/tui/screens/traffic.ts`); the how-to is `docs/features/traffic.md`. An empty top list or window is one plain sentence. Every stranger's string stays escaped by `html`.

Settings › Crew (`crewPage()` and `crewReadiness()` in `src/web/pages/crew.ts`, #9826) adds no class and has no card. The
readiness words come first: a danger notice (no runner, runner cannot run, unsandboxed) is an existing
`.toast[data-tone="danger"]` with `role="alert"`. Spending, Agents, Scorecard, Model review, the per-model, per-prompt and
per-day tables, Handed to the planner and Restore drill are each a `<section class="settings-block">` with an `<h2>` (an
optional muted note under it) and keep their `.table-scroll` tables. With no agent, one plain sentence under "No agents yet".
New agent is the last block, its form posting to `/settings/crew`. Pinned by `test/crew-language.test.ts`.

Settings › Prompts (`promptsView()` in `src/web/pages/prompts.ts`, #9825) adds no class: two `<section class="settings-block">` blocks, Instagram (the connected account as a `row()` in a `.setting-list` with its Fetch now and Remove forms, or one plain sentence and the add form) and Getting a token. Pinned by `test/prompts-language.test.ts`.

Settings › Hooks (`hooksPage()` in `src/web/pages/hooks.ts`, #9762) adds no component class and has no card or table: Webhooks and Add a webhook are each a `<section class="settings-block">` with an `<h2>`. Each hook is a `row()` in `<ul class="list setting-list">` (URL as title; events, state, added date and "unsigned" as meta; Send ping and a confirmed Delete in the trail), with its recent deliveries as nested child rows, Redeliver in the trail of a failed one. With no hook, one plain sentence. The secret is never drawn. Pinned by `test/hooks-rows.test.ts`.

Settings › App › Private destinations asked for (`appEgressView()` in `src/web/pages/settings.ts`, #9856) adds no class and has no card: a `<section class="settings-block" id="egress">` with its `<h2>`, one sentence that every other host is refused, each destination a `row()` in `<ul class="list setting-list">` with Grant or a confirmed Revoke in the trail, and the recent changes as a timeline. With nothing asked for, one plain line: the app reaches only the forge. Pinned by `test/app-egress-grants.test.ts`.

Settings › Model (`modelPage()` in `src/web/pages/model.ts`, #9800) adds no class and has no card: Your model budget is one `<section class="settings-block">` with an `<h2>`. A grant an admin gave is one `row()` in `<ul class="list setting-list" id="model-budget">`; with nothing (or an own subscription, or an admin) one plain sentence says what the account may spend and how to add a subscription. The token form sits straight in the block, typed once and never shown again. `ceilingCard` and `grantCard` stay cards on the account's page. Pinned by `test/model-page-shape.test.ts`.

## Organizations

`/organizations/new` is one muted sentence (what an organization is) over the single name field, whose hint says it becomes the URL; "first owner" is said once, in the landing flash. A team's page (`/:owner/-/teams/:team`) is three `<section class="settings-block">`s, each an `<h2>` — Members, Add a member, Delete this team (not on Owners) — over a `list setting-list` of `row()`s or a plain form. No card, no empty-state box (an empty team is one muted line), no new class. Every change stays a plain POST form or a confirm page, so it works with JavaScript off. `test/org-team-rows.test.ts` holds the shape.

Settings › Accounts (`accountsPage()` in `src/web/pages/accounts.ts`, #9870) has no card: who is on the forge is a `<section class="settings-block" id="accounts">` under an `<h2>`, rows in `.list`, and a person's sign-ins page is the same (an `<h2>`, an `<h3>` for tokens, rows). No new class. Pinned by `test/accounts-language.test.ts`.

Settings › Flags (`flagsPage()` in `src/web/pages/flags.ts`, #9872) has no card: one `<section class="settings-block">` under `<h2>Flags</h2>` holds the flags as `.list.setting-list` rows, or one plain sentence when none is declared. Pinned by `test/flags-language.test.ts`.

Settings › General (`settingsPage()` and `provenanceCard()` in `src/web/pages/settings.ts`, #9853) adds no class and holds no `.card`: About, Your team, On its own and Held files (`src/web/studio/crew.ts`, `file_holds.ts`), Branch and gates, Mirror, Show where this came from, Follow upstream and Followed sources (`upstream-follow.ts`), and Cut a wave and Archive are each a `<section class="settings-block">` with an `<h2>`, one plain sentence and the form. The crew-readiness notices (`crewReadiness()` in `src/web/pages/crew.ts`) are `.toast` rows with `data-tone="danger"`. Every form keeps its action, method, field names and ids. Pinned by `test/settings.test.ts`, which asserts the whole page has no `class="card`.
