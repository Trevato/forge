# A forge's size and use on /system (#10853)

**A child forge** in a cell of its own opens /system (or the terminal's System command) to a "This forge's size: small" block (or medium, large), then memory, CPU and disk in use against it, one line each. The forge that made it sets the size, and it cannot be changed from inside.

- **Memory**: the whole cell's `memory.current`, from its cgroup.
- **CPU**: cores = Δ`cpu.stat` `usage_usec` / Δt between two readings at least a second apart. The first reading averages over the time since the process started.
- **Disk**: a bounded walk of the data directory, taken in the background and kept 30 s. The first view says "measuring".

The parent passes the size and the cgroup directory in the child's environment (`FORGE_CELL_SIZE`, `FORGE_CELL_CGROUP_DIR`; `cellEnv` in `src/spawn/cell.ts`). Where the kernel does not hold the cell's caps, there is no cgroup to read. Memory and CPU are then this process's alone, and the page and terminal say so. A forge that is no cell child shows no such block.

**A parent** lists every finished child under "Child forges", each name a link to the child, with its size and its use against it, read the same way as on `/forges`. A hosted child reads "shared with this forge" and a stopped cell reads "not running".

Both are visible only to the forge's owner (`canSeeMemory`, the same check as the memory block and the terminal entry). Anyone else who opens /system gets neither.
