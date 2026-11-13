# A child forge's cores, held by pausing where the kernel cannot

A child forge's cell asks for its cores to be held (`cpuQuota`). Where the
forge can write `cpu.max` in the cell's cgroup, the kernel holds them. Where it
cannot (no delegated cpu controller), the forge's cell watch holds them: each
tick it reads the cores the cell's process tree used, and if that is over the
limit it sends the tree SIGSTOP and SIGCONT later in the same second. It
never kills a cell for its cores this way (#11559).

- **The boot line.** The first quota cell after the forge starts logs who holds
  the cores, once, and again only if that changes:
  `cpu: a child forge's cores are held by the kernel` or
  `cpu: a child forge's cores are held by the forge, by pausing`.
  The second line means this host gave the forge no `cpu.max`.
- **What pausing means for a child's speed.** A tree that wants 3 cores under a
  limit of 1 runs about a third of each second and is stopped for the rest. On
  average it gets its cores, as it would under `cpu.max`. The difference is the
  shape: under the kernel the tree runs slowly but without a break, and under
  pausing it runs at full speed in bursts with gaps of up to about a second. A
  request that arrives during a gap waits for the gap to end. A tree within its
  limit is never paused. A tree is never stopped for the whole second, so the
  watch can still read it.
- **When it ends.** Closing a cell continues a paused tree. A clean exit of the
  forge continues every tree it stopped. If the forge is killed, its cells go
  with it through `--die-with-parent`: SIGKILL also ends a stopped process. The
  forge adopts no cells when it restarts. It starts them again, and they start
  unpaused.
- **Where.** The schedule is in `src/apps/cpu_duty.ts`. The wiring (the duty
  set up in `watchTree`, driven by the watch tick) is in `src/apps/contain.ts`.
- Tests: `test/cpu-duty.test.ts`. It covers the schedule, a fake clock, and a
  `watchTree` driven tick by tick with a recording signaller: stopped and
  continued, never stopped for CPU, and continued on close.
