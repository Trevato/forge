# Files in the browser: the media route and the kind registry

The foundation for rendering files on the blob page (#7329, #7330).

## The media route

`GET /:owner/:name/media/:ref/*path` serves a file's bytes under a real
media type, for `<img>`, `<video>`, `<audio>`, `<object>` and `fetch()`.

- **Types** come only from the allowlist in `src/web/render/kinds.ts`
  (png, jpeg, gif, webp, avif, bmp, ico, svg, pdf, mp3, ogg/oga, wav, flac,
  m4a, aac, mp4, m4v, webm, mov, stl, glb). The extension proposes a type and
  the file's first bytes confirm it; a mismatch, or any other file, is
  `application/octet-stream`. Never HTML, never script.
- **Headers:** `X-Content-Type-Options: nosniff` and
  `Content-Security-Policy: sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'`,
  so an SVG with a `<script>` is drawn and never runs.
- **Range:** one `bytes=` range answers 206 with `Content-Range`; a suffix
  (`bytes=-N`) is the last N bytes; past the end is 416. A list of ranges is
  answered whole, which the RFC allows. `If-Range` is honoured.
- **Caching:** `ETag` is the blob id, and `If-None-Match` answers 304. A
  full commit id as `:ref` is `private, max-age=31536000, immutable`; a
  branch or tag is `private, max-age=0` and revalidates.
- **Access** is `/raw`'s: a repository you cannot see is the same 404 as one
  that is not there.
- **Streaming:** a file over 1 MB streams off `git cat-file` and is never
  held whole. Streams take permits from their own gate (`mediaGate`,
  `FORGE_MEDIA_CONCURRENCY`, default 16), so a page of videos never takes
  the plumbing permits every page needs. The permit is taken before the
  stream exists; a stream gives it back when it ends, when its reader hangs
  up, or when nothing has been pulled for 30 s (`MEDIA_IDLE_MS`), so a
  reader that never reads cannot hold one for good. With 32 requests
  already waiting (`MEDIA_QUEUE_MAX`) the next is a 503 with
  `Retry-After: 5`. A file of 1 MB or less never waits: it is read through
  the pooled reader.
- A 304 is answered from the blob id alone, before any byte is read.
- `?download=1` sends the file as an attachment under its own name, at any
  size. The blob page's Download button points here.

## The kind registry

`fileKind(path, firstBytes)` answers `image | svg | pdf | audio | video |
csv | model3d | config | markdown | text | binary`. `RENDER_CAP` is the
largest file each kind draws inline; over it, the page offers Download.

`kinds.ts` is plain data with no web dependency: the editor and the
terminal ask it whether a path is Markdown, as the blob page does.

`renderBlob` asks `render/renderers.ts`. A kind in `RENDERERS` is drawn by
its module; a kind with none yet keeps the source or binary view it always
had. Where a renderer exists the header offers `Rendered | Source`; every
file's header has the **Raw** and **Download** buttons.

## Audio and video (#7333)

An audio file is `<audio controls preload="metadata">` and a video
`<video controls playsinline preload="metadata">`, each with a `<source>` on
the media route and the registry's type (`render/audio.ts`,
`render/video.ts`, `render/player.ts`). Range on the media route is what
seeks. A `.mov` also offers itself as `video/mp4`, which is what most
QuickTime files are inside, for browsers that refuse `video/quicktime`.

- **Header:** size and container (`3.2 MB · WebM`) in place of a line count.
- **Video** is the pane's width at its own aspect ratio, at most 80vh tall.
- **A format the browser cannot decode** fires `error`; the shell script
  (`MEDIA_PLAY_JS`) hides the player and shows "Your browser can't play this
  format" with Download, already in the markup.
- **With scripts off,** a `<noscript>` line under the player offers the same
  Download, so an undecodable file is never a dead end.
- **Container names** come from the registry (`name` in `kinds.ts`,
  returned by `claimedMedia`): one table names each format.
- **In the terminal** an audio or video file is not played; the file pane
  says so, names the format and size, and prints the media route on the
  forge's address (`src/tui/ui/media-note.ts`).
- **A long file:** the page reads at most 1 MB of a file's body. Media
  kinds (image, svg, pdf, audio, video, model3d — `MEDIA_KINDS` in
  `render/renderers.ts`) are drawn from the media route alone, so they are
  bounded by `RENDER_CAP`, not by that ceiling: past it the page reads only
  the first `HEAD_BYTES` (`blobHead` in `src/git/read.ts`, which stops
  `cat-file` once they are in) and the size, `fileKind` decides, and the
  renderer gets an empty `body` and the `media` address. A `.pdf` whose
  bytes are text keeps the over-cap note. Where the source gave no bytes (a
  mirrored origin), the extension decides (`claimedMedia`) and the media
  route confirms the bytes, serving a contradicted file as
  `application/octet-stream`, and the player shows the note.
- **Text kinds** (markdown, csv, config, text) and binary keep the page's
  1 MB ceiling: over it the page says "over the render cap" and offers
  Download.
- Over `RENDER_CAP` (500 MB audio, 4 GB video) the page offers Download.

## Adding a renderer

Write `src/web/render/<kind>.ts` exporting a `Renderer` (plain data in:
path, size, body, and `media`, the media route's address; HTML out), and
name it once in `RENDERERS` (`render/renderers.ts`); `rendererFor` picks it. Point any element
that needs the bytes at `input.media`, never at an inline copy, so
repository content only ever runs under the media route's sandbox. `render/markdown.ts` is the example.
