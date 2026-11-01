# AGENTS.md

Read `CLAUDE.md` first: it is the rulebook for agents editing this repo.

README.md is capped: a new feature's how-to goes in `docs/features/<name>.md`, not a new README section.

When you write an issue, end it with a `Files:` line naming the files the work touches (`Files: src/a.ts, docs/b.md`). The hot-file hold reads only that line when it is there; without it, every path the issue mentions counts.

A new `forge` command is a new file in `src/cli/commands/` (exporting `command`) plus one line in its `index.ts`.

A new terminal screen offered only to site admins exports its palette `entry` from its own module and adds one line to `ENTRIES` in `src/tui/screens/entries.ts`; `after` names the commands it follows. Entries offered to everyone, and entries gated by a helper (`mayCapacity`, `mayManageFlags`, `canSeeMemory`, `telemetryReader` and the like) rather than by `isAdmin`, stay in `forgeCommands` in `src/tui/forge.ts`.
