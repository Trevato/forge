# /talk attachments (#8820)

Attach a file or image to a /talk message: pick it, paste it into the box, or drop it on the composer. It shows as a chip with Remove until the message is sent.

- **Limits:** PNG, JPEG, GIF or WebP images up to 5 MB; plain text files (txt, md, csv, json, log, code) up to 100 KB, valid UTF-8. Up to 4 per message, 50 MB kept per person. The type is what the bytes are (magic bytes, UTF-8), never the browser's word or the name. Refusals say the limit.
- **Stored:** `FORGE_APP_DATA/conversation-files/<user>/<id>`, owner-only, with a row in `conversation_file`. Never in a repository. A chosen file never sent is swept after an hour.
- **The agent:** an image is sent to the run as an image block, a text file quoted into the message as data. Only with the message it is attached to: a resume, a steer or a later message is not handed it again. A turn already answering takes text files but not pictures.
- **Fetch:** `GET /api/v1/conversation/files/:id`, owner only (another person gets 404), always `attachment`, `nosniff`, a fixed type (an image type or `text/plain`), CSP `sandbox`.
- **API:** `POST /api/v1/conversation/files` (raw body, url-encoded `x-file-name`) answers `{id,name,type,size}`; send it with `{"text":…,"files":[id]}` to `/api/v1/conversation/messages`; `DELETE` removes an unsent one.
- **Over ssh:** `cat shot.png | ssh <forge> talk --attach shot.png look at this`. The file is the command's standard input (at most 5 MB), named by the word after `--attach`; it is checked and kept like any other and goes with those words. The forge never opens a path of its own, so only what the client pipes in can be sent. One file per command.
- **Making room:** past 50 MB the oldest sent files are dropped (their chip under the old message then answers 404); a file waiting for its message is never dropped. Uploads are limited to 20 a minute per person.
- **The fence:** a text file is quoted between delimiters drawn fresh for each message, so nothing inside it can close its own quote.
