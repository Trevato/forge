# What a sized forge's cores mean for builds (#11694)

A child forge's admins see one `Cores` row on `/settings`, next to the Plan row: `1 CPU: builds run, slower.` and how the cores are held. The terminal's palette entry *Cores* (`src/tui/screens/cores.ts`) prints the same sentence (`coresLine`, `src/spawn/cores.ts`).

The forge reads how it is held from itself, never from a promise:

- **quota**: its cgroup's `cpu.max` names a quota. The kernel slows a busy build; nothing stops the forge.
- **affinity**: its allowed CPUs (`/proc/self/status`) are no more than its cores (`taskset`). Slowed the same way.
- **watch**: nothing holds it; a build above twice its cores for 5 minutes is stopped, the first 10 minutes are safe (`src/apps/cpu_rule.ts`, numbers read from it).

A forge that is no cell child (no `FORGE_CELL_SIZE`) shows no row and is not offered the entry. Members who are not admins see neither.
