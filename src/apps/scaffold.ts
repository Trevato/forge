/**
 * The app a new app starts as. Small enough to read in one sitting, real
 * enough to show every idea a first app needs: data under `FORGE_APP_DATA`
 * (so production and a preview each have their own), identity from the
 * forge (anon, user, admin), one set of actions behind a page, a JSON API,
 * an MCP server and a terminal, a list that stays current, and a floor of
 * security every response stands on. Notes are the example; the shape is
 * the point. Zero dependencies, like the forge that grew it.
 *
 * The files live here as strings. To work on them, write them out with
 * `scaffoldFiles` and run `bun test` there; `test/apps.test.ts` boots the
 * result the way the forge does.
 */

import type { FileWrite } from "../git/write.ts";

export interface ScaffoldInput {
  /** The repository name; also the title on the page. */
  readonly name: string;
  /** What the app should become. Shown on the page until it does. */
  readonly description: string;
}

export function scaffoldFiles(input: ScaffoldInput): FileWrite[] {
  const title = input.name;
  const description = input.description.trim();
  return [
    { path: "forge.json", content: FORGE_JSON },
    { path: "package.json", content: packageJson(title, description) },
    { path: ".gitignore", content: GITIGNORE },
    { path: "README.md", content: readme(title, description) },
    { path: "AGENTS.md", content: AGENTS_MD },
    { path: "src/env.ts", content: ENV_TS },
    { path: "src/who.ts", content: WHO_TS },
    { path: "src/db.ts", content: DB_TS },
    { path: "src/actions.ts", content: ACTIONS_TS },
    { path: "src/live.ts", content: LIVE_TS },
    { path: "src/http.ts", content: HTTP_TS },
    { path: "src/mcp.ts", content: MCP_TS },
    { path: "src/page.ts", content: PAGE_TS },
    { path: "src/routes.ts", content: ROUTES_TS },
    { path: "src/server.ts", content: SERVER_TS },
    { path: "src/tty.ts", content: TTY_TS },
    { path: "static/app.css", content: APP_CSS },
    { path: "static/live.js", content: LIVE_JS },
    { path: "src/who.test.ts", content: WHO_TEST },
    { path: "src/db.test.ts", content: DB_TEST },
    { path: "src/actions.test.ts", content: ACTIONS_TEST },
    { path: "src/server.test.ts", content: SERVER_TEST },
  ];
}

const FORGE_JSON = `{
  "app": {
    "run": "bun run src/server.ts",
    "test": "bun test",
    "tty": "bun run src/tty.ts"
  }
}
`;

const packageJson = (name: string, description: string): string =>
  `${JSON.stringify(
    {
      name,
      description,
      private: true,
      type: "module",
      scripts: { start: "bun run src/server.ts", test: "bun test" },
    },
    null,
    2,
  )}\n`;

const GITIGNORE = `node_modules/
*.db
*.db-wal
*.db-shm
`;

const readme = (title: string, description: string): string => `# ${title}

${description || "A new app on the forge."}

This is an app: the forge runs it. Production follows the default branch;
every open pull gets a preview at its own address with its own copy of the
data. Everything the app keeps lives under \`FORGE_APP_DATA\`, which is what
makes "production data" and "preview data" two different things.

\`\`\`sh
PORT=8080 FORGE_APP_DATA=./data bun run src/server.ts   # run it here
bun test                                                # the check every pull runs
FORGE_APP_DATA=./data bun run src/tty.ts                # the terminal
FORGE_APP_DATA=./data bun run src/db.ts --check         # schema version, integrity
\`\`\`

## The shape

One implementation, many doors. \`src/actions.ts\` is every operation as a
plain function — \`(db, who, input)\` in, data or a named failure out — and
the page, the JSON API, the MCP server and the terminal all call it and
decide nothing themselves. \`AGENTS.md\` says how to add to it.

| file                               | what it is                                                   |
| ---------------------------------- | ------------------------------------------------------------ |
| \`src/actions.ts\`                   | list, add, delete — and who may                              |
| \`src/who.ts\`                       | who is asking, from the forge's signed headers               |
| \`src/db.ts\`                        | SQLite under \`FORGE_APP_DATA\`, WAL, forward-only migrations  |
| \`src/live.ts\`                      | the in-process bus and \`GET /events\`                         |
| \`src/mcp.ts\`                       | the actions as MCP tools at \`POST /mcp\`                      |
| \`src/routes.ts\`                    | every path, in one table                                     |
| \`src/page.ts\`                      | the HTML, rendered on the server                             |
| \`src/http.ts\`                      | the floor: headers, body cap, same-origin, rate limit, files |
| \`src/server.ts\`                    | boot: open the database, serve                               |
| \`src/tty.ts\`                       | the terminal, over the same actions                          |
| \`src/env.ts\`                       | what the forge told this process                             |
| \`static/app.css\`, \`static/live.js\` | the look, and the list that stays current                    |

## Who you are

The forge says who is asking on every request it proxies, and the app
verifies the signature (\`src/who.ts\`); nothing else is trusted. Three tiers:

- **anon** — anyone. Reads.
- **user** — signed in to the forge and able to see this app. Adds notes, as
  themselves, and removes their own.
- **admin** — able to write this repository. Removes any note.

"Sign in" is \`/__forge/signin?to=<path>\` and "Sign out" is
\`/__forge/signout\`; the forge answers both on the app's own host.

## Any interface

The same actions, the same rules, at every door. A script is the person
whose forge grant it carries; a bare script is anonymous.

\`\`\`sh
curl https://<app>/api/notes
curl -X POST https://<app>/api/notes -H 'content-type: application/json' -d '{"body":"hi"}'
curl -X DELETE https://<app>/api/notes/1
\`\`\`

As an MCP server, for Claude Code or Claude Desktop — \`list_notes\`,
\`add_note\`, \`delete_note\`:

\`\`\`sh
claude mcp add --transport http __TITLE__ https://<app>/mcp
\`\`\`

\`\`\`json
{
  "mcpServers": { "__TITLE__": { "type": "http", "url": "https://<app>/mcp" } }
}
\`\`\`

The page stays current over \`/events\`: a note someone else adds or removes
appears without a reload. Without JavaScript it is the same page, one
reload behind.

The terminal opens with the exact command in \`FORGE_APP_SSH\` when the app
runs (\`ssh -p 2222 <name>@<forge>\` — the app is the login name, the forge
the host; \`<name>--<pull>@<forge>\` for a preview's). It is \`src/tty.ts\` on
a real pty over the same data, as the account at the keyboard.

The forge sets \`PORT\`, \`FORGE_APP_DATA\`, \`FORGE_APP_ENV\` (\`production\` or
\`preview\`), \`FORGE_APP_URL\`, \`FORGE_APP_COMMIT\`, \`FORGE_APP_SSH\` and
\`FORGE_APP_IDENTITY_KEY\` when it starts the app. \`forge.json\` says how.
`;

