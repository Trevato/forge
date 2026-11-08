# An assigned ask can be settled where it stands

A pull or issue assigned to you, on `/asks` and in the terminal's On you pane, is not only a link to open.

- **Give to the crew** (`b` in the terminal) assigns it to the crew member who last worked on it; for an issue nobody worked on, to a builder on the crew. The pull and the open issue it closes move together, with a comment saying who gave it back.
- **Close** (`x`) closes it with an optional reason.
- **Land** (`S`) is offered only when the pull's check is green and no change is requested on its head; the web hides it otherwise, and landing is refused again by the action.
- One accent per card: Give to the crew is the primary button, Land and Close are plain.

## The one-day sweep

A pull you hold with changes requested by a crew reviewer stops the crew, since a person's name on it keeps agents off. The change must be asked of the pull's current head (a verdict on an older push strands nothing). If a day passes since the latest of the verdict, your last comment or review, and the moment the pull was assigned to you, each autonomy tick gives it back to its builder with the line "Given back to the crew: a reviewer asked for changes and no one answered for a day…". At most three per tick; a held pull (a person's hold) is left alone. The assignment is recorded under the person who turned autonomy on for the repository (else the holder); the comment says the forge did it. The sweep keeps no state, so pulls already stranded are covered.
