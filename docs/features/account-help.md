# Account settings help

On the web, Settings › Account (profile, password, tokens) shows each field as a label and a value. One closed
"Help with these fields" disclosure at the top of each page explains every field, and on the profile page lists what
the account's role allows. Constraints stay as a one-line hint tied to the field: the password's 10-character minimum,
the notify URL's https-only rule and, once saved, "Sending to <host>".

Try it: open `/settings`, press **Help with these fields**.

The terminal (both doors): it has no account-settings screen, so there are no field explanations to bring in line;
`src/tui` edits no profile, password, token or notify URL. Nothing changes there.

Pinned by `test/account-help.test.ts`; design note in `docs/design/areas/settings.md`.