const AGENTS_MD = `# Working on this app

You are one of the crew on this repository. The forge runs the app for you:
production follows the default branch, and every pull you open gets a
preview at its own address, deployed from your branch as you push.

## The rules

- Work on the branch you were given. You cannot move the default branch;
  a person merges your pull once it is reviewed.
- Keep state under \`FORGE_APP_DATA\`. Never write elsewhere at runtime.
- Run \`bun test\` before you push. It is the check the pull shows, and every
  behaviour you add gets a test that would fail without it.
- \`src/tty.ts\` is the app's terminal. The exact command that reaches it is
  \`FORGE_APP_SSH\` at runtime; print that verbatim wherever the app tells
  people how to connect. What a person can do on the page they can do here,
  and nothing more: the terminal gates its reads and writes exactly as the
  page does (\`FORGE_APP_USER_ROLE\` is the forge's word on who is there), and a
  write made there reaches web viewers live like any other.
- Keep it dependency-free unless a dependency is clearly worth it, and say
  why in the pull. A dependency is code you now maintain.
- When you are done, push and stop. Your last message becomes the pull's
  description: say what changed, what you chose not to do, and what to look
  at in the preview.

## The shape

One implementation, many doors. Every operation is a function in
\`src/actions.ts\` — \`(db, who, input)\` in, data or a named failure out — and
the page (\`src/routes.ts\`, \`src/page.ts\`), the JSON API (\`src/routes.ts\`),
the MCP server (\`src/mcp.ts\`) and the terminal (\`src/tty.ts\`) call it. A
door reads its wire format and shapes the answer; it decides nothing. A
rule in an action holds at every door at once; a rule anywhere else is a
bug waiting for the door you forgot.

Identity comes from the forge (\`src/who.ts\`): \`anon\`, \`user\` or \`admin\`,
verified by signature, never by a cookie the app invents. An action that
needs a person checks \`who.role\`; ownership is a column (\`author_id\`) and
the check that reads it, in the action.

To add a concept:

- **An action** — a function in \`src/actions.ts\`, its rule inside it, and
  a test in \`src/actions.test.ts\` that fails without the rule.
- **A migration** — append to \`migrations\` in \`src/db.ts\`. Never edit one
  that has run. \`bun run src/db.ts --check\` shows the version.
- **A page** — a row in \`src/routes.ts\` and a function in \`src/page.ts\`.
  With a second page, move them under \`src/pages/\` and keep one \`layout\`.
- **An API route** — a row in \`src/routes.ts\` that calls the action and
  answers with \`answer(...)\`; the status follows the failure.
- **A tool** — an entry in \`tools\` in \`src/mcp.ts\`: a name, one sentence,
  a JSON schema, the action.
- **A terminal command** — a key in \`src/tty.ts\` that calls the action and
  reports on the status line.
- **Something live** — \`emit(type, data)\` in the action, and
  \`data-live="<types>"\` on the region of the page that shows it.

## The bar

- Security: every input is validated at the boundary and every output is
  escaped; every response carries the floor in \`src/http.ts\` (keep it,
  extend it); a POST that is not same-origin is refused; writes are
  rationed per person; secrets come from the environment (Settings → App →
  Environment), never the repository; no \`eval\`, no shell built from user
  text. A request body is capped by the bytes actually read (\`readBody\`),
  never by a Content-Length. \`HEAD\` answers like \`GET\`. A private thing
  needs an identity from \`who\`, and a cookie the app sets itself is
  \`HttpOnly; SameSite=Lax\`.
- Speed: the first paint is server-rendered HTML; JavaScript is small, in
  \`static/\`, linked by content (\`asset()\`) and cached for a year; no
  layout shift; what changes arrives over \`/events\`, never by polling;
  work that can wait is done after the response.
- A phone is a first-class client: the page works at 360px wide with no
  horizontal scroll, every control is at least 44px on a side, and the
  keyboard reaches everything a mouse does.
- Finish: the app boots, \`/\` answers, \`bun test\` is green, the README says
  how to use it and what is real versus simulated, \`forge.json\` says how
  to run it.
`;

// What the forge told the process, named once.
const ENV_TS = `/**
 * What the forge told this process, read once and named once. Every other
 * module takes these from here, so nothing else spells an environment
 * variable — and running the app by hand needs none of them.
 */

import pkg from "../package.json";

export const title: string = pkg.name;
export const description: string = pkg.description || "A new app on the forge.";
export const dataDir: string = process.env.FORGE_APP_DATA ?? "./data";
export const env: string = process.env.FORGE_APP_ENV ?? "local";
export const commit: string = (process.env.FORGE_APP_COMMIT ?? "").slice(0, 7);
/** Where this process runs, for a person: \`production\`, \`preview of pull #3\`, \`local\`. */
export const where: string =
  env === "preview"
    ? \`preview of pull #\${process.env.FORGE_APP_PULL ?? "?"}\`
    : env;
/** The exact command that opens this environment's terminal. Print it verbatim, never a guess. */
export const ssh: string | undefined = process.env.FORGE_APP_SSH;
/** The address the forge serves us at — what a browser sees, never the socket's. */
export const publicOrigin: string = new URL(
  process.env.FORGE_APP_URL ?? "http://localhost",
).origin;
/** The key the forge signs identities with (\`who.ts\`). Unset, everyone is anonymous. */
export const identityKey: string = process.env.FORGE_APP_IDENTITY_KEY ?? "";
`;

// Identity: the forge's signed headers, or anon.
const WHO_TS = `/**
 * Who is asking. The forge signs every request it proxies to the app:
 *
 *   x-forge-identity:  <userId>|<username>|<role>|<expiresMs>
 *   x-forge-signature: base64url(HMAC-SHA256(FORGE_APP_IDENTITY_KEY, that string))
 *
 * \`role\` is \`user\` (signed in and allowed to see this app) or \`admin\`
 * (allowed to write its repository). The forge strips these two headers
 * from whatever a client sends, so a signature that verifies is the only
 * trust there is: no headers, no key, a bad signature or a stamp in the
 * past all mean \`anon\`. Nothing here reads a cookie.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export type Who =
  | { role: "anon" }
  | { role: "user" | "admin"; id: string; name: string };

export const ANON: Who = { role: "anon" };

export function who(request: Request, key: string, now = Date.now()): Who {
  const identity = request.headers.get("x-forge-identity");
  const signature = request.headers.get("x-forge-signature");
  if (key === "" || identity === null || signature === null) return ANON;
  if (!same(sign(identity, key), signature)) return ANON;
  const parts = identity.split("|");
  if (parts.length !== 4) return ANON;
  const [id, name, role, expires] = parts as [string, string, string, string];
  if (role !== "user" && role !== "admin") return ANON;
  if (
    id === "" ||
    name === "" ||
    !/^\\d+$/.test(expires) ||
    Number(expires) <= now
  )
    return ANON;
  return { role, id, name };
}

/** The signature the forge computes. Exported so a test can be the forge. */
export const sign = (identity: string, key: string): string =>
  createHmac("sha256", key).update(identity).digest("base64url");

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * The person at the terminal. A tty session is started by the forge itself,
 * so its environment is trusted: \`FORGE_APP_USER\` is the account at the
 * keyboard (empty for a guest), \`FORGE_APP_USER_ID\` and \`FORGE_APP_USER_ROLE\`
 * say the rest when the forge knows them.
 */
export function whoAtTty(
  env: Record<string, string | undefined> = process.env,
): Who {
  const name = env.FORGE_APP_USER ?? "";
  if (name === "") return ANON;
  return {
    role: env.FORGE_APP_USER_ROLE === "admin" ? "admin" : "user",
    id: env.FORGE_APP_USER_ID ?? name,
    name,
  };
}
`;

// SQLite with good habits.
const DB_TS = `/**
 * The database: one SQLite file under FORGE_APP_DATA, so production and
 * every preview each have their own. WAL so readers never wait on the
 * writer (the terminal is a second process on the same file), foreign keys
 * on, and a forward-only list of migrations applied once, in a
 * transaction, when the file is opened.
 *
 *   bun run src/db.ts --check    the schema version and an integrity check
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./env.ts";

/** Append, never edit: a migration that has run is history. */
export const migrations: string[] = [
  \`CREATE TABLE note (
    id INTEGER PRIMARY KEY,
    body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 500),
    author_id TEXT NOT NULL,
    author_name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )\`,
  \`CREATE INDEX note_author ON note (author_id)\`,
];

export function openDb(dir = dataDir): Database {
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "app.db"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

/** Apply the migrations past the recorded version, all or none. Returns the version. */
export function migrate(db: Database): number {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))",
  );
  return db.transaction(() => {
    const current = db
      .query<
        { version: number },
        []
      >("SELECT coalesce(max(version), 0) AS version FROM schema_version")
      .get()!.version;
    migrations.slice(current).forEach((sql, i) => {
      db.exec(sql);
      db.query("INSERT INTO schema_version (version) VALUES (?1)").run(
        current + i + 1,
      );
    });
    return migrations.length;
  })();
}

export function check(db: Database): { version: number; integrity: string } {
  const version = db
    .query<
      { version: number },
      []
    >("SELECT max(version) AS version FROM schema_version")
    .get()!.version;
  const integrity = db
    .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
    .get()!.integrity_check;
  return { version, integrity };
}

if (import.meta.main) {
  const db = openDb();
  const { version, integrity } = check(db);
  console.log(\`schema version \${version}\`);
  if (process.argv.includes("--check")) {
    console.log(\`integrity \${integrity}\`);
    process.exit(integrity === "ok" ? 0 : 1);
  }
}
`;

