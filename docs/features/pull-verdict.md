# A pull opens on its verdict

This page is for anyone who reviews or merges a pull. Every pull opens on one line: can it land, and if not, what holds it.

## Where you see it

- **The pull's page** opens on the line, then the description's first paragraph and the size of the change (files, `+added −removed`). Reviews, checks and the conversation come after. The number of files links to the Files tab, where the diff's own rows list them.
- **The Files tab** repeats the line above the diff, next to the merge box it describes.
- **The terminal** (`ssh`, the pull screen) shows the same words under the pull's title.

## What it says

One of: *Ready to land*, *Waiting for a review*, *A reviewer asked for changes*, *Waiting for a team's review*, *Waiting for the check*, *The check failed*, *Conflicts with `<base>`*, *Merges on the origin*, *Merged*, *Closed without merging*. The words are asked in the order the merge box and the merge itself ask them, so the line never says *Ready* where the merge would refuse.

Beside it, one action when you can take it: **Go to merge** (scrolls to the merge box on Files), **Review**, **See the check**, or **Resolve** for a conflict. It is a link; the merge itself is still the button in the merge box.

## Try it

Open any pull at `/<owner>/<repo>/pulls/<number>`; its first line is the verdict. Over `ssh`, open the pull from the repository's list.
