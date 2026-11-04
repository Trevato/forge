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