// The one implementation.
const ACTIONS_TS = `/**
 * Everything the app can do, as plain functions: \`(db, who, input)\` in,
 * data or a named failure out. The page, the JSON API, the MCP server and
 * the terminal are doors onto these and decide nothing themselves — so a
 * rule written here holds at every door, and a new door is only a new
 * way to call.
 */

import type { Database } from "bun:sqlite";
import { emit } from "./live.ts";
import type { Who } from "./who.ts";

export interface Note {
  readonly id: number;
  readonly body: string;
  readonly author_id: string;
  readonly author_name: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export type Failure = "signin_required" | "forbidden" | "not_found" | "invalid";
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: Failure; message: string };
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = <T>(error: Failure, message: string): Result<T> => ({
  ok: false,
  error,
  message,
});

export const BODY_MAX = 500;

export function listNotes(
  db: Database,
  _who: Who,
  input: { limit?: number } = {},
): Result<Note[]> {
  const limit = Math.min(
    Math.max(Math.trunc(input.limit ?? 100) || 100, 1),
    500,
  );
  return ok(
    db
      .query<Note, [number]>("SELECT * FROM note ORDER BY id DESC LIMIT ?1")
      .all(limit),
  );
}

export function addNote(
  db: Database,
  who: Who,
  input: { body: string },
): Result<Note> {
  if (who.role === "anon")
    return fail("signin_required", "Sign in to add a note.");
  const body = input.body.trim();
  if (body.length === 0 || body.length > BODY_MAX)
    return fail("invalid", \`A note is 1 to \${BODY_MAX} characters.\`);
  const note = db
    .query<
      Note,
      [string, string, string]
    >("INSERT INTO note (body, author_id, author_name) VALUES (?1, ?2, ?3) RETURNING *")
    .get(body, who.id, who.name)!;
  emit("note.added", note);
  return ok(note);
}

export function deleteNote(
  db: Database,
  who: Who,
  input: { id: number },
): Result<{ id: number }> {
  if (who.role === "anon")
    return fail("signin_required", "Sign in to remove a note.");
  if (!Number.isInteger(input.id))
    return fail("invalid", "A note id is a whole number.");
  const note = db
    .query<Note, [number]>("SELECT * FROM note WHERE id = ?1")
    .get(input.id);
  if (note === null) return fail("not_found", "No such note.");
  if (!canDelete(who, note))
    return fail("forbidden", "Only the author or an admin can remove a note.");
  db.query("DELETE FROM note WHERE id = ?1").run(note.id);
  emit("note.removed", { id: note.id });
  return ok({ id: note.id });
}

/** Whether \`who\` may remove \`note\`. The page and the terminal draw from this, so the rule lives once. */
export const canDelete = (who: Who, note: Note): boolean =>
  who.role === "admin" || (who.role === "user" && who.id === note.author_id);
`;

// The bus and the event stream.
const LIVE_TS = `/**
 * Realtime without a framework. Actions \`emit\` what changed; \`GET /events\`
 * streams it to every open page as server-sent events, numbered, with the
 * last hundred kept so a client that reconnects with \`Last-Event-ID\` (or
 * \`?since=\`) hears what it missed. \`static/live.js\` turns the stream into
 * DOM events. The bus is this process's: the terminal is another process,
 * and its writes show on the next load rather than live.
 */

export interface LiveEvent {
  readonly id: number;
  readonly type: string;
  readonly data: unknown;
}

const KEEP = 100;
const HEARTBEAT_MS = 25_000;
const kept: LiveEvent[] = [];
const listeners = new Set<(event: LiveEvent) => void>();
let last = 0;

export function emit(type: string, data: unknown): LiveEvent {
  const event: LiveEvent = { id: ++last, type, data };
  kept.push(event);
  if (kept.length > KEEP) kept.shift();
  for (const listen of listeners) listen(event);
  return event;
}

export function subscribe(listen: (event: LiveEvent) => void): () => void {
  listeners.add(listen);
  return () => listeners.delete(listen);
}

/** \`GET /events\`: a stream that replays what \`since\` missed, then follows. */
export function events(request: Request): Response {
  const since = Number(
    request.headers.get("last-event-id") ??
      new URL(request.url).searchParams.get("since") ??
      0,
  );
  const encoder = new TextEncoder();
  let stop = (): void => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (text: string): void => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          stop();
        }
      };
      const send = (event: LiveEvent): void =>
        write(
          \`id: \${event.id}\\ndata: \${JSON.stringify({ type: event.type, data: event.data })}\\n\\n\`,
        );
      const heartbeat = setInterval(() => write(":\\n\\n"), HEARTBEAT_MS);
      const unsubscribe = subscribe(send);
      stop = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {}
      };
      request.signal.addEventListener("abort", stop);
      write("retry: 2000\\n\\n");
      for (const event of kept) if (event.id > since) send(event);
    },
    cancel() {
      stop();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}
`;

// The floor.
const HTTP_TS = `/**
 * The floor every response stands on, and the few things a route needs to
 * read a request safely. Nothing in here knows what a note is.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { publicOrigin } from "./env.ts";

// Scripts and styles come from this origin (inline styles allowed, inline
// scripts not), nothing frames us, browsers never guess a content type, and
// referrers stay on this site. Once served over https, always: browsers
// remember for a year.
export const SECURITY: Record<string, string> = {
  "content-security-policy":
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  ...(publicOrigin.startsWith("https:")
    ? { "strict-transport-security": "max-age=31536000" }
    : {}),
};

export const escape = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] ?? c,
  );

export const html = (
  body: string,
  status = 200,
  headers: Record<string, string> = {},
): Response =>
  new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...SECURITY,
      ...headers,
    },
  });

export const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...SECURITY },
  });

export const text = (body: string, status = 200): Response =>
  new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...SECURITY },
  });

/** Back to the page, with a word for it to show once (\`readNotice\`). */
export const back = (notice?: string): Response =>
  new Response(null, {
    status: 303,
    headers: {
      location: "/",
      ...SECURITY,
      ...(notice === undefined
        ? {}
        : { "set-cookie": cookie("notice", encodeURIComponent(notice), 30) }),
    },
  });

/** The notice a redirect left, and the header that clears it. */
export function readNotice(request: Request): {
  notice?: string;
  clear: Record<string, string>;
} {
  const raw = /(?:^|;\\s*)notice=([^;]*)/.exec(
    request.headers.get("cookie") ?? "",
  )?.[1];
  if (raw === undefined) return { clear: {} };
  return {
    notice: decodeURIComponent(raw),
    clear: { "set-cookie": cookie("notice", "", 0) },
  };
}

// Every cookie the app sets itself is HttpOnly and SameSite=Lax, and Secure
// wherever the public address is https.
const cookie = (name: string, value: string, maxAge: number): string =>
  \`\${name}=\${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=\${maxAge}\${publicOrigin.startsWith("https:") ? "; Secure" : ""}\`;

// A browser on another site can make a person's browser POST here; it cannot
// make that request look same-origin. Browsers say where a request came from
// (Sec-Fetch-Site, or Origin); a request that names another site is refused.
// A script sends neither and is judged by its identity instead.
export const sameOrigin = (request: Request): boolean => {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin" || site === "none";
  const origin = request.headers.get("origin");
  return origin === null || origin === publicOrigin;
};

// A request body is read up to a cap and no further, counting the bytes as
// they arrive. A declared Content-Length is a claim: a chunked request has
// none, and a lie is free. Undefined means "too large" — refuse it. Past the
// cap the rest is drained and dropped so the connection stays usable for
// the next request; past eight times the cap it is cut off instead.
export const BODY_MAX = 64 * 1024;
export async function readBody(
  request: Request,
  max = BODY_MAX,
): Promise<Uint8Array | undefined> {
  const reader = request.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      for (;;) {
        const next = await reader.read();
        if (next.done) return undefined;
        size += next.value.byteLength;
        if (size > max * 8) {
          await reader.cancel();
          return undefined;
        }
      }
    }
    parts.push(value);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    body.set(part, at);
    at += part.byteLength;
  }
  return body;
}

/** The form fields of a capped body, decoded the way the browser sent them. */
export async function readForm(request: Request) {
  const body = await readBody(request);
  if (body === undefined) return undefined;
  return new Request(request.url, {
    method: "POST",
    headers: { "content-type": request.headers.get("content-type") ?? "" },
    body,
  }).formData();
}

/** The JSON of a capped body: \`undefined\` when too large, \`null\` when not JSON. */
export async function readJson(request: Request): Promise<unknown> {
  const body = await readBody(request);
  if (body === undefined) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
}

/** A JSON object's fields, whatever the wire carried. */
export const fields = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

// Writes are rationed per person (or per address, for a stranger): a bucket
// of \`burst\` tokens that refills at \`perSecond\`. In memory, so a restart
// forgets — which is the right size for one process on one machine.
const RATE = { burst: 20, perSecond: 2 };
const buckets = new Map<string, { tokens: number; at: number }>();
export function allow(key: string, now = Date.now()): boolean {
  const bucket = buckets.get(key) ?? { tokens: RATE.burst, at: now };
  bucket.tokens = Math.min(
    RATE.burst,
    bucket.tokens + ((now - bucket.at) / 1000) * RATE.perSecond,
  );
  bucket.at = now;
  buckets.set(key, bucket);
  if (buckets.size > 10_000)
    for (const [k, b] of buckets) if (now - b.at > 60_000) buckets.delete(k);
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

// Files under ./static are served as they are. A page links each one by
// its content (\`/static/app.css?v=3f2a9c1e\`), and that address is cached
// for a year: a change is a new address, never a stale cache.
const STATIC = join(import.meta.dir, "..", "static");
const versions = new Map<string, string>();
export function asset(name: string): string {
  let v = versions.get(name);
  if (v === undefined) {
    v = createHash("sha256")
      .update(readFileSync(join(STATIC, name)))
      .digest("hex")
      .slice(0, 8);
    versions.set(name, v);
  }
  return \`/static/\${name}?v=\${v}\`;
}
export function staticFile(name: string, versioned: boolean): Response {
  const path = join(STATIC, name);
  if (name.includes("/") || name.includes("..") || !existsSync(path))
    return text("not found", 404);
  return new Response(Bun.file(path), {
    headers: {
      "cache-control": versioned
        ? "public, max-age=31536000, immutable"
        : "no-cache",
      ...SECURITY,
    },
  });
}
`;

