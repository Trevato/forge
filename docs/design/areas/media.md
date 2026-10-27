# Media (audio and video on the blob page)

An audio or video file plays inline, from the media route (`src/web/render/player.ts`, styled in
`src/web/style/content.ts`).

- `.media-pane` — wraps the player and its hidden "can't play" note; `data-kind` is `audio` or `video`.
- `.media-player` — the `<audio>` or `<video>` element: full pane width; a video keeps its aspect ratio
  (`height: auto`) and stops at 80vh.
- `.media-unplayable` — the note and Download shown, by the shell script, when the browser cannot decode the file.
