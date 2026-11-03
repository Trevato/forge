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

## Many conversations (#8814)

A person has any number. `/talk` is their latest, with the list above it (newest activity first), **New**, and **Archived (n)** as the one filter (`/talk?archived=1`). Each opens at `/talk/<id>`, stable across reloads; Rename and Archive/Restore are plain forms (`POST /talk/:id/rename`, `/talk/:id/archive`, `POST /talk/new`), so they work without the script. Another person's id is 404 everywhere. A message with no conversation named goes to the latest one that is not archived.

- **Cap:** a person holds at most 100 conversations, archived ones counted; past it New is refused (page flash, API 409 `too_many`, MCP `too_many`). Stop ends every reply the person has running, in any conversation.
- **API:** `GET /api/v1/conversations[?archived=1]`, `POST /api/v1/conversations {title?}`, `PATCH /api/v1/conversations/:id {title?, archived?}`; `conversation` on `POST …/messages` and `GET …/turns?conversation=` picks one.
- **MCP:** `say` with `action` list | new | rename | archive | restore, and `conversation` to speak in one.
- **Terminal:** Palette → Conversations: `n` new, `r` rename, `x` archive or restore, `a` the archived list, Enter opens one (its last 50 turns; `s` says something in it, `r` reloads); the same calls, so the web list and stream read what it writes.
- Sending to an archived conversation keeps it archived; the page says so above the composer.

## Edit, regenerate, retry (#8817)

Three actions on the last exchange, one door, `talkAgain()` in `src/actions/talk.ts` (the same 12-a-minute throttle and refusals as sending):

- **Edit** replaces your last message with new words and asks again. **Regenerate** asks the same message again for a new reply. **Retry** asks again after a failed turn.
- What is replaced stays in the conversation, marked replaced (`replaced: true` in `GET /api/v1/conversation/turns`), dimmed on the page; the agent no longer reads it, and the new turn starts a fresh session from the turns that still stand.
- A turn that could not answer (a failed run, a resting account) says what happened in plain words, never the raw error, and shows **Retry**.
- Refused while a turn runs (`running`, 409), or when there is nothing to act on (`nothing`, 409).
- **Web:** Edit under your last message (opens the composer holding it, `/talk?edit=1`; Send resends), Regenerate under the last reply, Retry under a failed one. All are plain forms or links, so they work without the script, which only does them in place. They post to `POST /talk/again/edit|regenerate|retry`, from your own signed-in browser only.
- **Terminal:** `ssh <forge> talk-again edit <words>`, `ssh <forge> talk-again regenerate`, `ssh <forge> talk-again retry`.
- With several conversations they act on the one open: the forms post to `/talk/<id>/again/<how>` (`/talk/again/<how>` on the latest); the action takes the conversation as an optional argument.
- There is no API or MCP door for these yet.

## Stop

A turn can be ended mid-reply (`stopTalk` in `src/actions/talk.ts`, `stopTurn` in `src/crew/conversation.ts`). The agent's process group ends with everything it started; the words it had said stay, followed by a `Stopped.` line; the run is stored as `stopped`. Held writes waiting on a Confirm are cancelled before the kill and again after, so nothing lands while the process goes down.

- **Web:** the Stop button beside Send while an answer is running, and `Escape` in the composer. Send still posts the form without the script.
- **API:** `POST /api/v1/conversation/stop` answers 200, or 409 when nothing runs; a read-only token is 403.
- **MCP:** `stop` with no `repo` and no `run` stops the forge's agent; with both it stops that crew run; one without the other is an error. The agent's own token is refused.
- **Terminal:** `ssh <forge> talk /stop` (or `--stop`) exits 0 when stopped, 1 with "no answer is running".

It checks identity, same origin and token scope. Viewers of `/talk` see the `Stopped.` turn arrive over the stream.

## Queue and Steer while an answer runs (#8819)

The composer stays open while the agent works. `say()` in `src/crew/conversation.ts` takes `during`: `inject` (the old behaviour, still the default for the API without `during`, MCP and plain `ssh talk`), `queue` (kept in memory for after the turn; up to 5; each runs as its own turn, in order) or `interrupt` (stops the turn, keeps its words and the `Stopped.` line, and sends the message first). Stop clears the queue; a forge restart drops it. A file attached to a queued message is held: it cannot be removed (409) or sent with another message (`file_taken`), and one gone by the time it runs is left out.