// The actions as tools.
const MCP_TS = `/**
 * An MCP server over plain HTTP: \`POST /mcp\` takes one JSON-RPC 2.0
 * message and answers with JSON (streamable HTTP without the stream —
 * nothing here needs to push). The tools are the actions, called with the
 * same identity the page gets, so an agent speaking MCP through the forge
 * is the person whose grant it carries, and a bare one is anonymous.
 */

import type { Database } from "bun:sqlite";
import { addNote, deleteNote, listNotes, type Result } from "./actions.ts";
import { title } from "./env.ts";
import { fields } from "./http.ts";
import type { Who } from "./who.ts";

interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly run: (
    db: Database,
    who: Who,
    args: Record<string, unknown>,
  ) => Result<unknown>;
}

export const tools: readonly Tool[] = [
  {
    name: "list_notes",
    description: "The notes, newest first.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          description: "At most this many (100).",
        },
      },
    },
    run: (db, who, args) =>
      listNotes(db, who, { limit: Number(args.limit ?? 100) }),
  },
  {
    name: "add_note",
    description:
      "Add a note as the signed-in person. Anonymous callers cannot.",
    inputSchema: {
      type: "object",
      properties: { body: { type: "string", maxLength: 500 } },
      required: ["body"],
    },
    run: (db, who, args) => addNote(db, who, { body: String(args.body ?? "") }),
  },
  {
    name: "delete_note",
    description: "Remove a note by id. Only its author or an admin can.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "integer" } },
      required: ["id"],
    },
    run: (db, who, args) => deleteNote(db, who, { id: Number(args.id) }),
  },
];

/** One JSON-RPC message in, an HTTP status and a body out (a notification gets 202 and no body). */
export function rpc(
  db: Database,
  who: Who,
  message: unknown,
): { status: number; body?: unknown } {
  const m = fields(message);
  const id = m.id ?? null;
  const reply = (result: unknown) => ({
    status: 200,
    body: { jsonrpc: "2.0", id, result },
  });
  const refuse = (code: number, text: string) => ({
    status: 200,
    body: { jsonrpc: "2.0", id, error: { code, message: text } },
  });
  if (m.jsonrpc !== "2.0" || typeof m.method !== "string")
    return refuse(-32600, "not a JSON-RPC 2.0 request");
  if (m.id === undefined) return { status: 202 };
  const params = fields(m.params);
  switch (m.method) {
    case "initialize":
      return reply({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: title, version: "1" },
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({
        tools: tools.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      });
    case "tools/call": {
      const tool = tools.find((t) => t.name === params.name);
      if (tool === undefined)
        return refuse(-32602, \`no tool named \${String(params.name)}\`);
      const result = tool.run(db, who, fields(params.arguments));
      return reply(
        result.ok
          ? { content: [{ type: "text", text: JSON.stringify(result.value) }] }
          : {
              content: [
                { type: "text", text: \`\${result.error}: \${result.message}\` },
              ],
              isError: true,
            },
      );
    }
    default:
      return refuse(-32601, \`no method \${m.method}\`);
  }
}
`;

// The page.
const PAGE_TS = `/**
 * The page, rendered on the server: the first paint is complete HTML, and
 * \`static/live.js\` keeps the notes fresh afterwards. When a second page
 * arrives, move \`layout\` to \`src/pages/layout.ts\` and give each page a file.
 */

import { canDelete, type Note } from "./actions.ts";
import { commit, description, env, ssh, title, where } from "./env.ts";
import { asset, escape } from "./http.ts";
import type { Who } from "./who.ts";

export function layout(body: string, who: Who): string {
  const door =
    who.role === "anon"
      ? \`<a class="button button-quiet" href="/__forge/signin?to=/">Sign in</a>\`
      : \`<span class="you"><b>\${escape(who.name)}</b>\${who.role === "admin" ? " · admin" : ""}</span>
        <a class="button button-quiet" href="/__forge/signout">Sign out</a>\`;
  return \`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="data:,">
<title>\${escape(title)}</title>
<link rel="stylesheet" href="\${asset("app.css")}">
<script type="module" src="\${asset("live.js")}"></script>
<body>
<div class="page">
  <header class="head">
    <div>
      <h1>\${escape(title)}</h1>
      <p class="muted">\${escape(description)}</p>
    </div>
    <nav class="row">
      <span class="pill" data-env="\${escape(env)}">\${escape(where)}</span>\${commit ? \`<span class="muted mono">\${escape(commit)}</span>\` : ""}
      \${door}
    </nav>
  </header>
  <main>\${body}</main>
  <footer class="muted">
    \${ssh === undefined ? "" : \`<p>Terminal: <code>\${escape(ssh)}</code></p>\`}
    <p>Also at <a href="/api/notes">/api/notes</a> and <code>POST /mcp</code>, with the same rules.</p>
  </footer>
</div>
</body>
</html>
\`;
}

export function home(input: {
  who: Who;
  notes: readonly Note[];
  notice?: string | undefined;
}): string {
  const { who, notes, notice } = input;
  const composer =
    who.role === "anon"
      ? \`<p class="muted">Reading as a guest. <a href="/__forge/signin?to=/">Sign in</a> to add a note.</p>\`
      : \`<form class="row" method="post" action="/notes">
        <input class="input" name="body" placeholder="Write a note" aria-label="New note" required maxlength="500" autocomplete="off" autofocus>
        <button class="button">Add</button>
      </form>\`;
  const list =
    notes.length === 0
      ? \`<p class="empty">No notes yet. Notes written here stay in \${escape(where)} data.</p>\`
      : \`<ul class="list">\${notes.map((note) => item(note, who)).join("")}</ul>\`;
  return layout(
    \`<section class="card">\${composer}</section>
  <section id="notes" data-live="note.added note.removed">\${list}</section>
  \${notice === undefined ? "" : \`<p class="toast" role="status">\${escape(notice)}</p>\`}\`,
    who,
  );
}

const item = (note: Note, who: Who): string => \`<li class="note">
  <div>
    <p>\${escape(note.body)}</p>
    <small class="muted">\${escape(note.author_name)} · <time datetime="\${escape(note.created_at)}">\${ago(note.created_at)}</time></small>
  </div>
  \${
    canDelete(who, note)
      ? \`<form method="post" action="/notes/\${note.id}/delete"><button class="button button-quiet" aria-label="Remove this note">Remove</button></form>\`
      : ""
  }
</li>\`;

const ago = (iso: string): string => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return \`\${Math.floor(s / 60)}m ago\`;
  if (s < 86400) return \`\${Math.floor(s / 3600)}h ago\`;
  return new Date(iso).toLocaleDateString("en", {
    month: "short",
    day: "numeric",
  });
};
`;

