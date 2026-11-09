# The feed pages by cursor

`GET /api/v1/feed?before=now` (also MCP `feed` with `before`, and `/feed?before=now` as a page) reads the log newest first: `{ items, next_cursor }`; pass `next_cursor` back as `before`. The cursor is an event id (a ULID: its time and its identity), resolved to the log's write order, so posts arriving between two requests land above the cursor and nothing repeats or skips. A cursor that is not an event id is a 422; a valid one only names where to start, and visibility is still the log query's.

The ranked feed (`cursor=`) is unchanged; its page ends where its 300-event window does, and its last line links to "Everything, newest first". The timeline leaves out shares, asks and other standing items, and does not fold bursts. Code: `src/feed/timeline.ts`; test: `test/feed-cursor.test.ts`.