- **Web:** while an answer runs Send reads Queue and Steer and Stop appear. A queued message shows dimmed, "Queued", with Cancel (a post form to `POST /talk/queue/:id/cancel`, so it works without the script); every open tab sees it over the stream (`queued` frame). Cancel puts the text back in the box.
- **API:** `POST /api/v1/conversation/messages` with `during: "queue" | "steer"` (anything else is 422 `invalid_during`; a sixth queued message is 429 `queue_full`); `DELETE /api/v1/conversation/queue/:id` (404 for an id that is not yours or already went); `GET /api/v1/conversation/turns` lists `queued`.
- **Terminal:** `ssh <forge> talk /queue <words>`, `talk /steer <words>`, `talk /queued` (ids and words), `talk /unqueue <id>`; they work with `--attach` too.

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
| Thinking as one closed line; a steps line under a reply ("read 3 files, opened #12"); links to each issue, pull, file or app the turn opened or changed | this pull | AI Elements `Reasoning`, `ChainOfThought` |
| Many conversations: new, list, rename, archive, URL each | have (#8814) | search is not added yet |
| Edit and resend, regenerate, Retry (see below) | have (#8817) | replaced turns are kept and marked, not deleted |
| Queue and Steer while an answer runs | #8819 | `Queue` / `PromptInput` |
| Cost under each reply and how full the context is (header, and in the terminal) | this pull | the run's own usage record, never an estimate |
| Attachments, tables, plan line | later | need storage / token data / markdown tables |
| Code highlighting and tables in replies | this pull (#8816) | a reply is stored whole and drawn whole, so no half-open fence is ever tokenised |

**Without the script** the page is a plain form: Enter adds a line, starters are links that prefill the box, and Copy and Latest are not drawn (the script draws them, along with the "Enter sends" hint). The log is `role="log"`; with the script, a new message while you are scrolled up is announced in the status line.

**Cost and context.** Under a finished reply a quiet line gives the turn's dollars (`$0.12 this turn`); above the log, "Context 85% full (170k of 200k tokens)". Both are read from the run's record (`conversation_run`: `cost_usd`, and `context_tokens`/`context_window` from the last message's usage and the result's `modelUsage`), shown by `core/conversation_cost.ts`. When a run names no window, 200k is assumed and the line says so by showing it. From 80 % the line adds that a new conversation answers faster and costs less (information only: there is no way to start another yet, see "Many conversations"). A reply that streams in gets both when the stream ends; the terminal prints the last turn's cost and the share after its confirmation line.

**Stopped is not failed.** A turn the person stopped is stored with `conversation_run.state = 'stopped'` (the `stopped` column is kept and set alongside, only for a release still in play that counts by it). The flow vitals line says it apart: `Talk: 2 turns failed, 1 stopped by the person` (`flow/talk_turns.ts`), and the failure rate leaves stopped turns out. The line is in the flow telemetry (`GET /api/v1/telemetry/flow` and the MCP flow tool) as `vitals.says`, with the counts at `vitals.talkTurns`.

**The terminal** (`ssh <forge> talk <words>`, `forge talk`) sends one line and prints the answer; it has no log, so who/when, copy, tool cards, starters and the jump button do not apply to it. `forge talk` prints a thought as one `thinking:` line, then the reply, the steps line and the links as paths (the API's agent turns carry `work: {steps, links}`). The steps line says "opened" for a read issue or pull and "changed" for a tool that writes one (`CHANGES` in `core/talk_work.ts`, held to the MCP tools' `writes` by a test); numbers carry their repo when a turn touched more than one. A reply first on an older page, or first in a stream batch, reads its calls from the turns before the page (`worksOf`), so it says the same on every door. The conversation's whole history is read through `GET /api/v1/conversation/turns`, where every turn carries its role and time.

## Code, tables and Copy in a reply (#8816)

An agent reply is Markdown, drawn on the server by the same renderer as a README: fenced code is highlighted, tables and links render, and everything else is escaped (a `<script>` in a reply shows as text). A table wider than the column scrolls inside it; the page does not. The reply sits in the column like a person's turn, with none of the README's padding or line measure.

A reply arrives as one finished turn, never as growing text, and the page only appends a turn whose id it has not drawn (a repeat is ignored). Turns already on the page are not touched, so nothing above a new reply moves, and the page follows the end only if you were already there (otherwise "Latest" appears). An unfinished fence in a stored reply is closed for drawing. The page's own bytes are held by a test: the stylesheet under 3.5 KB, the script under 7.4 KB, and a page with a code reply under 40 KB.

**Copy:** each code block and each message has a Copy button, which copies the text, not the markup. The buttons are drawn by the script: with JavaScript off there are none, and the code is still there to select.
