# A child forge's disk bandwidth is capped by its size

A child forge's cell shares the parent's disk. `io.weight` only orders the
queue, so one busy child could still starve the parent's database and its
neighbours. Each child's cell now gets `io.max` on the disk under the forge's
data, sized by the child's size (#10854).

| Size   | Read      | Write     | Read ops/s | Write ops/s |
| ------ | --------- | --------- | ---------- | ----------- |
| small  | 50 MiB/s  | 25 MiB/s  | 1000       | 500         |
| medium | 100 MiB/s | 50 MiB/s  | 2000       | 1000        |
| large  | 200 MiB/s | 100 MiB/s | 4000       | 2000        |

- **Where.** The cell's cgroup, `cells/<child>/io.max`, one line:
  `MAJ:MIN rbps=… wbps=… riops=… wiops=…`. The device is the whole disk under
  the child's directory in the forge's data (a partition is walked up to its disk through `/sys/dev/block`).
- **When it is not written.** Where the io controller is not delegated to
  `cells/`, where the data sits on no block device (tmpfs, overlay, a network
  mount), or where the kernel refuses the device. The cell still starts; only
  `io.weight` orders it then. The cell's cgroup result says which
  (`ioCapped`).
- **Tuning.** The numbers are a starting point, not a measurement. They live in
  `SIZE_IO` in `src/spawn/sizes.ts`. To tune: run `fio` (or `dd oflag=direct`)
  against the data volume on the host to learn what the disk sustains, then
  keep the largest size's cap well under it so the parent always has headroom.
  A new cap applies when a child's cell next starts. Watch
  `cells/<child>/io.stat` against `io.max` to see whether a child is pinned at
  its cap.
- Tests: `test/cgroup.test.ts` (the line, the device, and a child cell that
  gets `io.max` only where io is delegated).
