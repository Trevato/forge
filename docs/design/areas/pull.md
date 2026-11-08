# Pull

Every forge pull's preview carries desk and phone looks of this page as the owner, over the preview seed's `/preview-admin/sample/pulls/3` (#8865).

A pull is one change waiting on a person: read it, see its check, ship it or say what is off (#8773).

At rest: the state is a dot (`.dot`, `role=img`, one `aria-label`, no `title`), with the word written beside it once the pull is settled. The check is one muted line. The decision is a plain block holding the page's one primary action (Ship); Comment steps down while it is there. The path line carries "Next: …" in the same paragraph. The where strip is left to the repository's home.

Rare actions (Hold, Take it back) sit in a `<details id="more" class="mt mb">`, the same disclosure Hold always used. Their palette rows link to `?more=1#hold` / `?more=1#take-back`: the server renders the details open for `?more`, so the target is visible with no script. Every other action is a palette row too (`pullActions`, "This pull request"). No new class.

The terminal's pull screen (`src/tui/screens/pull.ts`) draws its own rows and shares no markup with this page; it needs no change.

On a 390 px phone the page does not scroll sideways (#9327): the title (`.page-head h1`) and every `.mono` (branch names) wrap with `overflow-wrap: anywhere`, comments already do through `.prose`. The diff scrolls inside its own box. No new class; `test/pull-phone-fit.test.ts` holds it.

`.split` (content.ts) has one `minmax(0, 1fr)` column below 960 px, so a long unbroken line in a comment cannot widen the page. It is global to every `.split` page; the `min-width: 960px` and `data-rail="wide"` rules come after it in the same file and still set their two columns, so desk layouts are unchanged.

The pull page's cards (merge box, review, commits, slices, run-this-code) are `.card.bare` (#9588): rows and a heading on the page's one background, no box. A bare card draws no tone, so the merge row carries none on the card: its state is the sentence's opening word ("Ready to merge", "Waiting on checks.", "Merged.", "Closed without merging.") with the tone's `.dot` before it, a word and a mark, not colour alone. The team verdicts are a `.list` of `.row`s, not a card. What stays a box: each file's diff (code scrolls inside its own frame) and the comments, which `thread.ts` draws for the issue page too; turning those into rows is the timeline's change, not this page's. No new class; `test/pull-merge-box.test.ts` holds it.

## The conflict resolver (#9713)

`/:owner/:name/pulls/:number/resolve`: each conflict block, the crew proposal and the empty states are `.card.bare` (#9588), a heading over rows on the one background. The two sides lose their hairline box; the taps keep theirs (a control). The ours/theirs/both/Mine taps, the text box and `#crew-proposal` are unchanged. No new class; `test/conflicts.test.ts` holds it.