// Every path.
const ROUTES_TS = `/**
 * Every path the app answers, in one table. A route reads its request,
 * calls an action, and shapes the answer for its door — HTML for a
 * browser, JSON for a script — and that is all a route does.
 */

import type { Database } from "bun:sqlite";
import {
  addNote,
  deleteNote,
  listNotes,
  type Failure,
  type Result,
} from "./actions.ts";
import {
  back,
  fields,
  html,
  json,
  readForm,
  readJson,
  readNotice,
  staticFile,
  text,
} from "./http.ts";
import { events } from "./live.ts";
import { rpc } from "./mcp.ts";
import { home } from "./page.ts";
import type { Who } from "./who.ts";

export interface Context {
  readonly request: Request;
  readonly url: URL;
  readonly db: Database;
  readonly who: Who;
  readonly params: Record<string, string>;
}

export interface Route {
  readonly method: "GET" | "POST" | "DELETE";
  readonly path: string;
  readonly handle: (ctx: Context) => Response | Promise<Response>;
}

const STATUS: Record<Failure, number> = {
  signin_required: 401,
  forbidden: 403,
  not_found: 404,
  invalid: 422,
};

/** A result as JSON: the value, or \`{ error, message }\` with the matching status. */
const answer = <T>(result: Result<T>, status = 200): Response =>
  result.ok
    ? json(result.value, status)
    : json(
        { error: result.error, message: result.message },
        STATUS[result.error],
      );

/** A result for a form: back to the page, with what went wrong if it did. */
const done = <T>(result: Result<T>): Response =>
  result.ok ? back() : back(result.message);

export const routes: readonly Route[] = [
  // The page. Forms post and come back; the list stays live over /events.
  {
    method: "GET",
    path: "/",
    handle: (c) => {
      const { notice, clear } = readNotice(c.request);
      const notes = listNotes(c.db, c.who);
      return html(
        home({ who: c.who, notes: notes.ok ? notes.value : [], notice }),
        200,
        clear,
      );
    },
  },
  {
    method: "POST",
    path: "/notes",
    handle: async (c) => {
      const form = await readForm(c.request);
      if (form === undefined) return text("too large", 413);
      return done(
        addNote(c.db, c.who, { body: String(form.get("body") ?? "") }),
      );
    },
  },
  {
    method: "POST",
    path: "/notes/:id/delete",
    handle: (c) => done(deleteNote(c.db, c.who, { id: Number(c.params.id) })),
  },

  // The JSON API: the same actions, the same identity, plain status codes.
  {
    method: "GET",
    path: "/api/notes",
    handle: (c) =>
      answer(
        listNotes(c.db, c.who, {
          limit: Number(c.url.searchParams.get("limit") ?? 100),
        }),
      ),
  },
  {
    method: "POST",
    path: "/api/notes",
    handle: async (c) => {
      const body = await readJson(c.request);
      if (body === undefined) return json({ error: "too_large" }, 413);
      return answer(
        addNote(c.db, c.who, { body: String(fields(body).body ?? "") }),
        201,
      );
    },
  },
  {
    method: "DELETE",
    path: "/api/notes/:id",
    handle: (c) => answer(deleteNote(c.db, c.who, { id: Number(c.params.id) })),
  },

  // Live events, and the MCP server (the tools are the actions too).
  { method: "GET", path: "/events", handle: (c) => events(c.request) },
  {
    method: "POST",
    path: "/mcp",
    handle: async (c) => {
      const message = await readJson(c.request);
      if (message === undefined) return json({ error: "too_large" }, 413);
      if (message === null)
        return json({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "parse error" },
        });
      const { status, body } = rpc(c.db, c.who, message);
      return body === undefined
        ? new Response(null, { status })
        : json(body, status);
    },
  },
  {
    method: "GET",
    path: "/mcp",
    handle: () => text("this endpoint speaks JSON-RPC over POST", 405),
  },

  // Files under ./static, cached for a year when linked by content (\`asset\`).
  {
    method: "GET",
    path: "/static/:file",
    handle: (c) => staticFile(c.params.file ?? "", c.url.searchParams.has("v")),
  },
];

/** The route for a method and path, with what its \`:names\` matched. */
export function match(
  method: string,
  pathname: string,
): { route: Route; params: Record<string, string> } | undefined {
  const parts = pathname.split("/");
  for (const route of routes) {
    if (route.method !== method) continue;
    const pattern = route.path.split("/");
    if (pattern.length !== parts.length) continue;
    const params: Record<string, string> = {};
    const hit = pattern.every((p, i) => {
      if (p.startsWith(":")) {
        params[p.slice(1)] = decodeURIComponent(parts[i] ?? "");
        return true;
      }
      return p === parts[i];
    });
    if (hit) return { route, params };
  }
  return undefined;
}
`;

// Boot.
const SERVER_TS = `/**
 * The process the forge runs. \`serve\` opens the database and listens:
 * every request gets the floor (\`http.ts\`), an identity (\`who.ts\`) and
 * one route (\`routes.ts\`), and a write is refused before it is read if it
 * came from another site or from someone writing too fast. Run directly,
 * it serves what the forge said; a test calls \`serve\` with its own.
 */

import { openDb } from "./db.ts";
import { dataDir, identityKey, title, where } from "./env.ts";
import { allow, html, sameOrigin, text } from "./http.ts";
import { match } from "./routes.ts";
import { who } from "./who.ts";

export interface ServeOptions {
  readonly port: number;
  readonly hostname?: string | undefined;
  readonly dataDir: string;
  readonly identityKey: string;
}

export function serve(options: ServeOptions) {
  const db = openDb(options.dataDir);
  return Bun.serve({
    port: options.port,
    hostname: options.hostname ?? "127.0.0.1",
    // A connection that says nothing for a minute is dropped. The event
    // stream heartbeats every 25 seconds to stay well inside that.
    idleTimeout: 60,
    async fetch(request, server) {
      const url = new URL(request.url);
      const me = who(request, options.identityKey);
      const reading = request.method === "GET" || request.method === "HEAD";
      if (!reading) {
        if (!sameOrigin(request)) return text("forbidden", 403);
        // Behind the forge every stranger shares its address; a person is
        // their own bucket.
        const from =
          me.role === "anon"
            ? \`ip:\${server.requestIP(request)?.address ?? "?"}\`
            : \`user:\${me.id}\`;
        if (!allow(from)) return text("too many requests", 429);
      }
      const found = match(
        request.method === "HEAD" ? "GET" : request.method,
        url.pathname,
      );
      if (found === undefined) return text("not found", 404);
      const response = await found.route.handle({
        request,
        url,
        db,
        who: me,
        params: found.params,
      });
      // HEAD is GET without the body: a health check sees the app up.
      return request.method === "HEAD"
        ? new Response(null, {
            status: response.status,
            headers: response.headers,
          })
        : response;
    },
    // A bug answers with the floor and nothing else: never the runtime's
    // own error page, which carries source and paths, and never without
    // the headers. The detail goes to the log, where it belongs.
    error(error) {
      console.error(error);
      return html("<h1>Something went wrong</h1>", 500);
    },
  });
}

if (import.meta.main) {
  const server = serve({
    port: Number(process.env.PORT ?? 8080),
    hostname: process.env.HOST,
    dataDir,
    identityKey,
  });
  console.log(
    \`\${title} listening on http://\${server.hostname}:\${server.port} (\${where})\`,
  );
}
`;

