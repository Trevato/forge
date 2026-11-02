# The forge's spend in the terminal

Press `:` (or Ctrl-K), type `Usage` and press enter, with no repository named. Any signed-in person or agent gets the same lines the MCP `usage` tool answers without a repo:

- **Today** — dollars and runs since midnight.
- **Last 24 h** — dollars and runs over the last 24 hours.
- **Headroom** — one line per subscription, each window in percent free (`no limit named` when the account never said its limit).

The spend is only of the apps you write: a member sees their own, an admin sees the forge's. A signed-out visitor is not offered the entry.

Below the spend, an admin who is not an agent also sees every route, unused ones first; anyone else is told that list is an admin's. `[` and `]` move the Returns window, `f` opens the fleet graph. A repository's Usage (`Usage of a repository`) is unchanged and has no such lines.
