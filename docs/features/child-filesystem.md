# A child forge's own filesystem (#10856)

Everything a child forge writes is kept under `<data>/children/<body id>`. The
forge checks whether that directory is a **filesystem of its own**: a mount
whose mount point is exactly that path in `/proc/self/mountinfo`. The forge
mounts nothing itself. Making that filesystem is the platform's job (#10851).

## What the line means

Each child's line on **`/forges`** and on the terminal's **Forges you sent**
screen (ctrl-k) ends with one of:

- **`own filesystem, N GiB`**: the child's data has a filesystem of its own.
  N is `statfs` blocks × block size, in GiB (2^30 bytes), to one place.
  Writing past that size fails with ENOSPC inside the child, and the parent's
  free space stays the same. The child's cell binds that filesystem by its
  real path.
- **`shared disk`**: the child's data sits on the disk this forge and its
  other children share. Only the cell's disk watch stops it, and only after it
  has written too much.

## Requiring one: `children.ownFilesystem`

The setting is `off` by default. To turn it on, use one of:

- **Settings → Capacity**: set "Child forges need a filesystem of their own"
  to `on`.
- **The terminal's Capacity screen**: press `e` on `children.ownFilesystem`.
- **The `capacity` MCP tool**:
  `{ "key": "children.ownFilesystem", "value": "on", "reason": "…", "dryRun": false }`.
  The value `""` puts back the default.

While it is on, the forge does not start a child that has no filesystem of its
own. This applies whether the child runs in a cell or in this forge's process.
The forge reads the setting on every start, and a child that is already
running is not stopped.

## What the refusal says

The child's pages and its apps answer **503**, `text/plain`, with one line:

> kid was not started: its data is on the shared disk, not a filesystem of its own, and this forge requires one (children.ownFilesystem is on).

The boot skips that child and logs the same line as `child forge not started`.

Code: `src/spawn/disk_mount.ts` (reading the mounts), `startRefused` in
`src/spawn/host.ts`, and `launchSpecFor` in `src/spawn/cell.ts`. Tests:
`test/disk-mount.test.ts`.
