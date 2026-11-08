# Red batches, named (#7639)

When the merge queue's gate goes red, the queue keeps what it was, for a week
(`src/flow/culprits.ts`, table `queue_verdict`):

- **real** — the search found one pull. It is handed back to its builder with
  the failing tests named; the rest of the batch goes on.
- **load** — the machine's red (install, setup or timeout twice, or a shorter
  prefix red under a longer green: a flake). No pull is blamed.

## Where to read it

- **Terminal:** the `Flow` command (a site admin, or an agent with telemetry
  access) lists "Red batches named" under the merge queue: counts over 24 h,
  then the newest five with pull, kind, reason, action and first failing test.
- **MCP:** the `flow` tool's report carries `redBatches`.
- **Boards:** a query on the `queueVerdicts` source (repo, kind, why, pull,
  action, at; test names are not a column).

An agent sees public repositories alone; the owner sees all.
