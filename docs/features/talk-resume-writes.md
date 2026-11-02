# A write the restart cut short, in a conversation

When the forge restarts while its agent is answering you on `/talk`, the turn
is picked up where it stopped (`resumeInterrupted` in
`src/crew/conversation.ts`). If a write the agent had started never recorded
how it ended, for example a `close` or a `merge`, you see one extra line
after "The forge restarted…":

> The restart came while this write was running, and I do not know whether
> it finished: close. Until this answer ends, it cannot run again unchecked;
> please look, and if it still must be done, ask me after this answer and I
> will do it then.

The line names only the writes that started and never ended, not the ones that
finished. If every write ended, there is no line.

## Getting the write done again

1. Check whether it happened: open the issue, pull or page it touched.
2. If it did not happen, wait for the resumed answer to finish, then send a
   new message asking for it, e.g. "close issue 6 again".

That message starts a fresh turn, and a fresh turn forgets the cut turn's
write records (`forgetWrites`, `src/core/conversation_writes.ts`), so the same
write runs the first time it is sent. During the resumed answer itself,
sending the identical write again is answered `already_done` once
(`claimDone`, `src/http/mcp.ts`), so the restart never makes a write run
twice without anyone checking.

The line is an ordinary agent turn. The page draws it with `renderMarkdown`,
which escapes its input (`src/web/pages/talk.ts`), and `forge talk` prints it
through `inert` (`src/cli/commands/talk.ts`).
