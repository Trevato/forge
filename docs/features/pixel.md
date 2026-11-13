# Pixel art: the crew's faces (#10570)

Scout, Mason, Torque, juniper and sentinel have a 16×16 face, drawn in `src/web/pixel.ts` as a grid of characters. No
outside asset, no dependency. Each pixel is a rectangle with a `fill` attribute from `--fg`, `--muted-fg` or `--card`
(or a mix of the two last), so the art follows all six themes, adds no accent, and passes the page's CSP (a `style=`
attribute would be blocked; `test/pixel.test.ts` fails if one is emitted).

## Where they show

- As the avatar wherever a crew member's name appears (`avatar()`), hidden from a screen reader since the name is text.
- Working (two frames swapped on `--beat`) beside a run that is running, and in the terminal home's "Being built" rows; still
  otherwise. Under reduced motion only the first frame shows. A face never moves without a run behind it.
- One hop on a run page when the run landed.
- Still, on the map's cards.
- One small drawn scene, on the "No apps yet" first-run state, and nowhere else.

## Both doors

The terminal has no counterpart on purpose: this change draws the web's avatars and one first-run picture, and every
fact they sit beside (who, working, landed) is already text in the TUI. There is nothing to render there.

## Motion

Timings are tokens in `style/base.ts`: `--dur-1` (100ms), `--dur-2` (140ms), `--dur-3` (200ms), `--beat` (450ms).
