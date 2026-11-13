# Real-cell proof: the build half, in process (#11999)

- `test/helpers/build-standin.ts` (its work in `build-standin-builder.ts`) is a deterministic stand-in for the model: it adds a `/reading` route and its test to the template's app (`READING-V1` in the prompt), or changes what it says (`READING-V2`), runs the app's real `bun test`, and pushes only when that passes.
- `test/build-journey.test.ts` walks a first ask to production in one process: `newApp` copies the template, the crew's stand-in builds, the pull's preview run says its tests passed, a person lands it, production serves `/reading`, and a second change lands the same way. About 8 s.

Not proved here, and tracked in #12001: the same walk inside a 2 GiB, 1-core cell, and a real memory breach restarting a child.
