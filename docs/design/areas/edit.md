# Edit

The editor's errors follow §5's form field: an error about one input sits in that input's `.field` as `.error`, with
`data-invalid`, and the input carries `aria-invalid` and `aria-describedby`. A new file's path input and the fork's
branch input live outside `field()` (the path sits in the editor's head row, with no visible label), so their `.error`
row is written by hand to the same shape. An error that belongs to no input (not allowed, branch moved, origin
unreachable) is the page's one flash, `tone=danger`, passed to `page()` as `flash` because the form re-renders in place
instead of redirecting.

The commit section of the editor and the delete page add no component class. As on the home page they are a heading, plain
sentences, the fields and the one button, no box: each is a `<section class="settings-block">` with an `<h2>` (the commit
section keeps `.editor-commit` for its spacing). Field names and the `data-preview`/`data-path` hooks are unchanged.

The issue page's folded Edit form is the same: plain title and body fields and Save, no box (`.card` and `.comment-form`
are gone from it), spaced like the home composer. It adds no component class.

With `?edit=1` the fold is drawn open (no script), which is what the preview's phone look of the issue page takes (#10074); `test/issue-fit.test.ts` holds it and measures no sideways scroll at 390 px.
