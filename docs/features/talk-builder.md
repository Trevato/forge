# Talk as a builder (#11009)

`/talk` is two panes on a wide screen: the chat (with the chats sidebar), and on the right the live preview of the repository the chat is working on, with Code and Diff beside it. Preview, Code, Diff and, on a phone, Chat / Preview are plain links (`?pane=`) drawn by the server, so all of it works with the script off; with the script a tab swaps the pane in place, so a streaming reply and the composer's words are kept.

The terminal has the same: the Talk screen (`src/tui/screens/talk_chats.ts`) draws the same steps, names the repository in its header, and `p` flips to the pane's contents: the repository and its pull, the address of what runs (Preview), the pull's files page (Diff) and the files the chat touched (Code). Both read `src/actions/talk_workspace.ts`. A terminal cannot draw a web page, so it prints the preview's address instead of framing it.

- **Which repository:** the last one a tool call in the conversation named (`src/core/talk_steps.ts` `repoOf`), shown only if you can read it.
- **Preview:** the newest open pull's preview environment, else production, framed from the app's own origin (the page lists that one origin in `frame-src`; `originOf` takes scheme, host and port only, so a URL with userinfo names none). It reloads when a turn ends, which is when a push has deployed. Code lists the files the chat touched; Diff links the pull's files page (not frameable).
- **Steps, not JSON:** each tool call is one line ("Read src/a.ts", "Edited src/a.ts (+12)", "Opened pull #12", "Merged pull #12 and deployed"), closed; its `key: value` details open on a tap. Raw JSON is never drawn. The line under a reply summarises ("Read 4 files, opened #12").
- **Stop and Steer** while a reply streams, and the context meter, are unchanged.

Not yet: sidebar grouping by repository (a chat has no repo of its own), added/removed counts on edits (stored calls are cut short; only added lines are known), per-turn versions to go back to.
