# Direction

The repository's direction drawn with its two authors told apart (`src/web/studio/direction.ts`), on Settings → Crew and
on an open vision pull's page.

- `.direction-text` — one part of the direction as plain wrapped text (`white-space: pre-wrap`, `overflow-wrap: anywhere`
  so a long unbroken line never scrolls a 360px page sideways). A part is badged `follows docs/VISION.md` (the fenced
  block) or `the owner's`; the stacked "Today" and "After the merge" blocks of the pull's card are `[data-direction]`
  hooks, each part `[data-direction-part]`, used by tests only.
