# Home

- `.tell-box` — home's one-line box that tells the crew: a `bar` whose text input takes the free width (`flex: 1 1 14rem`) and wraps the app picker and Tell under it on a phone.

- `.step-body` — the first-login next steps (`src/web/pages/next-steps.ts`, #9837) are one plain section: `<h2>`, then a `ul.list` row per step (title, Done trail) with the pending step's body (form, app buttons, Tell the crew) as a block under its row, indented past the lead icon (44px, 16px on a phone) on the 4px scale. No box, no border; the bold title marks the primary step and the one `variant="primary"` button is its accent.

The signed-in home's door line (Notes, Talk) is `.home-doors`: accent underlined links, each a 44px tap target (#9584).

`/explore` (#9645) speaks the same language: the kinds (All, Apps, People, Forges) are `tabs()` as on home; sort and time stay one `seg` each in a small line (they stay boxed: they are two-to-three-way switches whose current choice must read at a glance, and a plain link row would blur it from the tabs above), with "Show archived" a link (`aria-pressed`) wearing `.home-doors`' 44px hit area, no box; the rows are a `.card.bare` list, rows and space on the page's one background, no box. Row words, ranking, "Make it yours" and the URL line are unchanged, so the terminal's explore search keeps the same words. No new class.

