# Component specs

`helper.ts` checks a component's rendered HTML: every control has a role and an accessible name,
a non-native control has `tabindex` and a key handler, a control is 44 px on a thumb (read from
`src/web/style/components.ts`), and nothing is hard-coded left or right: inline `style`, `align`,
and every stylesheet rule that matches a rendered node.

Add a spec: `test/ui-spec/<export>.test.ts` calling `expectAccessible(component(...))`, then delete
the export's name from `EXCLUDED` in `coverage.test.ts` (that test fails until you do). A known gap
is named in the call, never passed silently: `{ unsized: ["a"] }` for a control the stylesheet gives
no size, `{ physical: ["select.input"] }` for a rule with a physical side, `{ tapTargets: false }`.
