# Pixel art (#10570)

The forge's own art, drawn in `src/web/pixel.ts`, no outside assets, no credits, no dependencies. Every pixel is painted
with a `fill` attribute from `--fg`, `--muted-fg` or `--card`, so it follows all six themes. Drawings are symbols in the one hashed icon sprite; a page carries a
short `<svg>` and a `<use>`.

- `.px` is a drawing of pixels: crisp, never smoothed. `data-state` says what is true: `working` (a run is going; two
  frames swap on `--beat`), `landed` (one hop, once) or nothing known (it just stands).
- `.px-a` and `.px-b` are the two frames of a working figure. Under reduced motion only `.px-a` shows.
- `.px-scene` is the one small drawn scene, on the first-run "No apps yet" (`empty({ scene })`).
- `.avatar-px` is an avatar that is a crew member's face instead of initials.

Motion is one vocabulary, tokens in `style/base.ts`: `--dur-1` (100ms), `--dur-2` (140ms), `--dur-3` (200ms), `--beat`
(450ms). A figure never moves without a fact behind it, and nothing moves inside a large inline SVG (the map's faces are
still).