// The terminal.
const TTY_TS = `/**
 * The app in a terminal. The forge runs this on a pty when someone
 * \`ssh\`es to the app, over the same data as the page and through the same
 * actions, as the account at the keyboard. j/k move, a adds, d removes the
 * note under the cursor, q leaves. Plain ANSI, no dependencies.
 */

import {
  addNote,
  canDelete,
  deleteNote,
  listNotes,
  type Note,
} from "./actions.ts";
import { openDb } from "./db.ts";
import { ssh, title, where } from "./env.ts";
import { whoAtTty } from "./who.ts";

const db = openDb();
const me = whoAtTty();
const esc = "\\x1b[";
const dim = (s: string): string => \`\${esc}2m\${s}\${esc}0m\`;
const bold = (s: string): string => \`\${esc}1m\${s}\${esc}0m\`;
const out = (s: string): void => {
  process.stdout.write(s);
};

let cursor = 0;
let typing: string | undefined;
let said = "";

const notes = (): Note[] => {
  const listed = listNotes(db, me);
  return listed.ok ? listed.value : [];
};

function draw(): void {
  const rows = notes();
  const lines = [
    \`\${bold(title)}  \${dim(where)}  \${dim(me.role === "anon" ? "guest" : \`\${me.name}\${me.role === "admin" ? " (admin)" : ""}\`)}\`,
    ssh === undefined ? "" : dim(\`connect: \${ssh}\`),
    "",
  ];
  if (rows.length === 0)
    lines.push(
      dim(
        me.role === "anon"
          ? "No notes yet."
          : "No notes yet. Press a to add one.",
      ),
    );
  rows.forEach((note, i) => {
    const body = i === cursor ? bold(note.body) : note.body;
    lines.push(
      \`\${i === cursor ? "▸" : " "} \${body}  \${dim(\`\${note.author_name} · \${note.created_at.slice(0, 16).replace("T", " ")}\`)}\`,
    );
  });
  lines.push("");
  if (typing !== undefined) lines.push(\`New note: \${typing}\${esc}7m \${esc}0m\`);
  else if (said !== "") lines.push(said);
  else
    lines.push(
      dim(
        me.role === "anon"
          ? "j/k move · q quit · sign in with a key the forge knows to add"
          : "j/k move · a add · d delete · q quit",
      ),
    );
  out(\`\${esc}2J\${esc}H\${lines.join("\\r\\n")}\`);
}

process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");
draw();
process.stdin.on("data", (key: string) => {
  said = "";
  if (typing !== undefined) {
    if (key === "\\r") {
      const added = addNote(db, me, { body: typing });
      if (!added.ok) said = added.message;
      typing = undefined;
      cursor = 0;
    } else if (key === "\\x1b") typing = undefined;
    else if (key === "\\x7f") typing = typing.slice(0, -1);
    else if (key >= " ") typing += key;
    draw();
    return;
  }
  if (key === "q" || key === "\\x03") {
    out(\`\${esc}2J\${esc}H\`);
    process.exit(0);
  }
  const rows = notes();
  if (key === "j" || key === "\\x1b[B")
    cursor = Math.min(cursor + 1, Math.max(0, rows.length - 1));
  if (key === "k" || key === "\\x1b[A") cursor = Math.max(cursor - 1, 0);
  if (key === "a") {
    if (me.role === "anon") said = "Sign in to add a note.";
    else typing = "";
  }
  if (key === "d") {
    const note = rows[cursor];
    if (note === undefined) said = "Nothing to remove.";
    else if (!canDelete(me, note))
      said = "Only the author or an admin can remove a note.";
    else {
      const removed = deleteNote(db, me, { id: note.id });
      if (!removed.ok) said = removed.message;
      cursor = Math.min(cursor, Math.max(0, rows.length - 2));
    }
  }
  draw();
});
process.stdout.on("resize", draw);
`;

// The look.
const APP_CSS = `/* Tokens first. Dark follows the system unless <html data-theme="light|dark"> decides. */
:root {
  color-scheme: light dark;
  --bg: #f6f6f3;
  --surface: #ffffff;
  --fg: #1c1c1a;
  --muted: #6f6f69;
  --line: #e3e3dd;
  --accent: #2f5bea;
  --accent-fg: #ffffff;
  --danger: #c2410c;
  --toast-bg: #1c1c1a;
  --toast-fg: #f6f6f3;
  --radius: 10px;
  --s1: 0.25rem;
  --s2: 0.5rem;
  --s3: 0.75rem;
  --s4: 1rem;
  --s5: 1.5rem;
  --s6: 2.5rem;
  --text-sm: 0.875rem;
  --text-lg: 1.125rem;
  --text-xl: 1.5rem;
  --tap: 44px;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #131312;
    --surface: #1d1d1b;
    --fg: #ecece7;
    --muted: #9a9a93;
    --line: #2c2c29;
    --accent: #7c96ff;
    --accent-fg: #0f1a4d;
    --danger: #fb923c;
    --toast-bg: #ecece7;
    --toast-fg: #131312;
  }
}
:root[data-theme="dark"] {
  --bg: #131312;
  --surface: #1d1d1b;
  --fg: #ecece7;
  --muted: #9a9a93;
  --line: #2c2c29;
  --accent: #7c96ff;
  --accent-fg: #0f1a4d;
  --danger: #fb923c;
  --toast-bg: #ecece7;
  --toast-fg: #131312;
}

/* The page. */
html {
  -webkit-text-size-adjust: 100%;
}
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font:
    16px/1.55 system-ui,
    -apple-system,
    "Segoe UI",
    sans-serif;
}
.page {
  max-width: 40rem;
  margin: 0 auto;
  padding: var(--s5) var(--s4) var(--s6);
}
.head {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--s3) var(--s4);
  margin-bottom: var(--s5);
}
h1 {
  margin: 0;
  font-size: var(--text-xl);
  font-weight: 650;
  letter-spacing: -0.01em;
  line-height: 1.2;
}
p {
  margin: 0;
}
a {
  color: var(--accent);
  text-decoration-thickness: 1px;
  text-underline-offset: 0.15em;
}
code,
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--text-sm);
}
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.muted {
  color: var(--muted);
}
.you {
  color: var(--muted);
  white-space: nowrap;
}

/* Blocks. */
.card {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: var(--s4);
  margin-bottom: var(--s5);
}
.row {
  display: flex;
  align-items: center;
  gap: var(--s2);
}
.list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.note {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--s3);
  padding: var(--s3) 0;
  border-top: 1px solid var(--line);
}
.note:first-child {
  border-top: 0;
}
.note p {
  overflow-wrap: anywhere;
}
.note small {
  font-size: var(--text-sm);
}
.empty {
  padding: var(--s6) var(--s4);
  text-align: center;
  color: var(--muted);
  border: 1px dashed var(--line);
  border-radius: var(--radius);
}
footer {
  margin-top: var(--s6);
  font-size: var(--text-sm);
  display: grid;
  gap: var(--s1);
}
footer code {
  overflow-wrap: anywhere;
}

/* Controls: at least 44px on a side, keyboard and mouse alike. */
.input {
  flex: 1;
  min-width: 0;
  min-height: var(--tap);
  padding: 0 var(--s3);
  font: inherit;
  color: inherit;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: var(--radius);
}
.input::placeholder {
  color: var(--muted);
}
.button {
  min-height: var(--tap);
  padding: 0 var(--s4);
  font: inherit;
  font-weight: 600;
  color: var(--accent-fg);
  background: var(--accent);
  border: 1px solid transparent;
  border-radius: var(--radius);
  cursor: pointer;
  white-space: nowrap;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
}
.button:hover {
  filter: brightness(1.08);
}
.button-quiet {
  color: var(--muted);
  background: transparent;
  padding: 0 var(--s3);
}
.button-quiet:hover {
  color: var(--fg);
  border-color: var(--line);
  filter: none;
}
.pill {
  display: inline-block;
  padding: 0.1rem 0.6rem;
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--muted);
  border: 1px solid var(--line);
  border-radius: 999px;
}
.pill[data-env="production"] {
  color: var(--accent);
  border-color: currentColor;
}

/* A word from the last request, shown once, gone in a moment. */
.toast {
  position: fixed;
  left: 50%;
  bottom: var(--s5);
  transform: translateX(-50%);
  max-width: calc(100% - 2 * var(--s4));
  padding: var(--s3) var(--s4);
  color: var(--toast-fg);
  background: var(--toast-bg);
  border-radius: 999px;
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.18);
  animation: toast 6s forwards;
}
@keyframes toast {
  0%,
  85% {
    opacity: 1;
  }
  100% {
    opacity: 0;
    visibility: hidden;
  }
}
@media (prefers-reduced-motion: reduce) {
  .toast {
    animation: none;
  }
}
`;

