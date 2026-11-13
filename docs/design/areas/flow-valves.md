# Flow valves

`/flow` draws the week's budget as pipes (`src/web/flow_pipes.ts`): `.pipes` is the SVG, `.pipe` a pipe whose stroke width is the week's spend, `.pipe-out` the pipe from a repository to shipped, `.pipe-valve` the valve on a repository (`.pipe-valve-open`, `.pipe-valve-share`, `.pipe-valve-shut` say how far it is turned), `.pipe-label` and `.pipe-repo` its text. `.valve-form` is the row of a valve's slider, its words and its Set button, and `.valve-range` the slider itself, which submits on release.

## The page (one system with the home and the boards)

`/flow` answers "what did the week's money buy, and which repository may spend more of it". It is the home's column and head (`.hf`, `.hf-head`), then one sentence of what stands out this week (`.bd-lead`: who spent the money, how the valves stand) with only the things that are wrong right now under it, then four of the home's figures (`figure()`): spent, pulls shipped, the cost of a pull, valves open (its note is how a valve is turned). Under them the picture, with no heading of its own, and the valves; what waits, where the crew gives up and the estimates are `.bd-block`s that show only when they have something. No card boxes. The first view stays inside its budget (docs/design/attention-budget.json). Money is said one way (`usd()`: $4.57, $608), durations one way (`span()`: 3h 5m).

- `.pipes-block` — holds the picture. It is never drawn wider than 720px, so its words stay their own size; under 600px it is not shown, because the valves under it say the same numbers and a picture at half size cannot be read.
