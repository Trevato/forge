# Knobs

The crew page's Knobs (`knobsCard()` in `src/web/pages/knobs.ts`) is a `dl.status-rows` list: one `.status-row` per knob, its name, its live effect, and the control in the row's `.status-act`. The `Set` button is a quiet `ghost` button, so the page keeps its one accent.

- `.input-num` — a number input at five characters' width (`.input.input-num`), for a count or a percent beside its button.