// The list that stays current.
const LIVE_JS = `// The page stays current without a reload. /events is a stream of what
// changed; each event becomes \`live\` and \`live:<type>\` on \`document\`, and
// any element with data-live="<types>" is refetched and swapped when one of
// its types arrives — server-rendered, so the page never renders twice.
// Without this file the page is the same page, one reload behind.

let since = "";
let tries = 0;
let source;

function connect() {
  source = new EventSource(since ? \`/events?since=\${since}\` : "/events");
  source.onopen = () => {
    if (tries > 0) refresh(); // Reconnected: whatever was missed, catch up.
    tries = 0;
  };
  source.onmessage = (message) => {
    since = message.lastEventId;
    const { type, data } = JSON.parse(message.data);
    document.dispatchEvent(new CustomEvent("live", { detail: { type, data } }));
    document.dispatchEvent(new CustomEvent(\`live:\${type}\`, { detail: data }));
  };
  // The browser retries a dropped connection itself; a refused one it gives
  // up on, and then we try again, later each time.
  source.onerror = () => {
    if (source.readyState !== EventSource.CLOSED) return;
    source.close();
    setTimeout(connect, Math.min(30_000, 1000 * 2 ** tries++));
  };
}

let refreshing = false;
let again = false;
async function refresh(types) {
  const regions = [...document.querySelectorAll("[data-live]")].filter(
    (el) =>
      types === undefined ||
      el.dataset.live.split(" ").some((t) => types.includes(t)),
  );
  if (regions.length === 0) return;
  if (refreshing) {
    again = true;
    return;
  }
  refreshing = true;
  try {
    const response = await fetch(location.href, {
      headers: { accept: "text/html" },
    });
    const fresh = new DOMParser().parseFromString(
      await response.text(),
      "text/html",
    );
    for (const el of regions) {
      const next = fresh.getElementById(el.id);
      if (next) el.replaceWith(next);
    }
  } finally {
    refreshing = false;
    if (again) {
      again = false;
      refresh();
    }
  }
}

document.addEventListener("live", (event) => refresh([event.detail.type]));
connect();
`;

// The tests the app starts with.
const WHO_TEST = `import { expect, test } from "bun:test";
import { sign, who, whoAtTty } from "./who.ts";

const KEY = "a-key-only-the-forge-holds";
const later = Date.now() + 60_000;
const request = (identity: string, signature: string): Request =>
  new Request("http://app/", {
    headers: { "x-forge-identity": identity, "x-forge-signature": signature },
  });

test("a signed identity is who it says", () => {
  const identity = \`u1|alice|admin|\${later}\`;
  expect(who(request(identity, sign(identity, KEY)), KEY)).toEqual({
    role: "admin",
    id: "u1",
    name: "alice",
  });
});

test("a forged, tampered, expired or unsigned identity is anonymous", () => {
  const identity = \`u1|alice|admin|\${later}\`;
  expect(who(request(identity, sign(identity, "another key")), KEY)).toEqual({
    role: "anon",
  });
  expect(
    who(request(\`u1|alice|admin|\${later + 1}\`, sign(identity, KEY)), KEY),
  ).toEqual({ role: "anon" });
  const expired = \`u1|alice|user|\${Date.now() - 1}\`;
  expect(who(request(expired, sign(expired, KEY)), KEY)).toEqual({
    role: "anon",
  });
  const odd = \`u1|alice|owner|\${later}\`;
  expect(who(request(odd, sign(odd, KEY)), KEY)).toEqual({ role: "anon" });
  expect(who(new Request("http://app/"), KEY)).toEqual({ role: "anon" });
  // No key configured: nothing verifies, whoever signed it.
  expect(who(request(identity, sign(identity, KEY)), "")).toEqual({
    role: "anon",
  });
});

test("the terminal trusts its environment", () => {
  expect(whoAtTty({})).toEqual({ role: "anon" });
  expect(whoAtTty({ FORGE_APP_USER: "alice" })).toEqual({
    role: "user",
    id: "alice",
    name: "alice",
  });
  expect(
    whoAtTty({
      FORGE_APP_USER: "alice",
      FORGE_APP_USER_ID: "u1",
      FORGE_APP_USER_ROLE: "admin",
    }),
  ).toEqual({
    role: "admin",
    id: "u1",
    name: "alice",
  });
});
`;

const DB_TEST = `import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, migrate, migrations, openDb } from "./db.ts";

test("migrations apply once, in order, and the file checks out", () => {
  const dir = mkdtempSync(join(tmpdir(), "app-db-"));
  const db = openDb(dir);
  expect(check(db).version).toBe(migrations.length);
  // Opening again finds nothing to do — a migration that has run is history.
  expect(migrate(db)).toBe(migrations.length);
  expect(() => openDb(dir)).not.toThrow();
  expect(check(db)).toEqual({ version: migrations.length, integrity: "ok" });
  expect(
    db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()
      ?.journal_mode,
  ).toBe("wal");
  expect(
    db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()
      ?.foreign_keys,
  ).toBe(1);
});
`;

const ACTIONS_TEST = `import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addNote, deleteNote, listNotes } from "./actions.ts";
import { openDb } from "./db.ts";
import type { Who } from "./who.ts";

const db = openDb(mkdtempSync(join(tmpdir(), "app-actions-")));
const anon: Who = { role: "anon" };
const alice: Who = { role: "user", id: "u1", name: "alice" };
const bob: Who = { role: "user", id: "u2", name: "bob" };
const root: Who = { role: "admin", id: "u0", name: "root" };

test("anyone reads; only a signed-in person adds, as themselves", () => {
  expect(listNotes(db, anon)).toEqual({ ok: true, value: [] });
  const refused = addNote(db, anon, { body: "hello" });
  expect(refused.ok).toBe(false);
  if (!refused.ok) expect(refused.error).toBe("signin_required");
  const added = addNote(db, alice, { body: "  hello  " });
  expect(added.ok).toBe(true);
  if (!added.ok) return;
  expect(added.value.body).toBe("hello");
  expect(added.value.author_id).toBe("u1");
  expect(added.value.author_name).toBe("alice");
  const all = listNotes(db, anon);
  expect(all.ok && all.value.length).toBe(1);
});

test("a note is one to five hundred characters", () => {
  for (const body of ["", "   ", "x".repeat(501)]) {
    const r = addNote(db, alice, { body });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("invalid");
  }
});

test("only the author or an admin removes a note", () => {
  const mine = addNote(db, alice, { body: "mine" });
  if (!mine.ok) throw new Error(mine.message);
  const byBob = deleteNote(db, bob, { id: mine.value.id });
  expect(byBob.ok).toBe(false);
  if (!byBob.ok) expect(byBob.error).toBe("forbidden");
  const byAnon = deleteNote(db, anon, { id: mine.value.id });
  expect(byAnon.ok).toBe(false);
  if (!byAnon.ok) expect(byAnon.error).toBe("signin_required");
  expect(deleteNote(db, alice, { id: mine.value.id }).ok).toBe(true);
  const gone = deleteNote(db, alice, { id: mine.value.id });
  expect(gone.ok).toBe(false);
  if (!gone.ok) expect(gone.error).toBe("not_found");

  const bobs = addNote(db, bob, { body: "bob's" });
  if (!bobs.ok) throw new Error(bobs.message);
  expect(deleteNote(db, root, { id: bobs.value.id }).ok).toBe(true);
  const odd = deleteNote(db, root, { id: 1.5 });
  expect(odd.ok).toBe(false);
  if (!odd.ok) expect(odd.error).toBe("invalid");
});
`;

