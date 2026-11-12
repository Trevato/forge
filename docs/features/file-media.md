# Files in the browser: the media route and the kind registry

The foundation for rendering files on the blob page (#7329, #7330).

## The media route

`GET /:owner/:name/media/:ref/*path` serves a file's bytes under a real
media type, for `<img>`, `<video>`, `<audio>`, `<object>` and `fetch()`.

- **Types** come only from the allowlist in `src/web/render/kinds.ts`
  (png, jpeg, gif, webp, avif, bmp, ico, svg, pdf, mp3, ogg/oga, wav, flac,
  m4a, aac, mp4, m4v, webm, mov, stl, 3mf, glb). The extension proposes a type and
  the file's first bytes confirm it; a mismatch, or any other file, is
  `application/octet-stream`. Never HTML, never script.
- **Headers:** `X-Content-Type-Options: nosniff` and
  `Content-Security-Policy: sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'`,
  so an SVG with a `<script>` is drawn and never runs.
- **PDF policy:** Chrome's built-in PDF viewer refuses to run in a document
  under `sandbox`, so `application/pdf`, and only that type, is sent
  `default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'self'`
  (no `sandbox`), still `nosniff` and inline. It is chosen by the confirmed
  type, so a file named `.pdf` without `%PDF-` bytes, and any `?download=1`,
  keep the sandbox policy. A PDF is never served as HTML.
- **Framing:** every media answer carries `frame-ancestors 'self'` and
  `X-Frame-Options: SAMEORIGIN`: the blob page may embed it, no other site.
- **The page's side:** the blob page of a PDF (`render/pdf.ts`) holds an
  `<object type="application/pdf">` on the media URL, with an "Open the PDF" link and a
  Download button inside it for a browser that cannot draw it. That page, and no
  other, passes `objectSrc: true` to `page()`, which adds `object-src 'self'`
  to its policy; it is sent only when the page really draws the PDF, never for
  `?view=source`, and never site-wide. The PDF is drawn for a repository on
  this forge, not for a browsed origin (the media route is not there). Like
  audio and video it is streamed, drawn by name at any size up to its cap; the
  media route confirms the bytes.
- **What a PDF's own script can reach.** Dropping `sandbox` makes a PDF opened
  at its media URL a same-origin document. The viewers run a PDF's script in
  their own engine (PDFium's in Chrome, pdf.js's scripting sandbox in
  Firefox), which has no access to this origin's DOM, cookies or `fetch`, and
  the response's `default-src 'none'` forbids the document any load. That is
  the viewers' documented isolation, not something this route enforces; it is
  why the exception is one type, chosen by confirmed `%PDF-` bytes, and why a
  `.pdf` of HTML, an SVG, and every download keep `sandbox`.
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
csv | model3d | config | markdown | patch | text | binary`. `RENDER_CAP` is the
largest file each kind draws inline; over it, the page offers Download.

`kinds.ts` is plain data with no web dependency: the editor and the
terminal ask it whether a path is Markdown, as the blob page does.

`renderBlob` asks `rendererFor` in `render/renderers.ts`. A kind in
`RENDERERS` is drawn by its module; a kind with none yet keeps the source or
binary view it always had. A file too large for the page to read is drawn
only by a media kind (`MEDIA_KINDS`), whose renderer never reads the body
(the browser fetches the media route), and only up to that kind's cap. A
page with no media route (a live browse of another forge, `/origins/…`)
draws no media kind. Where a renderer exists the header offers `Rendered | Source`; every
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
- **Patch** (`.patch`, `.diff`; `render/patch.ts`): text drawn with the pull
  page's own diff (`parseUnifiedDiff` into `renderDiff`). A `git format-patch`
  mail header (From, Subject, Date) shows above it as a plain list of rows.
  Text with no `diff --git` file in it (a plain `diff -u`, notes) is not
  parsed and falls back to the text view. The terminal's file view draws the
  same parse with its pull diff (`tui/ui/diff.ts`); `v` shows the source.
- **Text kinds** (markdown, csv, config, patch, text) and binary keep the page's
  1 MB ceiling: over it the page says "over the render cap" and offers
  Download.
- Over `RENDER_CAP` (500 MB audio, 4 GB video) the page offers Download.

## Adding a renderer

Write `src/web/render/<kind>.ts` exporting a `Renderer` (plain data in:
path, size, body, and `media`, the media route's address; HTML out), and
name it once in `RENDERERS` (`render/renderers.ts`); `rendererFor` picks it. Point any element
that needs the bytes at `input.media`, never at an inline copy, so
repository content only ever runs under the media route's sandbox. `render/markdown.ts` is the example.

## 3D models

An `.stl` (ASCII or binary), `.obj`, `.3mf`, `.glb` or `.gltf` file's page shows the
part, ready to turn (`src/web/render/model3d.ts`, #7335).

- **Turn it:** drag to orbit, scroll or pinch to zoom, right-drag or two
  fingers to pan; with the view focused, the arrow keys pan.
- **The head** says the triangle count and the bounding box in millimetres,
  in the file's own axes. STL and OBJ units are taken as millimetres; glTF
  is metres by its spec, so its box is multiplied by 1000. A `.3mf` print
  project takes its units from the model's `unit` attribute (millimetre by
  default; micron, centimetre, inch, foot and metre are scaled to mm), and
  is stood Z-up like an STL. Its build items and transforms are applied.
  A 3MF is refused, with a sentence, Source and Download kept, when it is
  zip64, has an encrypted entry, holds more than 5 million triangles, inflates
  to more than 64 MB of XML (`INFLATE_LIMIT`), or is a production-extension
  model whose objects live in other files (it names an object that is not there).
- **Wireframe** and **Axes** toggle in the head. The camera fits the part,
  a grid sits under it, and every part wears one neutral material. An STL
  is stood Z-up, the way a printer reads it.
- **Rendered | Source** stays, and **Raw** and **Download** are on every
  file's bar. Up to 100 MB (`RENDER_CAP.model3d`) a part is drawn, even one
  too large for the page to read whole; over it, the page offers Download.
- **On a live browse of another forge** (`/origins/…`) there is no media
  route to fetch from, so a model keeps its source or binary view there.
- **Without JavaScript or WebGL** the frame keeps its note and Download
  button. A file that is not its format says why in the head and keeps them
  too.
- **Where the work happens:** the server renders only the frame. The bytes
  come from the media route with `fetch()`, and STL and OBJ are parsed in
  the browser by `render/mesh.ts`; glTF goes through three.js's loader. A
  `.gltf` whose buffers are separate files finds them beside it on the media
  route. Only those are fetched: every URI a glTF names goes through
  `withinModelDir` (`render/gltf-uri.ts`), and one that is not same-origin
  with a path under the model's own directory (`../`, an encoded dot or
  slash, an absolute path, another host, `data:` or `blob:`) is sent to
  `about:blank` and never requested, so a public model cannot make its
  readers' browsers call anything else on the forge.
- **In the terminal** there is no 3D screen, by design: a terminal cannot draw
  the part, so the file view of a binary or too-large model says
  what the page shows: `3D model · STL` over `12 triangles · 20 × 20 × 20 mm`,
  and under it `Download: <forge>/<owner>/<repo>/media/<ref>/<path>?download=1`
  (`render/model-facts.ts`, the same parsers). Up to 2 MB (`FACTS_CAP`) the
  bytes are read; over it, the model is named and sized. A glTF's facts come
  from its JSON (vertex counts, position bounds in metres, before node
  transforms). An ASCII STL or OBJ is text, so it opens as its source, as
  the web's Source view does.
- **Loaded only where needed:** three.js 0.186.1 is vendored, unedited, with
  its MIT licence, in `src/web/render/vendor/three/` (its README lists the
  files and their hashes). `model3d-client.ts` is bundled with it into
  `/assets/model3d-<hash>.js` (648 KB, 166 KB gzipped, immutable), named by
  a hash of its sources so the page knows the address without a build. The
  frame names it in `data-module`, and the shell loads it with its own nonce
  only when a figure asks, on a full load or when the code browser swaps the
  file in.

## Images and SVG (#7331)

`render/image.ts` draws the `image` and `svg` kinds as an `<img>` at the media
route; an SVG is never inlined. The picture fits the pane; a click shows it at
100% and the pane scrolls or drags to pan. A checkerboard sits behind it for
transparency. The header line carries the pixel size (read in the browser from
`naturalWidth`/`naturalHeight` by a few lines in the shell script, so no new
request), the file size and the format. Animated GIF and WebP play, since the
browser draws the original bytes. Over `RENDER_CAP` the page shows the
"too large" notice and Download.
