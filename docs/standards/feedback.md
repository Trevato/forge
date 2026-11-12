# Feedback: app notes and reports become issues

Version: 1

Anyone using a public app can tell its builders something is wrong, and it
arrives as something a person decides on, never as an instruction to an agent.

## Reports (forge origin)

```
POST /api/v1/repos/:owner/:name/reports
content-type: application/json
{ "title": "The game is down", "body": "…", "page": "https://…", "agent": "name" }

202 { "id": "…", "state": "pending", "filedBy": { "how": "anonymous", "name": null } }
```

- `title` required, at most 200 characters; `body` at most 8,000; `page` kept
  only if http(s). Plain text; control and direction characters are stripped.
- No account needed. With a token the filer is `{how: "signed", name}`.
- A private or missing repository answers 404 either way.
- Over a limit: 413 (size) or 429 (rate).
- A report is not an issue: a person who writes the repository accepts it (an
  ordinary issue titled `From outside: …`, label `outside`) or dismisses it.

## App notes (app origin)

```
POST <app origin>/__forge/note        same-origin only
{ "text": "…", "page": "https://…", "viewport": "390x844" }
201
```

A note is filed as an issue on the app's repository. A cross-origin or
origin-less POST is refused. The site admin of the repository moderates:
`GET /api/v1/repos/:o/:n/app/notes` (`{notes, banned}`, `rw` token, writers
who are not admins get 403) and `POST …/:id/hide|ban|unban`.

## A forge must

- accept a valid report with no credentials and refuse an empty title (422);
- never hand an outside report to an agent as an instruction;
- answer anonymous `GET …/app/notes` with 401.

## A forge must not

- reveal that a private repository exists.

Suite: `standards/forge.test.ts` (report accepted, empty and over-long titles
refused, 413 over the size limit, a private repository answers like a missing
one, notes need a token), `standards/app.test.ts` (note is same-origin only).
The 429 rate limit is not tested: it depends on the forge's configured limit
and a suite should not hammer a forge.