const SERVER_TEST = `import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "./server.ts";
import { sign } from "./who.ts";

const KEY = "a-key-only-the-forge-holds";
const server = serve({
  port: 0,
  dataDir: mkdtempSync(join(tmpdir(), "app-")),
  identityKey: KEY,
});
const base = \`http://\${server.hostname}:\${server.port}\`;
afterAll(() => server.stop(true));

/** The headers the forge sends for a signed-in person. */
const as = (
  id: string,
  name: string,
  role: "user" | "admin" = "user",
): Record<string, string> => {
  const identity = \`\${id}|\${name}|\${role}|\${Date.now() + 60_000}\`;
  return {
    "x-forge-identity": identity,
    "x-forge-signature": sign(identity, KEY),
  };
};
const alice = as("u1", "alice");
const bob = as("u2", "bob");
const root = as("u0", "root", "admin");
const jsonBody = (body: unknown): RequestInit => ({
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const api = (
  path: string,
  init: RequestInit = {},
  who: Record<string, string> = {},
) =>
  fetch(base + path, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), ...who },
  });
const rpc = (message: unknown, who: Record<string, string> = {}) =>
  api("/mcp", { method: "POST", ...jsonBody(message) }, who).then(
    (r) => r.json() as Promise<any>,
  );

test("the page knows who you are and offers the right door", async () => {
  const guest = await (await fetch(base + "/")).text();
  expect(guest).toContain("<h1>");
  expect(guest).toContain("/__forge/signin?to=/");
  expect(guest).not.toContain('action="/notes"');
  const signed = await (await api("/", {}, alice)).text();
  expect(signed).toContain("<b>alice</b>");
  expect(signed).toContain("/__forge/signout");
  expect(signed).toContain('action="/notes"');
});

test("a form post adds as the person; a guest is sent to sign in", async () => {
  const form = new FormData();
  form.set("body", "hello from a form");
  const refused = await api("/notes", {
    method: "POST",
    body: form,
    redirect: "manual",
  });
  expect(refused.status).toBe(303);
  expect(refused.headers.get("set-cookie")).toContain("notice=");
  expect(refused.headers.get("set-cookie")).toContain("SameSite=Lax");
  expect(await (await fetch(base + "/")).text()).not.toContain(
    "hello from a form",
  );
  const posted = await api(
    "/notes",
    { method: "POST", body: form, redirect: "manual" },
    alice,
  );
  expect(posted.status).toBe(303);
  expect(posted.headers.get("set-cookie")).toBeNull();
  const page = await (await api("/", {}, alice)).text();
  expect(page).toContain("hello from a form");
  expect(page).toContain("alice ·");
});

test("the JSON API is the same actions with the same identity", async () => {
  const created = await api(
    "/api/notes",
    { method: "POST", ...jsonBody({ body: "over the api" }) },
    alice,
  );
  expect(created.status).toBe(201);
  const note = (await created.json()) as { id: number; author_name: string };
  expect(note.author_name).toBe("alice");
  const listed = (await (await fetch(base + "/api/notes")).json()) as {
    id: number;
  }[];
  expect(listed.map((n) => n.id)).toContain(note.id);
  expect(
    (await api("/api/notes", { method: "POST", ...jsonBody({ body: "anon" }) }))
      .status,
  ).toBe(401);
  expect(
    (await api(\`/api/notes/\${note.id}\`, { method: "DELETE" }, bob)).status,
  ).toBe(403);
  expect(
    (await api(\`/api/notes/\${note.id}\`, { method: "DELETE" }, alice)).status,
  ).toBe(200);
  expect(
    (await api(\`/api/notes/\${note.id}\`, { method: "DELETE" }, alice)).status,
  ).toBe(404);
  expect(
    (
      await api(
        "/api/notes",
        { method: "POST", ...jsonBody({ body: "" }) },
        alice,
      )
    ).status,
  ).toBe(422);
});

test("the MCP server lists the tools and calls them as the caller", async () => {
  const hello = await rpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {},
  });
  expect(hello.result.capabilities).toEqual({ tools: {} });
  const listed = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  expect(listed.result.tools.map((t: { name: string }) => t.name)).toEqual([
    "list_notes",
    "add_note",
    "delete_note",
  ]);
  const call = (name: string, args: unknown, who = {}) =>
    rpc(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name, arguments: args },
      },
      who,
    );
  const refused = await call("add_note", { body: "as nobody" });
  expect(refused.result.isError).toBe(true);
  const added = await call("add_note", { body: "over mcp" }, root);
  expect(added.result.isError).toBeUndefined();
  const note = JSON.parse(added.result.content[0].text);
  expect(note.author_name).toBe("root");
  const notes = JSON.parse(
    (await call("list_notes", {})).result.content[0].text,
  );
  expect(notes.map((n: { id: number }) => n.id)).toContain(note.id);
  expect(
    (await call("delete_note", { id: note.id }, root)).result.isError,
  ).toBeUndefined();
  expect(
    (await rpc({ jsonrpc: "2.0", id: 4, method: "nothing" })).error.code,
  ).toBe(-32601);
  const notified = await api("/mcp", {
    method: "POST",
    ...jsonBody({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  expect(notified.status).toBe(202);
});

test("a change is on the event stream, and a late client hears what it missed", async () => {
  const stream = await fetch(base + "/events");
  expect(stream.headers.get("content-type")).toBe("text/event-stream");
  const reader = stream.body!.getReader();
  const next = async (): Promise<{ id: string; type: string }> => {
    let buffer = "";
    for (;;) {
      const { value } = await reader.read();
      buffer += new TextDecoder().decode(value);
      const frame = /id: (\\d+)\\ndata: (.*)\\n\\n/.exec(buffer);
      if (frame) return { id: frame[1]!, type: JSON.parse(frame[2]!).type };
    }
  };
  await api(
    "/api/notes",
    { method: "POST", ...jsonBody({ body: "live" }) },
    alice,
  );
  const heard = await next();
  expect(heard.type).toBe("note.added");
  await reader.cancel();
  const late = await fetch(base + "/events", {
    headers: { "last-event-id": String(Number(heard.id) - 1) },
  });
  const replay = new TextDecoder().decode(
    (await late.body!.getReader().read()).value,
  );
  expect(replay).toContain(\`id: \${heard.id}\\n\`);
  expect(replay).toContain("note.added");
});

test("writes are rationed per person", async () => {
  const flood = as("u9", "flood");
  const answers = await Promise.all(
    Array.from({ length: 40 }, () =>
      api(
        "/api/notes",
        { method: "POST", ...jsonBody({ body: "again" }) },
        flood,
      ),
    ),
  );
  const codes = answers.map((r) => r.status);
  expect(codes).toContain(201);
  expect(codes).toContain(429);
});

test("stands on the security floor", async () => {
  const response = await fetch(base + "/");
  expect(response.headers.get("content-security-policy")).toContain(
    "default-src 'self'",
  );
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(
    (await fetch(base + "/api/notes")).headers.get("content-security-policy"),
  ).toContain("default-src");
});

test("a body is capped by the bytes read, whatever it claims", async () => {
  const response = await api(
    "/notes",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "body=" + "x".repeat(1024 * 1024),
    },
    alice,
  );
  expect(response.status).toBe(413);
});

test("HEAD sees the app up", async () => {
  const response = await fetch(base + "/", { method: "HEAD" });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("");
});

test("refuses a cross-site post", async () => {
  const form = new FormData();
  form.set("body", "from another site");
  const posted = await api(
    "/notes",
    {
      method: "POST",
      body: form,
      redirect: "manual",
      headers: {
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
      },
    },
    alice,
  );
  expect(posted.status).toBe(403);
});

test("static files are cached for a year when linked by content", async () => {
  const page = await (await fetch(base + "/")).text();
  const href = /href="(\\/static\\/app\\.css\\?v=[0-9a-f]{8})"/.exec(page)?.[1];
  expect(href).toBeDefined();
  const css = await fetch(base + href!);
  expect(css.headers.get("cache-control")).toContain("immutable");
  expect(
    (await fetch(base + "/static/app.css")).headers.get("cache-control"),
  ).toBe("no-cache");
  expect((await fetch(base + "/static/..%2Fpackage.json")).status).toBe(404);
});
`;
