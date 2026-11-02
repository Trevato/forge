### 6a. The code browser

Tree and blob pages are one layout, not two: a `.code-layout` grid with the
explorer on the left and the content on the right at ≥900px, the explorer
folding into a "Files" `<details>` above the content below it.

- **The spine, not the tree.** A page renders the path's ancestors and their
  siblings, never the whole repository, so a monorepo costs the same markup as
  a toy. Every directory is a `<details>`; the ones on the spine arrive open.
- **A folder the server did not expand is still a link.** Opening one with no
  script shows a single `Open src/…` link to that folder's own page; with a
  script, `codeJs` fetches `?fragment=explorer` and drops the rows in.
- **The preview is the page.** Hovering or arrowing a file fetches the blob
  route's own `?fragment=1` — the same renderer, the same markup, the same
  `#code-pane` — so a preview and a real navigation are indistinguishable, and
  `enter` simply follows the link that was already there. Fetches are
  cancelled and cached, and there is no scroll-stealing or URL rewriting.
- **The explorer opens closed and the stylesheet opens it.** `<details>`
  without `open`, plus `::details-content { content-visibility: visible }` at
  ≥900px. Where that pseudo-element is understood the handle is hidden too;
  where it is not, the handle stays and one click opens the column. Nothing
  can end up invisible with no way back.
- **The finder is a dialog over JSON.** `t` (or the button) fetches
  `/:owner/:name/paths/:ref` once and scores it client-side with fzf's
  FuzzyMatchV2 constants under its `path` scheme — boundary 8, delimiter 9,
  camel 7, consecutive 4, match 16, gap −1, first character doubled, string
  start treated as though it followed a `/` — on top of a 28-bit
  characters-present bitmask prefilter and a two-pointer subsequence check, so
  the affine-gap DP only ever runs on real candidates. VS Code's tiering sits
  above the score rather than inside it: any match inside a file's own name
  outranks any match that only lands in its directories, and a basename
  _prefix_ outranks that again. Without a script the finder does not exist and
  the explorer beside it is the answer.
