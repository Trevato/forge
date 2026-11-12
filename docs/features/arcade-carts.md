# Arcade carts

A build pin can name a **cart**: a demo of its commit that plays offline as one HTML page. The cart's facts ride on the pin's tag as trailers (`Demo:`, `Version:`, `Launch: file`, `Page:`, `Showcase: on`, `Cover:`; `git/builds.ts`), so git holds them. The page is captured once from a build preview of the commit and kept under `FORGE_APP_DATA/carts/<owner>/<repo>/<commit>/` with a picture of it (`arcade/carts.ts`). Ported from Jay Moran's arcade.

- **Who.** Anyone who reads the repository sees a cart and plays it. Naming one needs the `rw` scope and a person who writes the repository: an agent is refused (403), a mirror's builds are its origin's (409).
- **Web.** On **Builds**, a pin with a cart shows `▶ name version`; it opens the captured page at `/:owner/:name/builds/:label/cart`, and its picture is at `…/cart.png`. The page is the build's own HTML, served sandboxed (`sandbox allow-scripts`, no same origin): it runs its scripts and reaches nothing of the forge's.
- **API.**
  - `GET /api/v1/repos/:owner/:name/builds/:label/cart` answers `{ label, oid, demo, capture, play_url, art_url }`; `capture.state` is `none`, `capturing`, `done` or `failed` (with its `error`).
  - `POST …/cart` with `{ name, version, page, showcase }` names it and starts the capture: 202 while it runs. The capture starts the commit's build preview if it is not up, waits for it (15 minutes at most), keeps the page once (16 MB at most) and pictures it.
- **Terminal.** **Builds** → a pin shows `▶ name version`; a writer presses `c` to name its cart (`name version page`) and start the capture.
- **Import.** Carts built elsewhere: `bun scripts/import-carts.ts <data-dir> <carts.json>` pins each commit (if not pinned), sets its cart and cover, and keeps its page and picture. Each entry is checked; a bad one is named and skipped.

Left out: the Arcade itself (the shelf, the console page, covers drawn in the house style and the arcade host: #9207, #9208), a cover upload door, and capturing a page that is not the build's own HTML file.
