# The box pass

An issue's `- [ ]` boxes used to pile up unticked after the pull that did the work landed, and held the issue open for a person. The reviewer that approves the pull now reads its head against each box and reports it.

## Reporting

A crew reviewer's approval, `POST /api/v1/repos/:owner/:name/pulls/:n/review-states`, takes two more lists beside `state`, `body` and `comments`:

- `ticks`: `[{ "issue": N, "box": 1, "text": "the box as listed" }]`, each box the head meets.
- `left`: `[{ "issue": N, "box": 2, "text": "the box as listed", "why": "…" }]`, each box it does not, with why.

`issue` is one the pull's body closes. `box` counts the issue's unticked boxes from 1, in the order the reviewer's brief lists them (fenced code is not counted). `text` is that box's text; at most 50 items per list, 300 characters of `text` and `why`. Anything else answers `422 invalid_boxes` and nothing is recorded.

## What the forge does

- Only an **approval by the repository's crew reviewer** is a pass. Anyone else's `ticks` are ignored.
- The pass is **held** against the head the reviewer read (`pull_pass`, one row per pull; a later approval replaces it). Nothing is ticked yet.
- At **landing**, if the pull's head is still that one, the boxes are ticked, and one comment on the issue names what was ticked and what was left with why (`Reviewed pull #N at its head: …`). If more commits were pushed, or the pull never lands, nothing is ticked.
- A tick whose `text` no longer matches the box now at that number (the issue was edited since the review was read) is ignored, so a tick never lands on another box.
- A box the reviewer does not mention stays open. An issue whose boxes are all ticked closes with the landing; one with boxes left stays open and is the planner's to file as its own issues, never a builder's to redo.

## An issue held before this existed

An open issue whose pull already landed with boxes unticked is sent to the crew reviewer **once**. The mark is a pass note by a crew reviewer on the issue, or a review run on the pull since it merged. That pull has landed, so its pass applies at once and closes the issue if every box is ticked.

The reviewer reads what landed: the merge commit on the base (kept by `refs/pull/N/merged`) against its first parent, so the diff is real when the head's refs and objects are gone. A squash has one parent and is read the same way. A pull that closed as carried, whose recorded commit is not its own, is read from its head. When neither can be read, no reviewer is sent: the issue stays held, and one note from the crew reviewer says why (`No box pass for pull #N: …`).

## Who can do this where

The API is the reviewer's door, and its brief gives the curl. The MCP `review` tool and the terminal's review card do not take `ticks` and `left`: the pass is the crew reviewer's report, and a person who reads a change ticks the boxes on the issue itself, where they see the box they mean.
