# Toolbar page

- `.change-line` — a preview's toolbar page: the pull's diff totals and its check badge on one wrapping line, each link 40px tall (the dense-row step, set by padding) and 44px under `@media (pointer: coarse)`. It shares `.diff-summary`'s `.add`/`.del` colours. A stack of `.diff-summary` and the badge cannot carry the sizing: `.diff-summary` is a padded block, not a row of separately tappable links, and the badge is not itself a link target.
