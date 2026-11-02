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

## Stop

A turn can be ended mid-reply (`stopTalk` in `src/actions/talk.ts`, `stopTurn` in `src/crew/conversation.ts`). The agent's process group ends with everything it started; the words it had said stay, followed by a `Stopped.` line; the run is stored as `failed`. Held writes waiting on a Confirm are cancelled before the kill and again after, so nothing lands while the process goes down.

- **Web:** the Stop button beside Send while an answer is running, and `Escape` in the composer. Send still posts the form without the script.
- **API:** `POST /api/v1/conversation/stop` answers 200, or 409 when nothing runs; a read-only token is 403.
- **MCP:** `stop` with no `repo` and no `run` stops the forge's agent; with both it stops that crew run; one without the other is an error. The agent's own token is refused.
- **Terminal:** `ssh <forge> talk /stop` (or `--stop`) exits 0 when stopped, 1 with "no answer is running".

It checks identity, same origin and token scope. Viewers of `/talk` see the `Stopped.` turn arrive over the stream.

## Chat features: have, adding, not adding (#8752)

Prior art read: Vercel AI Elements (Apache-2.0 React on shadcn; anatomy and behaviour ported, no code copied), AI SDK UI, ChatGPT and Claude.ai. No React: the page stays server-drawn with a small script.

| Feature | Status | Why |
| --- | --- | --- |
| Server-drawn history, streaming over SSE, resume from turn id | have | the base of this page |
| Confirm / Cancel in place for held writes | have | trust rule |
| Enter sends, Shift+Enter breaks a line, autosizing box | this pull | what every chat does |
| Draft kept on reload (localStorage, this device) | this pull | cheap, local |
| Who and when under each message; copy a message; copy a code block | this pull | AI Elements `Message`, `CodeBlock` |
| Tool calls as closed cards | this pull | AI Elements `Tool` |
| Starter questions on an empty chat (links to `/talk?q=`, so they work without the script) | this pull | AI Elements `Suggestion` |
| Stick to bottom, "Latest" jump button | this pull | AI Elements `Conversation` |
| Many conversations: new, list, search, rename, archive, URL each | next pull | needs a migration: today one row per person |
| Edit and resend, regenerate, Stop, queue | next pulls | need turn deletion and a cancel on `crew/conversation.ts` |
| Cost under each reply and how full the context is (header, and in the terminal) | this pull | the run's own usage record, never an estimate |
| Attachments, tables, thinking, plan line | later | need storage / token data / markdown tables |
| Code highlighting and tables in replies | this pull (#8816) | a reply is stored whole and drawn whole, so no half-open fence is ever tokenised |

**Without the script** the page is a plain form: Enter adds a line, starters are links that prefill the box, and Copy and Latest are not drawn (the script draws them, along with the "Enter sends" hint). The log is `role="log"`; with the script, a new message while you are scrolled up is announced in the status line.

**Cost and context.** Under a finished reply a quiet line gives the turn's dollars (`$0.12 this turn`); above the log, "Context 85% full (170k of 200k tokens)". Both are read from the run's record (`conversation_run`: `cost_usd`, and `context_tokens`/`context_window` from the last message's usage and the result's `modelUsage`), shown by `core/conversation_cost.ts`. When a run names no window, 200k is assumed and the line says so by showing it. From 80 % the line adds that a new conversation answers faster and costs less (information only: there is no way to start another yet, see "Many conversations"). A reply that streams in gets both when the stream ends; the terminal prints the last turn's cost and the share after its confirmation line.

**The terminal** (`ssh <forge> talk <words>`, `forge talk`) sends one line and prints the answer; it has no log, so who/when, copy, tool cards, starters and the jump button do not apply to it. The conversation's whole history is read through `GET /api/v1/conversation/turns`, where every turn carries its role and time.

## Code, tables and Copy in a reply (#8816)

An agent reply is Markdown, drawn on the server by the same renderer as a README: fenced code is highlighted, tables and links render, and everything else is escaped (a `<script>` in a reply shows as text). A table wider than the column scrolls inside it; the page does not. The reply sits in the column like a person's turn, with none of the README's padding or line measure.

A reply arrives as one finished turn, never as growing text, and the page only appends a turn whose id it has not drawn (a repeat is ignored). Turns already on the page are not touched, so nothing above a new reply moves, and the page follows the end only if you were already there (otherwise "Latest" appears). An unfinished fence in a stored reply is closed for drawing. The page's own bytes are held by a test: the stylesheet under 3.5 KB, the script under 6.5 KB, and a page with a code reply under 40 KB.

**Copy:** each code block and each message has a Copy button, which copies the text, not the markup. The buttons are drawn by the script: with JavaScript off there are none, and the code is still there to select.
