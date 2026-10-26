### 6c. The editor

`GET /:owner/:name/edit/:ref/*path` is a `<textarea>` in a `<form>`, and one
rule governs it: **a refusal never costs you your typing.** A protected
branch, a file over the size cap, a branch name git will not take, an origin
that said no — each re-renders the same page with the text, the message, the
branch name and the pull-request fields exactly as they were, and the reason
above them. `test/web-editor.test.ts` asserts that, not just the happy path.

The commit box is one submit, because `editFiles` is one call: message,
target (`current branch` / `new branch <name>`, defaulting to
`alice/edit-<file>`), and optionally a pull request from the new branch back
to where you started. Where committing straight to the ref is not on offer at
all — a protected default, or a ref that is not a branch — the page says so on
the disabled radio rather than letting somebody find out after typing.

**The highlighted mirror.** Under the textarea sits a
`<pre id="editor-mirror">` holding the same text, syntax-coloured; the
textarea on top of it has transparent text and a visible caret. They share one grid cell and one set
of metrics — font, size, line height, padding, tab size — because a single
divergence puts the caret in the wrong place, and the _height ceiling lives on
`.editor-wrap`_ so the gutter, the mirror and the textarea are always the same
height and scroll as one. The mirror is rendered by the server for the first
paint, so there is no flash of uncoloured code, and kept in step by
`window.forgeHighlight`, which is `web/highlight.ts` itself bundled by
`Bun.build` at first use and served from `/assets/highlight-<hash>.js`,
immutable. That asset is the one thing that relaxes the script CSP — from
"this page's nonce" to "this page's nonce, or a file from this origin" — and
only the editor page asks for it.

An edit re-scans from the first changed line and stops as soon as the state
entering an unchanged line matches what it was before, so typing costs one
line's work; the DOM is patched line by line rather than rebuilt. Tab inserts,
Enter keeps your indentation, brackets and quotes close themselves (and wrap a
selection), `⌘/Ctrl+S` submits the commit form, and the current line is
marked. `⌘/Ctrl+F` is left to the browser on purpose: the mirror holds real
text, so the page's own find lands on the line you were looking for.

**It degrades, in that order.** Over 200 KB or over 10,000 lines the server
sends no mirror and no bundle — a file that size is not hand-edited in a
browser, and a slow editor is worse than an unhighlighted one. If the bundle
fails to build or never loads, the page keeps the plain textarea, because the
textarea's own text only turns transparent once the mirror is live. With no
JavaScript at all it is a `<textarea>` in a `<form>`, which is what it was
before any of this. The Preview tab is offered on Markdown only, and renders
through the same `/preview` fragment the server will use for the file.

**Origins are web-only.** Connecting, syncing and browsing an origin live on the web pages (`/origins`) and in migrate; the terminal has no origins screen. On a mirrored repo's home `y` syncs the mirror and `P` pins it — `p` has meant _pulls_ on that
screen since before pins existed, so the toggle takes the shifted key there
and the plain `p` everywhere a repo is a _row_ (the dashboard, explore).

The connect chooser is ordered by what actually gets somebody connected:
**Personal access token — recommended** first (paste a string, no setup at
all), then **GitHub, one click** (needs a one-time OAuth app setup) and
**Forgejo / Gitea, one click** (needs an app registration on the instance).
Each row carries that condition on its own line rather than failing later
with an error about an environment variable.

**The where strip.** Every repository screen carries one line directly under
its title, naming the three places a repository can be and marking which one
the bytes on screen came from:

```
● codeberg.org  ·  ○ workbench  ·  ○ this machine
reading live from codeberg.org — read-only · m mirror into your workbench

● codeberg.org  ·  ● workbench (synced 3m ago)  ·  ◆ this machine

● workbench  ·  ○ this machine
```

The first is a live browse (and only a live browse gets the second, muted
banner line); the second is a mirror that is also pinned; the third is a
native repository, which has no origin and therefore no first place. The dot
is the grammar — **accent** is the place being read from, **success** is a
place that has this repository, **muted** is a place that does not:

| glyph | means                                                      |
| ----- | ---------------------------------------------------------- |
| `●`   | this place has the repository (accent = reading from here) |
| `○`   | this place does not have it                                |
| `◆`   | kept on your machine (pinned)                              |
| `▲`   | this came from the origin — an imported author or activity |

**Read-only means read-only.** A screen over a live source has no write keys
at all — no `c` comment, no `x`/`o` state, no `l` labels, no `m` merge, no
`,` settings, no `F` fork — because `capabilities.write` is false and the
source has no method that could write. In their place the help bar shows
`m mirror` and `O open on origin` — first, ahead of the navigation keys,
because at 80 columns the bar has room for about six bindings and those two
are the only things you can actually do here. The banner carries the long
wording; `w` opens the workbench copy when one already exists.

**The mirror card.** `m` opens a checklist over whatever screen you were on:
`creating → fetching → labels → issues → pulls → comments`, a spinner on the
stage in progress with the job's own words beside it ("42 issues"), and the
elapsed time. `esc` hides it and the mirror keeps running, toasting when it
lands; on `done` the live screen underneath is replaced in place by the same
screen over the local source, and the strip flips to `● workbench`; on
`failed` the card shows the scrubbed reason and `r` retries.
