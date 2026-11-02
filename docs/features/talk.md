# Talk to the forge's agent

One door, `talk()` in `src/actions/talk.ts`, three ways in. It sends the words as you (your verified identity, never a name in the text), limits you to 12 a minute, and starts one agent turn, or steers the one already running (`src/crew/conversation.ts`).

- **API:** `POST /api/v1/conversation/messages {"text"}` answers 202; `GET /api/v1/conversation/turns` reads the conversation and whether an answer is being written.
- **MCP:** `say` with `text` and no `repo` or `number`. The agent's own token is refused, so it cannot wake itself.
- **Terminal:** `ssh <forge> talk <words>` (the words are not passed to a shell), and `forge talk <words>`, which prints the answer.

It needs a granted Claude account (`no_account`), and says `resting` when none can serve it or your daily ceiling is spent. At most four turns run across the forge at once (`TURNS_LIVE_MAX`); a new one past that is `busy` (429, `retry-after: 60`), while a message into your running turn always goes through. A message that is refused is not kept in the conversation.

`GET /api/v1/conversation/turns?limit=` takes 1 to 200 turns; absent, empty or not a number is 50.

## On the web: `/talk`

Reached from the Talk icon in every page's top bar, "Talk to the forge" in the palette (`Ctrl/Cmd+K`), `g t`, and the Talk button beside the tell box on home. Signed out, it sends you to /signin and back. It shows your own conversation (the last 50 turns, "Earlier" pages back) and a composer; Ctrl+Enter sends.

A reply streams in over `GET /talk/stream?after=<turn id>` (server-sent events, one `turn` frame per turn, each carrying the server-rendered markup). The stream ends with the turn (`done`), or after 40 seconds (`more`), well inside the edge's timeout; the page then reconnects from the last turn id it saw (`Last-Event-ID` works too). Without the script the composer is a plain form and a reload shows the answer.

When the agent asks first (`needs_confirm`), the turn draws **Confirm** (the existing yes) and **Cancel** (a no: the confirm is spent, nothing runs, a turn says it was cancelled). A result shown once (an invite link) is drawn by Settings → Confirms instead, where Confirm leads.
