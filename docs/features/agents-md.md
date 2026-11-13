# AGENTS.md on every repository

Any repository you may read answers `/<owner>/<name>/AGENTS.md`, as plain text. Open `https://<forge>/alice/notes/AGENTS.md` in a browser or `curl` it.

- If the repository has an `AGENTS.md` in its root on the default branch, that file is the answer, word for word.
- If it has none, the forge writes one: how to install, how to run the tests, how commits and pulls are expected, and the contribute flow in five lines, with the exact clone URL and the one host a sandbox must allow (this forge's own).
- A file over 200 KB is not served; the generated text answers and says so.
- A private repository answers 404 to anyone who may not read it, a guest included.

`/llms.txt` opens with the same doors (git, MCP, the web) and the egress host, and points at this route per repository.

## In the terminal

With a repository open, press `:` (or Ctrl-K), type `AGENTS.md` and press enter. The screen shows the same text the route answers; `j` and `k` scroll, `esc` goes back. It is offered to anyone who may read the repository.
