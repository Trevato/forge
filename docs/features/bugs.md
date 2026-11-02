# Bugs on a clock

An open issue labelled `bug` is answered, fixed or closed as won't fix within a limit.

- **Which labels count.** `bug` makes an issue a bug. Also `high`, `priority: high` or `priority:high` (any case) makes it high priority. Pull requests are not bugs.
- **Clocks.** 4 h from the issue's creation when high, 48 h otherwise (`src/flow/bugs.ts`).
- **Pickup order.** Queued agent runs about an open bug start before every other run (`startOrder` in `src/crew/dispatch.ts`). This is policy: bugs also outrank the team dials, which then order the rest. Within each side the queue keeps its order.
- **Alarm.** One `bug_clock` alarm names the bug that has gone longest past its clock, and how many more there are. It appears wherever alarms do (home, `/boards`, MCP and API telemetry). For a guest or an agent it counts public repositories only.
- **Tile.** Home's **Open bugs** tile (admins only) shows the open count and how many are past their clock; it links to `/boards`.
- **Terminal.** The **Bugs** palette entry shows the same count (admins who are people) and the alarm (cut to public for everyone else).
- **Closing.** Closing a bug needs a reason: see `bug-close.md`.
- **Polish share.** The setting, the week lines and the dispatch hold are in [polish-share.md](polish-share.md).
- **Not yet.** Shortcuts and hunters' findings of #8709 are not built.
