# An .eml file opens as a message

`src/web/render/eml.ts` draws a mail file on the blob page; `eml-parse.ts` is the pure parser, shared with the terminal.

- **Rows:** From, To, Cc, Subject and Date (those present), as the same `.status-rows` used by contacts and GPX. Headers are unfolded and RFC 2047 encoded words decoded.
- **Body:** the first `text/plain` part, quoted-printable and base64 decoded, UTF-8 or latin-1 (any charset the runtime knows). Multipart messages are walked (depth and part count capped).
- **HTML-only:** the text with scripts, styles and tags stripped, and a line saying so. HTML is never rendered.
- **Attachments:** listed by name, type and size (decoded). Their bytes are never served from this page.
- **Malformed:** a file with no mail headers falls back to Source with the reason.
- **Cap:** 5 MB (`RENDER_CAP.mail`); every value is escaped by the template.
- **Terminal:** the workspace shows the same rows as Field/Value; `s` flips to the source.

Left out: inline images, charset conversion beyond what `TextDecoder` knows, saving attachments.
