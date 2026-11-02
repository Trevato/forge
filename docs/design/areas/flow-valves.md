# Flow valves

`/flow` draws the week's budget as pipes (`src/web/flow_pipes.ts`): `.pipes` is the SVG, `.pipe` a pipe whose stroke width is the week's spend, `.pipe-out` the pipe from a repository to shipped, `.pipe-valve` the valve on a repository (`.pipe-valve-open`, `.pipe-valve-share`, `.pipe-valve-shut` say how far it is turned), `.pipe-label` and `.pipe-repo` its text. `.valve-form` is the row of a valve's slider, its words and its Set button, and `.valve-range` the slider itself, which submits on release.
