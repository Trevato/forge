# Edit

The editor's errors follow §5's form field: an error about one input sits in that input's `.field` as `.error`, with
`data-invalid`, and the input carries `aria-invalid` and `aria-describedby`. A new file's path input and the fork's
branch input live outside `field()` (the path sits in the editor's head row, with no visible label), so their `.error`
row is written by hand to the same shape. An error that belongs to no input (not allowed, branch moved, origin
unreachable) is the page's one flash, `tone=danger`, passed to `page()` as `flash` because the form re-renders in place
instead of redirecting.
