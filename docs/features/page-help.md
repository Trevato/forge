# Page help (`? Help`)

The crew pages (`/settings/crew`) and the flow panel (on `/boards`) keep the explanations that change no decision
behind one closed **? Help** disclosure: a 44px target with the word beside the glyph, so a sighted person knows what
it opens, and a visible focus ring. `test/notes-ceiling.test.ts` pins how many notes each page may show.

Try it: open `/settings/crew` or `/boards` and press **? Help**. Add `?help` to the URL (`/boards?help`,
`/settings/crew?help`) and it arrives open with its summary focused; that is how the forge's looks picture it
(`app.looks` in forge.json, taken as the owner), at phone and desktop width, light and dark.

The terminal: the Flow screen ends with the same stage and merge-queue explanations (`src/flow/help.ts`). It has no
crew explanations screen to bring in line: its crew screens are handover and splits, which carry their own wording.

Pinned by `test/page-help-open.test.ts` and `test/forge-looks.test.ts`.
