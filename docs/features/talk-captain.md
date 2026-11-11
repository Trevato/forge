# Talk runs the captain (#11011)

Talk is where the forge's owner steers it. What the owner used to do in a Claude Code session runs here.

- **Instructions.** In Talk the owner's message is an instruction acted on at once, with the owner's own powers through the MCP: file issues, assign, steer, reopen parked pulls, merge, lend credit. Real money, DNS and a dark roll are held as a write with Confirm and Cancel buttons in the thread (`crew/conversation_brief.ts`, `crew/conversation_confirm.ts`).
- **Memory** (`core/talk_memory.ts`, Settings › Captain, `/settings/captain`). Short durable rules and decisions, up to 60 of 400 characters. Every Talk turn carries them in its system prompt (`memoryBrief`). The first visit offers the starting rules (never `rm`, tokens off argv, never dark without a go, ask first on money, DNS and a dark roll); delete them and they stay gone.
- **Routines** (`core/talk_routines.ts`, `crew/routines.ts`, `crew/routine_report.ts`). The hourly forge check-in, the friends watch and the morning paper, each with an editable schedule: every 15 to 1440 minutes, or daily at an hour (UTC). Each posts at most three lines into the owner's **Captain** thread; only a report that says something needs the owner reaches the phone (the notify URL, `crew/notify.ts`). The lines are computed, not written by a model, so a routine costs no spend. A forge that was down runs an owed routine once on waking. **Post now** on the settings page runs one at once.
- **Resume.** A thread resumes its Claude session (#10457). When the last turn left the context 85% full, the next turn starts a fresh session from the thread's stored record and the memory, and the thread says so (`CONTEXT_RENEWED_LINE`).
- **Terminal** (`tui/screens/captain.ts`, palette › Captain, owner only). The rules, then the three routines, in one list. `a` adds a rule; `enter` edits the rule or the routine's schedule under the cursor; `d` deletes a rule; `space` turns a routine on or off; `p` posts a routine now; `r` reads again. A schedule is typed as minutes, `45` for every 45 minutes (15 to 1440), or `at 7` (also `daily 7`) for daily at 07:00 UTC.

The check-in also names the releases cut since the last one and the pillars that merged work (`crew/routine_facts_story.ts`), in one clause of its third line, since the last check-in (`lastAt`; the git changelog is cached by head oid, so this costs a `rev-parse` between releases); it never reaches the phone for that alone.

Not here yet: child forges stuck.
