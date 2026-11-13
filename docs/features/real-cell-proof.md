# Real-cell proof: the build half, in process (#11999)

- `test/helpers/build-standin.ts` (its work in `build-standin-builder.ts`) is a deterministic stand-in for the model: it adds a `/reading` route and its test to the template's app (`READING-V1` in the prompt), or changes what it says (`READING-V2`), runs the app's real `bun test`, and pushes only when that passes.
- `test/build-journey.test.ts` walks a first ask to production in one process: `newApp` copies the template, the crew's stand-in builds, the pull's preview run says its tests passed, a person lands it, production serves `/reading`, and a second change lands the same way. About 8 s.

## The cell half, begun (#12001)

`childEnvFor` (src/spawn/cell.ts, over `cellEnv`) now passes the parent's `FORGE_CLAUDE` to a cell child, so the child's crew can run a stand-in written under the child's own directory (the one place both sides see: the cell hides the parent's data and `/tmp`). Production children read it too (`main.ts`), so a parent with Claude off `PATH` has children that find it. Unit-tested in `test/spawn-cell.test.ts`.

Still not proved, and still open in #12001: the walk itself in a real 2 GiB, 1-core cell, and a real memory breach restarting a child. Both need bwrap and socat with user namespaces, which the sandbox this was written in refuses.
