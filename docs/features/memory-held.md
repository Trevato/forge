# Memory held, not hit (#11980)

A child forge in a cell has one memory limit for itself, its crew run, its checks and its apps. At or over 75% of that limit (anonymous memory, the page cache not counted) and with one of its own runs already going, the child starts nothing new:

- the dispatcher keeps the queued agent run queued, with one log line, and vitals counts it as "held on purpose: … by the forge's memory near its limit", not as waiting;
- the check queue keeps checks queued, one log line each, so checks run one at a time.

With nothing running a start is always allowed, so the hold never lasts. A forge that is not a cell child reads no pressure and is never held. The rule is `src/runs/memory_hold.ts`; the cgroup reading is reused for a second; tests in `test/memory-hold.test.ts` drive the dispatcher, the check queue and vitals.

Not done here: a smaller heap for the child's Bun processes, reclaiming idle app cells, stopping the largest process instead of the forge.
