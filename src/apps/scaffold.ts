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

import { readFileSync } from "node:fs";
import type { FileWrite } from "../git/write.ts";
import { beaconJs } from "../web/beacon.ts";
import { SIGNIN_EXPIRED, SIGNIN_NOT_THIS_BROWSER } from "../kernel/signin_words.ts";

/**
 * The evaluator an app decides with is the forge's own, carried as text:
 * one implementation, so the forge can audit an app's `contract.json` with
 * exactly the code the app runs.
 */
const CAN_TS = readFileSync(
  new URL("../contract/can.ts", import.meta.url),
  "utf8",
);

/**
 * The forge's own page-view beacon, posting to the door the forge proxy
 * answers on the app's host: the app holds no secret and keeps no report.
 */
const BEACON_JS = beaconJs.replace("/_measure", "/__forge/measure") + "\n";

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
    { path: "contract.json", content: CONTRACT_JSON },
    {
      path: "contract/openapi.json",
      content: openapiJson(title, description),
    },
    { path: "design/tokens.json", content: TOKENS_JSON },
    { path: "src/env.ts", content: ENV_TS },
    { path: "src/who.ts", content: WHO_TS },
    { path: "src/signin.ts", content: SIGNIN_TS },
    { path: "src/once.ts", content: ONCE_TS },
    { path: "src/once.test.ts", content: ONCE_TEST },
    { path: "src/can.ts", content: CAN_TS },
    { path: "src/contract.ts", content: CONTRACT_TS },
    { path: "src/security.ts", content: SECURITY_TS },
    { path: "src/audit.ts", content: AUDIT_TS },
    { path: "src/db.ts", content: DB_TS },
    { path: "src/actions.ts", content: ACTIONS_TS },
    { path: "src/live.ts", content: LIVE_TS },
    { path: "src/http.ts", content: HTTP_TS },
    { path: "src/mcp.ts", content: MCP_TS },
    { path: "src/page.ts", content: PAGE_TS },
    { path: "src/site.ts", content: SITE_TS },
    { path: "src/compress.ts", content: COMPRESS_TS },
    { path: "src/tokens.ts", content: TOKENS_TS },
    { path: "src/openapi.ts", content: OPENAPI_TS },
    { path: "src/routes.ts", content: ROUTES_TS },
    { path: "src/server.ts", content: SERVER_TS },
    { path: "src/tty.ts", content: TTY_TS },
    { path: "scripts/lint-design.ts", content: LINT_DESIGN_TS },
    { path: "scripts/contract-emit.ts", content: CONTRACT_EMIT_TS },
    { path: "static/app.css", content: APP_CSS },
    { path: "static/live.js", content: LIVE_JS },
    { path: "static/beacon.js", content: BEACON_JS },
    { path: "src/who.test.ts", content: WHO_TEST },
    { path: "src/signin.test.ts", content: SIGNIN_TEST },
    { path: "src/db.test.ts", content: DB_TEST },
    { path: "src/actions.test.ts", content: ACTIONS_TEST },
    { path: "src/contract.test.ts", content: CONTRACT_TEST },
    { path: "src/server.test.ts", content: SERVER_TEST },
    { path: "src/security.test.ts", content: SECURITY_TEST },
    { path: "src/audit.test.ts", content: AUDIT_TEST },
    { path: "src/openapi.test.ts", content: OPENAPI_TEST },
    { path: "src/design.test.ts", content: DESIGN_TEST },
    { path: "src/site.test.ts", content: SITE_TEST },
  ];
}

const FORGE_JSON = `{
  "app": {
    "run": "bun run src/server.ts",
    "test": "bun test",
    "health": "/healthz",
    "tty": "bun run src/tty.ts"
  }
}
`;

const packageJson = (name: string, description: string): string =>
  `${JSON.stringify(
    {
      name,
      version: "0.1.0",
      description,
      private: true,
      type: "module",
      scripts: {
        start: "bun run src/server.ts",
        test: "bun test",
        "lint:design": "bun run scripts/lint-design.ts",
        "contract:emit": "bun run scripts/contract-emit.ts",
      },
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
bun test                                                # what \`forge.json\`'s app.test runs on every push
FORGE_APP_DATA=./data bun run src/tty.ts                # the terminal
FORGE_APP_DATA=./data bun run src/db.ts --check         # schema version, integrity
bun run lint:design                                     # no colour but the tokens'
bun run contract:emit                                   # rewrite contract/openapi.json from the routes
\`\`\`

\`app.test\` in \`forge.json\` runs beside \`app.run\` in every deploy, not before
it: the preview comes up the moment the app answers, and says \`live\`, or
\`serving · tests failed\` the moment the suite disagrees.

Every response carries \`Content-Security-Policy\`, \`X-Content-Type-Options\`,
\`Referrer-Policy\` and \`Cross-Origin-Opener-Policy: same-origin\` (the last
cuts a page off from any window that opened it); they are set in \`src/http.ts\`.

## The shape

One implementation, many doors. \`src/actions.ts\` is every operation as a
plain function — \`(db, who, input)\` in, data or a named failure out — and
the page, the JSON API, the MCP server and the terminal all call it and
decide nothing themselves. \`AGENTS.md\` says how to add to it.

| file                               | what it is                                                     |
| ---------------------------------- | -------------------------------------------------------------- |
| \`src/actions.ts\`                   | list, add, delete; the audit trail, read                       |
| \`contract.json\`                    | who may do what: roles, and the least role each verb needs     |
| \`src/contract.ts\`, \`src/can.ts\`    | the table, read at boot; the forge's evaluator, verbatim       |
| \`src/security.ts\`                  | the door: rationing, same origin, the table before the body    |
| \`src/audit.ts\`                     | every change and every refused one, as a row                   |
| \`src/who.ts\`                       | who is asking, from the forge's signed headers                 |
| \`src/signin.ts\`                    | sign-in through the forge: OpenID Connect, code flow with PKCE |
| \`src/once.ts\`                      | a job the forge fires: verified, and run once per key          |
| \`src/db.ts\`                        | SQLite under \`FORGE_APP_DATA\`, WAL, forward-only migrations    |
| \`src/live.ts\`                      | the in-process bus and \`GET /events\`                           |
| \`src/mcp.ts\`                       | the actions as MCP tools at \`POST /mcp\`                        |
| \`src/routes.ts\`                    | every path, in one table, each API route described beside it   |
| \`src/openapi.ts\`                   | the routes as OpenAPI; committed at \`contract/openapi.json\`    |
| \`src/page.ts\`                      | the HTML, rendered on the server, with its share metadata      |
| \`src/site.ts\`                      | icon, manifest, card, sitemap, llms.txt, structured data       |
| \`src/compress.ts\`                  | gzip for text responses                                        |
| \`design/tokens.json\`, \`src/tokens.ts\` | the look as data, light and dark; compiled to \`/tokens.css\` |
| \`src/http.ts\`                      | the floor: headers, body cap, files                            |
| \`src/server.ts\`                    | boot: open the database, serve                                 |
| \`src/tty.ts\`                       | the terminal, over the same actions                            |
| \`src/env.ts\`                       | what the forge told this process                               |
| \`static/app.css\`, \`static/live.js\` | the look in the tokens' words, and the list that stays current |
| \`static/beacon.js\`                | reports each page's load and INP to the forge, which counts visitors: no secret, no address kept |

## What every app stands on

- **The door.** Before a route sees a request, \`src/security.ts\` rations
  writes (and a stranger's API calls), refuses a write from another site,
  and turns away — before the body is read — anyone the table lets through
  a resource's door for no row at all: 401 for a stranger, 403 for anyone
  else. The action still decides about the real row.
- **The audit trail.** Every change, and every change refused, is a row:
  who, which resource and verb, which row, when, and whether they were
  let. Admins read it at \`GET /api/audit\`. A row that cannot be written
  is a log line, never a failed request.
- **The API, described.** \`GET /openapi.json\` is \`contract/openapi.json\`,
  written from the routes by \`bun run contract:emit\`; each operation names
  its cell of the table (\`x-contract\`). \`bun test\` fails while it is stale.
- **Up, or not.** \`GET /healthz\` answers \`{ ok, version, uptime }\`; the
  forge waits on it before it sends anyone to a deploy.
- **The look.** \`design/tokens.json\` holds every colour, space and size,
  light and dark; nothing else spells out a colour (\`bun run lint:design\`),
  and every pair a person reads meets 4.5:1 in both themes.
- **The open web.** A shared link unfurls (description, Open Graph, a
  large generated card at \`/og.png\`); every page names its canonical
  address and carries \`WebSite\` structured data; there is an icon
  (\`/icon.svg\`), a 180px home-screen icon and a manifest; \`/sitemap.xml\`
  and \`/llms.txt\` describe the site; \`/robots.txt\` keeps crawlers to the
  page (and names the sitemap), and out of previews entirely;
  \`/.well-known/security.txt\` names the forge that runs the app as the
  place to report; \`/.well-known/change-password\` sends people to it too.
  A page carries an \`ETag\` and answers \`If-None-Match\` with 304. A
  missing page and a failure are the app's own page, with the right
  status. HSTS covers subdomains and is never a preload promise.
- **Reachable.** A skip link and \`<main id="main">\`, forced-colours
  styles, and one \`<h1>\` with no skipped level (\`src/site.test.ts\` holds
  all of it).
- **Small on the wire.** \`src/compress.ts\` gzips text of a kilobyte or
  more for browsers that read gzip (never the event stream); a proxy in
  front that compresses sees \`content-encoding\` and leaves it alone.
- **Left to the owner.** Telling AI crawlers what they may do, content
  signals, an agent card and \`.md\` versions of pages are decisions about
  who may read the site and for what; the template makes none of them.
  Decide, then add them (and a test) deliberately. The card and icons are
  flat shapes in the accent colour, not a drawn logo: swap in your own.

## Who you are

The forge says who is asking on every request it proxies, and the app
verifies the signature (\`src/who.ts\`); nothing else is trusted. Three tiers:

- **anon** — anyone. Reads.
- **user** — signed in to the forge and able to see this app. Adds notes, as
  themselves, and removes their own.
- **admin** — able to write this repository. Removes any note.

"Sign in" is \`/signin\`: the OpenID Connect code flow with PKCE against
\`FORGE_URL\` (\`src/signin.ts\`). The app registers its own redirect
address on first boot and keeps the client id in \`FORGE_APP_DATA\`, checks
the \`id_token\` itself, and keeps a session in an HttpOnly cookie. A person
signed in this way is a \`user\`; \`admin\` still comes from the forge's
signed headers (which win over a session), until those are retired. "Sign out" is a POST to \`/signout\`.
The forge answers \`/__forge/report\`: it sends anyone, with no account, to report a
problem on this app's repository, if that repository is public.

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
- Run \`bun test\` before you push. \`forge.json\`'s \`app.test\` runs it beside
  the app on every deploy, not before it: the preview comes up the moment
  the app answers and says \`live\`, or \`serving · tests failed\` the moment
  the suite disagrees. Every behaviour you add gets a test that would fail
  without it.
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
verified by signature, never by a cookie the app invents.

Every request passes the door (\`src/security.ts\`) before a route sees it:
writes are rationed, a write from another site is refused, and a request
under a resource's \`api\` path is refused — before its body is read — when
the table lets that person through that door for no row at all. The door
asks the same table the actions do; it never compares roles by hand, and
the action still decides about the real row. Do not route around it.

Every change is written down. An action that creates, updates or deletes
returns through \`audited\` (\`src/actions.ts\`), which appends a row to the
\`audit\` table — who, the resource and verb, the row, when, and whether
they were let — refused attempts included; the door records the writes it
turns away. Admins read it at \`GET /api/audit\` (the \`audit\` resource in
\`contract.json\`). Recording never fails a request: a row that cannot be
written is a log line.

Who may do what is a table, not code: \`contract.json\`. It declares the
roles — each names the roles below it, and how it is held: by everyone, by
the identity the forge signed, or by a row's column naming the person — and,
for every resource, the least role each of create, read, update, delete and
list needs. An action asks \`permit(who, resource, verb, row)\`
(\`src/contract.ts\`) and obeys the answer; it never compares \`who.role\`
itself. \`src/can.ts\` is the forge's evaluator, carried verbatim: do not
edit it. \`src/contract.test.ts\` acts as every identity at every door and
fails when a door and the table disagree.

A new kind of person is a new role in the table, under an existing one. A
change to a cell is a change of policy: say so in the pull's description.
A cell loosened — anything an identity could not do before that it can
after — is a wall: the forge shows the pull to a person and never lands it
on its own. Do not loosen a cell unless the issue asks for exactly that;
prefer a new role under an existing one, or a new resource, to widening a
door that was decided.

To add a concept:

- **An action** — a function in \`src/actions.ts\` that asks \`permit\`, its
  resource's row in \`contract.json\`, its door in \`src/contract.test.ts\`,
  and a test in \`src/actions.test.ts\` for what the table cannot say.
- **A migration** — append to \`migrations\` in \`src/db.ts\`. Never edit one
  that has run. \`bun run src/db.ts --check\` shows the version.
- **A page** — a row in \`src/routes.ts\` and a function in \`src/page.ts\`.
  With a second page, move them under \`src/pages/\` and keep one \`layout\`.
- **An API route** — a row in \`src/routes.ts\` that calls the action and
  answers with \`answer(...)\`; the status follows the failure. Give it an
  \`api\` entry beside it (a sentence, the body and answer as JSON Schema)
  and run \`bun run contract:emit\`: \`contract/openapi.json\` is committed,
  served at \`/openapi.json\`, and \`bun test\` fails while it is stale. A
  resource's routes live under the \`api\` path its \`contract.json\` entry
  names, so the door and the forge's probe find them.
- **A tool** — an entry in \`tools\` in \`src/mcp.ts\`: a name, one sentence,
  a JSON schema, the action.
- **A terminal command** — a key in \`src/tty.ts\` that calls the action and
  reports on the status line.
- **Something live** — \`emit(type, data)\` in the action, and
  \`data-live="<types>"\` on the region of the page that shows it.
- **A colour, a space, a size** — a token in \`design/tokens.json\` (a
  colour needs its dark value in \`$extensions.mode.dark\`), used as
  \`var(--…)\`. \`bun run lint:design\` refuses a raw \`#hex\`, \`rgb(\` or
  \`hsl(\` anywhere in \`src/\` or \`static/\`, and a \`var(--…)\` that names no
  token; \`src/design.test.ts\` runs it, and holds every pair of colours a
  person reads to 4.5:1 in both themes.

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
  horizontal scroll, every control is at least 44px on a side
  (\`--size-tap\`), an input's text is never below 16px (a phone zooms into
  a smaller one), focus is always visible, whoever asked for less motion
  gets none, and the keyboard reaches everything a mouse does.
- Beauty is the tokens': light and dark both, from one file. A new page
  uses \`layout\`, which carries the tokens, the description and the Open
  Graph and card metadata a shared link unfurls with — pass the page's
  path so \`og:url\` is its own.
- Finish: the app boots, \`/healthz\` answers \`{ ok, version, uptime }\`
  (the forge polls it; keep it cheap and apart from the page), \`/\`
  answers, \`bun test\` is green, the README says how to use it and what is
  real versus simulated, \`forge.json\` says how to run it.
`;

// What the forge told the process, named once.
const ENV_TS = `/**
 * What the forge told this process, read once and named once. Every other
 * module takes these from here, so nothing else spells an environment
 * variable — and running the app by hand needs none of them.
 */

import pkg from "../package.json";

export const title: string = pkg.name;
/** The app's own version (package.json): what \`/healthz\` and \`/openapi.json\` say. */
export const version: string = pkg.version ?? "0.0.0";
/** When this process started, for \`/healthz\`'s uptime. */
export const startedAt: number = Date.now();
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
/** The forge that runs us. Its own well-known files (security.txt) speak for its apps. */
export const forgeUrl: string | undefined = process.env.FORGE_URL;
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

// Sign-in through the forge.
const SIGNIN_TS = `/**
 * Sign-in through the forge, which is an OpenID provider: the code flow
 * with PKCE against FORGE_URL. The first time it is needed the app
 * registers its own redirect address (production and each preview have
 * their own) and keeps the client id in FORGE_APP_DATA. A person is sent
 * to the forge, comes back with a one-time code, and the app trades it for
 * an id_token whose signature, issuer, audience, expiry and nonce it
 * checks itself against the forge's published keys. What it keeps is a
 * session: a random id in an HttpOnly cookie, the hash of it in the
 * database. Plain data in, plain data out; \`fetch\` is a parameter so a
 * test can be anywhere.
 */

import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Who } from "./who.ts";

export interface Signin {
  /** The forge's address, as the app was told it (FORGE_URL). */
  readonly forge: string;
  /** This app's own public origin (FORGE_APP_URL). */
  readonly origin: string;
  readonly dataDir: string;
  /** What the forge is told this client is called. */
  readonly name: string;
  readonly fetch?: typeof fetch;
}

export const SESSION_COOKIE = "session";
export const LOGIN_COOKIE = "signin";
const SESSION_S = 12 * 3600;
const LOGIN_S = 600;
const LOGIN_MAX = 1000;
const SCOPE = "openid profile";

const rand = (bytes: number): string => randomBytes(bytes).toString("base64url");
const hash = (s: string): string => createHash("sha256").update(s).digest("hex");
const fetcher = (s: Signin): typeof fetch => s.fetch ?? fetch;
const issuer = (s: Signin): string => new URL(s.forge).origin;
export const redirectUri = (s: Signin): string => \`\${s.origin}/signin/callback\`;

/** The cookie a request carries by that name, if any. */
export function cookieOf(request: Request, name: string): string | undefined {
  const found = new RegExp(\`(?:^|;\\\\s*)\${name}=([^;]*)\`).exec(
    request.headers.get("cookie") ?? "",
  );
  return found?.[1];
}

// The client id, per redirect address, in one small file. Registering again
// for an address already known would make a second client; this makes one.
const registered = new Map<string, Promise<string>>();

export function ensureClient(s: Signin): Promise<string> {
  const uri = redirectUri(s);
  const key = \`\${s.dataDir}\\0\${uri}\`;
  const pending = registered.get(key);
  if (pending !== undefined) return pending;
  const attempt = register(s, uri);
  registered.set(key, attempt);
  // A failed attempt is forgotten, so the next sign-in tries again.
  attempt.catch(() => registered.delete(key));
  return attempt;
}

async function register(s: Signin, uri: string): Promise<string> {
  const file = join(s.dataDir, "oidc-client.json");
  let known: Record<string, string> = {};
  try {
    known = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
  } catch {
    // First boot: nothing registered yet.
  }
  const had = known[uri];
  if (typeof had === "string" && had !== "") return had;
  const res = await fetcher(s)(\`\${issuer(s)}/oauth/register\`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: s.name, redirect_uris: [uri] }),
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  const body = (await res.json()) as { client_id?: unknown };
  if (res.status !== 201 || typeof body.client_id !== "string")
    throw new Error(\`the forge refused to register \${uri} (\${res.status})\`);
  mkdirSync(s.dataDir, { recursive: true });
  const next = \`\${file}.\${process.pid}\`;
  writeFileSync(next, JSON.stringify({ ...known, [uri]: body.client_id }));
  renameSync(next, file);
  return body.client_id;
}

/** Start: the address at the forge to send the person to, and the cookie that binds this browser to it. */
export async function begin(
  db: Database,
  s: Signin,
  now = Date.now(),
): Promise<{ location: string; state: string }> {
  const clientId = await ensureClient(s);
  const state = rand(24);
  const verifier = rand(48);
  const nonce = rand(24);
  db.query("DELETE FROM login WHERE expires_at <= ?1").run(now);
  db.query(
    "DELETE FROM login WHERE state IN (SELECT state FROM login ORDER BY expires_at LIMIT max(0, (SELECT count(*) FROM login) - ?1))",
  ).run(LOGIN_MAX - 1);
  db.query(
    "INSERT INTO login (state, verifier, nonce, expires_at) VALUES (?1, ?2, ?3, ?4)",
  ).run(hash(state), verifier, nonce, now + LOGIN_S * 1000);
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri(s),
    scope: SCOPE,
    state,
    nonce,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  return { location: \`\${issuer(s)}/oauth/authorize?\${query}\`, state };
}

export type Finished =
  | { ok: true; session: string; who: Who }
  | { ok: false; message: string };

const refuse = (message: string): Finished => ({ ok: false, message });

/** The return: check the state twice, trade the code, verify the id_token, open a session. */
export async function finish(
  db: Database,
  s: Signin,
  request: Request,
  url: URL,
  now = Date.now(),
): Promise<Finished> {
  if (url.searchParams.has("error"))
    return refuse("The forge did not sign you in.");
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  if (state === "" || code === "" || state !== cookieOf(request, LOGIN_COOKIE))
    return refuse(${JSON.stringify(SIGNIN_NOT_THIS_BROWSER)});
  const row = db
    .query<{ verifier: string; nonce: string; expires_at: number }, [string]>(
      "DELETE FROM login WHERE state = ?1 RETURNING verifier, nonce, expires_at",
    )
    .get(hash(state));
  if (row === null || row.expires_at <= now)
    return refuse(${JSON.stringify(SIGNIN_EXPIRED)});
  try {
    const res = await fetcher(s)(\`\${issuer(s)}/oauth/token\`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: await ensureClient(s),
        redirect_uri: redirectUri(s),
        code_verifier: row.verifier,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    const body = (await res.json()) as { id_token?: unknown };
    if (!res.ok || typeof body.id_token !== "string")
      return refuse("The forge did not accept the sign-in.");
    const claims = await verify(s, body.id_token, row.nonce, now);
    if (claims === undefined) return refuse("The forge's answer did not verify.");
    const who: Who = {
      role: "user",
      id: claims.sub,
      name: claims.preferred_username ?? claims.sub,
    };
    const session = rand(32);
    db.query(
      "INSERT INTO session (hash, user_id, user_name, expires_at) VALUES (?1, ?2, ?3, ?4)",
    ).run(hash(session), who.id, who.name, now + SESSION_S * 1000);
    db.query("DELETE FROM session WHERE expires_at <= ?1").run(now);
    return { ok: true, session, who };
  } catch {
    return refuse("The forge could not be reached.");
  }
}

interface Claims {
  readonly sub: string;
  readonly preferred_username?: string;
}

type Key = Record<string, unknown>;
const keys = new Map<string, { at: number; list: Key[] }>();

async function jwks(s: Signin, kid: unknown, now: number): Promise<Key | undefined> {
  const cached = keys.get(issuer(s));
  const fresh = cached !== undefined && now - cached.at < 600_000;
  const hit = fresh ? cached.list.find((k) => k["kid"] === kid) : undefined;
  if (hit !== undefined) return hit;
  // An unknown kid may be a rotation; look again, but not more than once a minute.
  if (cached !== undefined && now - cached.at < 60_000) return undefined;
  const res = await fetcher(s)(\`\${issuer(s)}/oauth/jwks\`, {
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  const list = ((await res.json()) as { keys?: Key[] }).keys ?? [];
  keys.set(issuer(s), { at: now, list });
  return list.find((k) => k["kid"] === kid);
}

/** The claims of an id_token that is the forge's, for this app, for this sign-in and not yet expired. */
export async function verify(
  s: Signin,
  jwt: string,
  nonce: string,
  now = Date.now(),
): Promise<Claims | undefined> {
  const parts = jwt.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const head = JSON.parse(Buffer.from(parts[0]!, "base64url").toString());
    if (head.alg !== "ES256") return undefined;
    const jwk = await jwks(s, head.kid, now);
    if (jwk === undefined) return undefined;
    const pub = await crypto.subtle.importKey(
      "jwk",
      jwk as JsonWebKey,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const good = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      pub,
      Buffer.from(parts[2]!, "base64url"),
      new TextEncoder().encode(\`\${parts[0]}.\${parts[1]}\`),
    );
    if (!good) return undefined;
    const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
    if (
      claims.iss !== issuer(s) ||
      claims.aud !== (await ensureClient(s)) ||
      claims.nonce !== nonce ||
      typeof claims.exp !== "number" ||
      claims.exp * 1000 <= now ||
      typeof claims.sub !== "string" ||
      claims.sub === ""
    )
      return undefined;
    return {
      sub: claims.sub,
      ...(typeof claims.preferred_username === "string" &&
      claims.preferred_username !== ""
        ? { preferred_username: claims.preferred_username }
        : {}),
    };
  } catch {
    return undefined;
  }
}

/** The person a session cookie names, or undefined. */
export function sessionWho(
  db: Database,
  request: Request,
  now = Date.now(),
): Who | undefined {
  const id = cookieOf(request, SESSION_COOKIE);
  if (id === undefined || id === "") return undefined;
  const row = db
    .query<{ user_id: string; user_name: string }, [string, number]>(
      "SELECT user_id, user_name FROM session WHERE hash = ?1 AND expires_at > ?2",
    )
    .get(hash(id), now);
  return row === null
    ? undefined
    : { role: "user", id: row.user_id, name: row.user_name };
}

export function endSession(db: Database, request: Request): void {
  const id = cookieOf(request, SESSION_COOKIE);
  if (id !== undefined) db.query("DELETE FROM session WHERE hash = ?1").run(hash(id));
}

export const SESSION_MAX_AGE = SESSION_S;
export const LOGIN_MAX_AGE = LOGIN_S;
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
  // Who tried to change what, and whether they were let. Appended by
  // src/audit.ts, never edited; read by admins at GET /api/audit.
  \`CREATE TABLE audit (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    who_id TEXT,
    who_name TEXT,
    role TEXT NOT NULL,
    resource TEXT NOT NULL,
    verb TEXT NOT NULL,
    target TEXT,
    allowed INTEGER NOT NULL CHECK (allowed IN (0, 1)),
    outcome TEXT NOT NULL
  )\`,
  // Sign-in through the forge (src/signin.ts): a login in flight, and a
  // session once it lands. Only hashes of the ids are kept.
  \`CREATE TABLE login (
    state TEXT PRIMARY KEY,
    verifier TEXT NOT NULL,
    nonce TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )\`,
  \`CREATE TABLE session (
    hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    user_name TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )\`,
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
// Who may do what, as data.
const CONTRACT_JSON = `{
  "roles": {
    "anon": { "above": [], "held": { "by": "everyone" } },
    "user": { "above": ["anon"], "held": { "by": "identity", "role": "user" } },
    "author": { "above": ["user"], "held": { "by": "row", "column": "author_id" } },
    "admin": { "above": ["author"], "held": { "by": "identity", "role": "admin" } }
  },
  "resources": {
    "note": {
      "api": "/api/notes",
      "can": {
        "create": "user",
        "read": "anon",
        "update": "author",
        "delete": "author",
        "list": "anon"
      }
    },
    "audit": {
      "api": "/api/audit",
      "can": {
        "create": "nobody",
        "read": "admin",
        "update": "nobody",
        "delete": "nobody",
        "list": "admin"
      }
    }
  }
}
`;

const CONTRACT_TS = `/**
 * Who may do what. \`contract.json\` is the table — the roles, and the least
 * role each verb on each resource needs — and \`src/can.ts\` is the forge's
 * evaluator, carried here verbatim. Actions ask \`permit\` and nothing else
 * in the app decides who may do what, so the table *is* the policy: it can
 * be read, compared and audited without running anything.
 *
 * A contract that does not read is not a warning. The app does not start.
 */

import { readFileSync } from "node:fs";
import {
  decide,
  readContract,
  type Actor,
  type Decision,
  type Verb,
} from "./can.ts";
import type { Who } from "./who.ts";

const read = readContract(
  readFileSync(new URL("../contract.json", import.meta.url), "utf8"),
);
if (!read.ok) throw new Error(\`contract.json: \${read.problems.join("; ")}\`);

export const contract = read.contract;

/** The forge's word for who is asking, as the evaluator takes it. */
export const actorOf = (who: Who): Actor =>
  who.role === "anon"
    ? { id: null, roles: [] }
    : { id: who.id, roles: [who.role] };

/** May \`who\` do \`verb\` to \`resource\` — to \`row\`, when there is one? */
export const permit = (
  who: Who,
  resource: string,
  verb: Verb,
  row?: Readonly<Record<string, unknown>>,
): Decision => decide(contract, resource, verb, actorOf(who), row);
`;

const ACTIONS_TS = `/**
 * Everything the app can do, as plain functions: \`(db, who, input)\` in,
 * data or a named failure out. The page, the JSON API, the MCP server and
 * the terminal are doors onto these and decide nothing themselves — so a
 * rule written here holds at every door, and a new door is only a new
 * way to call.
 */

import type { Database } from "bun:sqlite";
import { record, type AuditRow } from "./audit.ts";
import { permit } from "./contract.ts";
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

/** The refusal for a "no": who is not signed in is asked to; who is, is told. */
const refuse = <T>(who: Who, signIn: string, no: string): Result<T> =>
  who.role === "anon" ? fail("signin_required", signIn) : fail("forbidden", no);

/**
 * A change, written into the audit trail whichever way it went: the row it
 * made or touched, or the one it was refused. Every action that changes
 * something returns through here, so the trail holds at every door.
 */
const audited = <T extends { readonly id: number }>(
  db: Database,
  who: Who,
  resource: string,
  verb: "create" | "update" | "delete",
  target: number | undefined,
  result: Result<T>,
): Result<T> => {
  record(db, {
    who,
    resource,
    verb,
    target: result.ok ? result.value.id : target,
    outcome: result.ok ? "ok" : result.error,
  });
  return result;
};

export function listNotes(
  db: Database,
  who: Who,
  input: { limit?: number } = {},
): Result<Note[]> {
  const limit = Math.min(
    Math.max(Math.trunc(input.limit ?? 100) || 100, 1),
    500,
  );
  // "yes" is every note. When the table gives \`list\` to a role a row holds
  // (\`author\`), the answer names the columns instead, and the list is the
  // notes that name whoever asks. The names are the contract's, checked when
  // it was read; the value is bound.
  const may = permit(who, "note", "list");
  if (may === "no")
    return refuse(who, "Sign in to see notes.", "You may not see these notes.");
  if (may === "yes")
    return ok(
      db
        .query<Note, [number]>("SELECT * FROM note ORDER BY id DESC LIMIT ?1")
        .all(limit),
    );
  const mine = may.where.map((column) => \`\${column} = ?2\`).join(" OR ");
  return ok(
    db
      .query<
        Note,
        [number, string]
      >(\`SELECT * FROM note WHERE \${mine} ORDER BY id DESC LIMIT ?1\`)
      .all(limit, who.role === "anon" ? "" : who.id),
  );
}

export const addNote = (
  db: Database,
  who: Who,
  input: { body: string },
): Result<Note> =>
  audited(db, who, "note", "create", undefined, add(db, who, input));

function add(db: Database, who: Who, input: { body: string }): Result<Note> {
  // The table decides; the type only learns it here: whoever may create is
  // signed in, and carries a name to write beside the note.
  if (who.role === "anon" || permit(who, "note", "create") !== "yes")
    return refuse(who, "Sign in to add a note.", "You may not add a note.");
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

/**
 * One note, for \`who\` to do \`verb\` to. The door is asked before the row is
 * looked for, so whoever may not is told that and never learns whether the
 * row exists; whoever may, and asked for nothing, hears \`not_found\`.
 */
function noteFor(
  db: Database,
  who: Who,
  verb: "read" | "update" | "delete",
  id: number,
  said: { signIn: string; no: string },
): Result<Note> {
  const note = Number.isInteger(id)
    ? db.query<Note, [number]>("SELECT * FROM note WHERE id = ?1").get(id)
    : null;
  // With no row to show, the door is asked about a row of their own: whoever
  // could not pass even then is refused, and learns nothing about what
  // exists; whoever could is told there is no such note.
  const row: Readonly<Record<string, unknown>> =
    note === null ? { author_id: who.role === "anon" ? null : who.id } : { ...note };
  if (permit(who, "note", verb, row) !== "yes")
    return refuse(who, said.signIn, said.no);
  if (note !== null) return ok(note);
  if (!Number.isInteger(id))
    return fail("invalid", "A note id is a whole number.");
  return fail("not_found", "No such note.");
}

export function getNote(
  db: Database,
  who: Who,
  input: { id: number },
): Result<Note> {
  return noteFor(db, who, "read", input.id, {
    signIn: "Sign in to read this note.",
    no: "You may not read this note.",
  });
}

export const updateNote = (
  db: Database,
  who: Who,
  input: { id: number; body: string },
): Result<Note> =>
  audited(db, who, "note", "update", input.id, update(db, who, input));

function update(
  db: Database,
  who: Who,
  input: { id: number; body: string },
): Result<Note> {
  const found = noteFor(db, who, "update", input.id, {
    signIn: "Sign in to edit a note.",
    no: "Only the author or an admin can edit a note.",
  });
  if (!found.ok) return found;
  const body = input.body.trim();
  if (body.length === 0 || body.length > BODY_MAX)
    return fail("invalid", \`A note is 1 to \${BODY_MAX} characters.\`);
  const note = db
    .query<
      Note,
      [string, number]
    >("UPDATE note SET body = ?1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?2 RETURNING *")
    .get(body, found.value.id)!;
  emit("note.changed", note);
  return ok(note);
}

export const deleteNote = (
  db: Database,
  who: Who,
  input: { id: number },
): Result<{ id: number }> =>
  audited(db, who, "note", "delete", input.id, remove(db, who, input));

function remove(
  db: Database,
  who: Who,
  input: { id: number },
): Result<{ id: number }> {
  const found = noteFor(db, who, "delete", input.id, {
    signIn: "Sign in to remove a note.",
    no: "Only the author or an admin can remove a note.",
  });
  if (!found.ok) return found;
  db.query("DELETE FROM note WHERE id = ?1").run(found.value.id);
  emit("note.removed", { id: found.value.id });
  return ok({ id: found.value.id });
}

/** Whether \`who\` may remove \`note\`: the table's answer, for the page and the terminal to draw from. */
export const canDelete = (who: Who, note: Note): boolean =>
  permit(who, "note", "delete", { ...note }) === "yes";

/**
 * The audit trail, newest first, for whoever the table lets read it (an
 * admin, as the scaffold has it). \`before\` pages back by id. Audit rows name
 * no author, so a cell that gave \`list\` to a row's role would find nothing
 * of its own: anything but "yes" is a refusal here.
 */
export function listAudit(
  db: Database,
  who: Who,
  input: { limit?: number; before?: number } = {},
): Result<AuditRow[]> {
  if (permit(who, "audit", "list") !== "yes")
    return refuse(
      who,
      "Sign in to read the audit trail.",
      "Only an admin can read the audit trail.",
    );
  const limit = Math.min(
    Math.max(Math.trunc(input.limit ?? 100) || 100, 1),
    500,
  );
  const before = Number.isInteger(input.before)
    ? input.before!
    : Number.MAX_SAFE_INTEGER;
  return ok(
    db
      .query<
        AuditRow,
        [number, number]
      >("SELECT * FROM audit WHERE id < ?1 ORDER BY id DESC LIMIT ?2")
      .all(before, limit),
  );
}

export function getAudit(
  db: Database,
  who: Who,
  input: { id: number },
): Result<AuditRow> {
  const row = Number.isInteger(input.id)
    ? db
        .query<AuditRow, [number]>("SELECT * FROM audit WHERE id = ?1")
        .get(input.id)
    : null;
  if (permit(who, "audit", "read", { ...row }) !== "yes")
    return refuse(
      who,
      "Sign in to read the audit trail.",
      "Only an admin can read the audit trail.",
    );
  if (row !== null) return ok(row);
  if (!Number.isInteger(input.id))
    return fail("invalid", "An audit id is a whole number.");
  return fail("not_found", "No such audit row.");
}
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
 * read a request safely. Nothing in here knows what a note is; who may
 * come in at all is \`security.ts\`.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { env, publicOrigin } from "./env.ts";

// Scripts and styles come from this origin (inline styles allowed, inline
// scripts not), nothing frames us, browsers never guess a content type, and
// referrers stay on this site. Once served over https, always: browsers
// remember for a year, subdomains too (never preloaded: that is a promise
// the owner makes, not a template). Anything but production asks not to be
// indexed: a preview is a draft, and its address goes away with its pull.
export const SECURITY: Record<string, string> = {
  "content-security-policy":
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  ...(publicOrigin.startsWith("https:")
    ? { "strict-transport-security": "max-age=31536000; includeSubDomains" }
    : {}),
  ...(env === "production" ? {} : { "x-robots-tag": "noindex" }),
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

/**
 * A page that has not changed costs a header, not a body: the HTML is given
 * an ETag from its own bytes, and a request that already holds it is
 * answered 304 (specification.website/#caching). Only a plain 200 page is
 * tagged; one that sets a cookie is never answered from a stranger's copy.
 */
export async function revalidate(
  request: Request,
  response: Response,
): Promise<Response> {
  if (
    (request.method !== "GET" && request.method !== "HEAD") ||
    response.status !== 200 ||
    response.body === null ||
    response.headers.has("etag") ||
    response.headers.has("set-cookie") ||
    !(response.headers.get("content-type") ?? "").startsWith("text/html")
  )
    return response;
  const bytes = new Uint8Array(await response.arrayBuffer());
  const headers = new Headers(response.headers);
  const etag = \`W/"\${Bun.hash(bytes).toString(36)}"\`;
  headers.set("etag", etag);
  const held = request.headers.get("if-none-match") ?? "";
  if (held === "*" || held.split(",").some((t) => t.trim() === etag)) {
    headers.delete("content-length");
    return new Response(null, { status: 304, headers });
  }
  return new Response(bytes, { status: 200, headers });
}

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

/** Go to \`location\` (one the app built, never the client's), setting these cookies on the way. */
export function redirectTo(location: string, ...cookies: string[]): Response {
  const headers = new Headers({ location, ...SECURITY });
  for (const value of cookies) headers.append("set-cookie", value);
  return new Response(null, { status: 303, headers });
}

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
export const cookie = (name: string, value: string, maxAge: number): string =>
  \`\${name}=\${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=\${maxAge}\${publicOrigin.startsWith("https:") ? "; Secure" : ""}\`;

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
    body: new Uint8Array(body),
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
import {
  commit,
  description,
  env,
  publicOrigin,
  ssh,
  title,
  where,
} from "./env.ts";
import { asset, escape } from "./http.ts";
import { CARD, websiteLd } from "./site.ts";
import { token, tokensHref } from "./tokens.ts";
import type { Who } from "./who.ts";

/**
 * The frame every page shares: the tokens and the look, who you are, and
 * what a link to the page says when it is shared — a title, a sentence
 * and the address, for Open Graph and the card a chat app unfurls. A page
 * that is not a place to land (an error) says \`indexable = false\`: no
 * canonical address, no structured data, and a request to stay out of
 * search.
 */
export function layout(
  body: string,
  who: Who,
  path = "/",
  indexable = true,
  heading = title,
): string {
  const door =
    who.role === "anon"
      ? \`<a class="button button-quiet" href="/signin">Sign in</a>\`
      : \`<span class="you"><b>\${escape(who.name)}</b>\${who.role === "admin" ? " · admin" : ""}</span>
        <form class="signout" method="post" action="/signout"><button class="button button-quiet">Sign out</button></form>\`;
  return \`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="\${token("color-bg")}" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="\${token("color-bg", "dark")}" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<title>\${escape(title)}</title>
<meta name="description" content="\${escape(description)}">
\${
  indexable
    ? \`<link rel="canonical" href="\${escape(publicOrigin + path)}">\`
    : \`<meta name="robots" content="noindex">\`
}
<meta property="og:type" content="website">
<meta property="og:site_name" content="\${escape(title)}">
<meta property="og:title" content="\${escape(title)}">
<meta property="og:description" content="\${escape(description)}">
<meta property="og:url" content="\${escape(publicOrigin + path)}">
<meta property="og:image" content="\${escape(publicOrigin)}/og.png">
<meta property="og:image:width" content="\${CARD.width}">
<meta property="og:image:height" content="\${CARD.height}">
<meta property="og:image:alt" content="\${escape(title)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="\${escape(publicOrigin)}/og.png">
<meta name="twitter:title" content="\${escape(title)}">
<meta name="twitter:description" content="\${escape(description)}">
\${indexable ? \`<script type="application/ld+json">\${websiteLd(title, description, publicOrigin)}</script>\` : ""}
<link rel="stylesheet" href="\${tokensHref}">
<link rel="stylesheet" href="\${asset("app.css")}">
<script defer src="\${asset("beacon.js")}"></script>
<script type="module" src="\${asset("live.js")}"></script>
<body>
<a class="skip" href="#main">Skip to content</a>
<div class="page">
  <header class="head">
    <div>
      <h1>\${escape(heading)}</h1>
      <p class="muted">\${escape(description)}</p>
    </div>
    <nav class="row">
      <span class="pill" data-env="\${escape(env)}">\${escape(where)}</span>\${commit ? \`<span class="muted mono">\${escape(commit)}</span>\` : ""}
      \${door}
    </nav>
  </header>
  <main id="main" tabindex="-1">\${body}</main>
  <footer class="muted">
    \${ssh === undefined ? "" : \`<p>Terminal: <code>\${escape(ssh)}</code></p>\`}
    <p>Also at <a href="/api/notes">/api/notes</a> (<a href="/openapi.json">described</a>) and <code>POST /mcp</code>, with the same rules.</p>
    <p>Something wrong? <a href="/__forge/report">Report a problem</a>, no account needed.</p>
  </footer>
</div>
</body>
</html>
\`;
}

/** The page for a refusal or a failure: the same frame, a plain word, a way back. */
export function problem(status: 404 | 500, who: Who): string {
  const [heading, sentence] =
    status === 404
      ? ["Not found", "There is nothing at this address."]
      : ["Something went wrong", "It was not you. Try again in a moment."];
  return layout(
    \`<section class="card">
    <p>\${escape(sentence)}</p>
    <p><a href="/">Back to \${escape(title)}</a></p>
  </section>\`,
    who,
    "/",
    false,
    heading,
  );
}

export function home(input: {
  who: Who;
  notes: readonly Note[];
  notice?: string | undefined;
}): string {
  const { who, notes, notice } = input;
  const composer =
    who.role === "anon"
      ? \`<p class="muted">Reading as a guest. <a href="/signin">Sign in</a> to add a note.</p>\`
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
 *
 * A route that is part of the API says so beside itself (\`api\`): one
 * sentence, and the shape of what it takes and gives, as JSON Schema.
 * \`bun run contract:emit\` writes those into \`contract/openapi.json\`, the
 * tests fail when the committed file and this table disagree, and
 * \`GET /openapi.json\` serves it. The shapes describe; the checks that hold
 * are still the actions' own.
 */

import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import {
  addNote,
  BODY_MAX,
  deleteNote,
  getAudit,
  getNote,
  listAudit,
  listNotes,
  updateNote,
  type Failure,
  type Result,
} from "./actions.ts";
import { commit, env, forgeUrl, publicOrigin, startedAt, version } from "./env.ts";
import {
  back,
  cookie,
  fields,
  html,
  json,
  readForm,
  readJson,
  readNotice,
  redirectTo,
  SECURITY,
  staticFile,
  text,
} from "./http.ts";
import { events } from "./live.ts";
import { rpc } from "./mcp.ts";
import { home } from "./page.ts";
import { appleTouch, card, iconSvg, llmsTxt, manifest, securityTxt, sitemap } from "./site.ts";
import {
  begin,
  endSession,
  finish,
  LOGIN_COOKIE,
  LOGIN_MAX_AGE,
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  type Signin,
} from "./signin.ts";
import { tokensCss } from "./tokens.ts";
import type { Who } from "./who.ts";

export interface Context {
  readonly request: Request;
  readonly url: URL;
  readonly db: Database;
  readonly who: Who;
  readonly params: Record<string, string>;
  /** Sign-in through the forge; undefined when the app does not know where the forge is. */
  readonly signin?: Signin | undefined;
}

/** A JSON Schema, as plain data. */
export type Schema = Readonly<Record<string, unknown>>;

/** What an API route is, for the description: never consulted to decide anything. */
export interface Api {
  readonly summary: string;
  /** The body it reads. */
  readonly body?: Schema;
  /** What it answers when it succeeds, and with which status (200). */
  readonly answer: Schema;
  readonly status?: number;
  /** The query parameters it reads. */
  readonly query?: Readonly<Record<string, Schema>>;
}

export interface Route {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  readonly path: string;
  readonly handle: (ctx: Context) => Response | Promise<Response>;
  readonly api?: Api;
}

// The shapes the API speaks in, named once.
export const NOTE: Schema = {
  type: "object",
  properties: {
    id: { type: "integer" },
    body: { type: "string", minLength: 1, maxLength: BODY_MAX },
    author_id: { type: "string" },
    author_name: { type: "string" },
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
  },
  required: [
    "id",
    "body",
    "author_id",
    "author_name",
    "created_at",
    "updated_at",
  ],
};
const NOTE_BODY: Schema = {
  type: "object",
  properties: { body: { type: "string", minLength: 1, maxLength: BODY_MAX } },
  required: ["body"],
};
export const AUDIT_ROW: Schema = {
  type: "object",
  properties: {
    id: { type: "integer" },
    at: { type: "string", format: "date-time" },
    who_id: { type: ["string", "null"] },
    who_name: { type: ["string", "null"] },
    role: { enum: ["anon", "user", "admin"] },
    resource: { type: "string" },
    verb: { type: "string" },
    target: { type: ["string", "null"] },
    allowed: { enum: [0, 1] },
    outcome: { type: "string" },
  },
  required: ["id", "at", "role", "resource", "verb", "allowed", "outcome"],
};
export const ERROR: Schema = {
  type: "object",
  properties: { error: { type: "string" }, message: { type: "string" } },
  required: ["error"],
};
const LIMIT: Schema = {
  type: "integer",
  minimum: 1,
  maximum: 500,
  default: 100,
};
const list = (items: Schema): Schema => ({ type: "array", items });

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

const DAY = 86400;

/** A generated file, with the floor and how long it may be kept. */
const file = (
  body: string | Uint8Array,
  type: string,
  maxAge = 0,
): Response =>
  new Response(body as BodyInit, {
    headers: {
      "content-type": type,
      "cache-control": maxAge > 0 ? \`public, max-age=\${maxAge}\` : "no-cache",
      ...SECURITY,
    },
  });

/** A whole number from the query, or undefined. */
const whole = (value: string | null): number | undefined =>
  value !== null && /^\\d+$/.test(value) ? Number(value) : undefined;

// The API's description, read from git once: what the tests hold equal to this table.
const OPENAPI = new URL("../contract/openapi.json", import.meta.url);
const openapi = existsSync(OPENAPI) ? readFileSync(OPENAPI, "utf8") : undefined;

export const routes: readonly Route[] = [
  // Sign in through the forge (OpenID Connect, code flow with PKCE): out to
  // the forge, back with a code, a session in an HttpOnly cookie.
  {
    method: "GET",
    path: "/signin",
    handle: async (c) => {
      if (c.signin === undefined)
        return text("sign-in is off: FORGE_URL is not set", 503);
      try {
        const { location, state } = await begin(c.db, c.signin);
        return redirectTo(location, cookie(LOGIN_COOKIE, state, LOGIN_MAX_AGE));
      } catch (error) {
        console.error(error);
        return text("the forge could not be reached to sign you in", 502);
      }
    },
  },
  {
    method: "GET",
    path: "/signin/callback",
    handle: async (c) => {
      if (c.signin === undefined) return text("sign-in is off", 503);
      const done = await finish(c.db, c.signin, c.request, c.url);
      if (!done.ok)
        return redirectTo(
          "/",
          cookie(LOGIN_COOKIE, "", 0),
          cookie("notice", encodeURIComponent(done.message), 30),
        );
      return redirectTo(
        "/",
        cookie(LOGIN_COOKIE, "", 0),
        cookie(SESSION_COOKIE, done.session, SESSION_MAX_AGE),
      );
    },
  },
  {
    method: "POST",
    path: "/signout",
    handle: (c) => {
      endSession(c.db, c.request);
      return redirectTo(
        env === "local" ? "/" : "/__forge/signout?to=/",
        cookie(SESSION_COOKIE, "", 0),
      );
    },
  },

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
    api: {
      summary: "The notes, newest first.",
      query: { limit: LIMIT },
      answer: list(NOTE),
    },
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
    api: {
      summary: "Add a note as the person asking.",
      body: NOTE_BODY,
      answer: NOTE,
      status: 201,
    },
  },
  {
    method: "GET",
    path: "/api/notes/:id",
    handle: (c) => answer(getNote(c.db, c.who, { id: Number(c.params.id) })),
    api: { summary: "One note.", answer: NOTE },
  },
  {
    method: "PATCH",
    path: "/api/notes/:id",
    handle: async (c) => {
      const body = await readJson(c.request);
      if (body === undefined) return json({ error: "too_large" }, 413);
      return answer(
        updateNote(c.db, c.who, {
          id: Number(c.params.id),
          body: String(fields(body).body ?? ""),
        }),
      );
    },
    api: { summary: "Change a note's words.", body: NOTE_BODY, answer: NOTE },
  },
  {
    method: "DELETE",
    path: "/api/notes/:id",
    handle: (c) => answer(deleteNote(c.db, c.who, { id: Number(c.params.id) })),
    api: {
      summary: "Remove a note.",
      answer: {
        type: "object",
        properties: { id: { type: "integer" } },
        required: ["id"],
      },
    },
  },

  // Who tried to change what: the audit trail, for whoever the table lets read it.
  {
    method: "GET",
    path: "/api/audit",
    handle: (c) =>
      answer(
        listAudit(c.db, c.who, {
          limit: whole(c.url.searchParams.get("limit")) ?? 100,
          ...(whole(c.url.searchParams.get("before")) === undefined
            ? {}
            : { before: whole(c.url.searchParams.get("before"))! }),
        }),
      ),
    api: {
      summary: "The audit trail, newest first; \`before\` pages back by id.",
      query: { limit: LIMIT, before: { type: "integer" } },
      answer: list(AUDIT_ROW),
    },
  },
  {
    method: "GET",
    path: "/api/audit/:id",
    handle: (c) => answer(getAudit(c.db, c.who, { id: Number(c.params.id) })),
    api: { summary: "One row of the audit trail.", answer: AUDIT_ROW },
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
    api: {
      summary:
        "One JSON-RPC 2.0 message to the MCP server; its tools are the actions.",
      body: {
        type: "object",
        properties: {
          jsonrpc: { const: "2.0" },
          id: {},
          method: { type: "string" },
          params: { type: "object" },
        },
        required: ["jsonrpc", "method"],
      },
      answer: { type: "object" },
    },
  },
  {
    method: "GET",
    path: "/mcp",
    handle: () => text("this endpoint speaks JSON-RPC over POST", 405),
  },

  // Up or not, for the forge and for anyone watching: a separate path from
  // the page, so a health check never renders it.
  {
    method: "GET",
    path: "/healthz",
    handle: (c) => {
      let ok = true;
      try {
        c.db.query("SELECT 1").get();
      } catch {
        ok = false;
      }
      const uptime = Math.floor((Date.now() - startedAt) / 1000);
      return new Response(
        JSON.stringify({ ok, version, commit, env, uptime }),
        {
          status: ok ? 200 : 503,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            ...SECURITY,
          },
        },
      );
    },
    api: {
      summary:
        "Whether the app is up: its version, commit, environment and seconds since it started.",
      answer: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          version: { type: "string" },
          commit: { type: "string" },
          env: { type: "string" },
          uptime: { type: "integer" },
        },
        required: ["ok", "version", "uptime"],
      },
    },
  },
  {
    method: "GET",
    path: "/openapi.json",
    handle: () =>
      openapi === undefined
        ? text("not found", 404)
        : new Response(openapi, {
            headers: {
              "content-type": "application/json; charset=utf-8",
              "cache-control": "no-cache",
              ...SECURITY,
            },
          }),
  },

  // The look: design/tokens.json, compiled at boot, cached for a year when linked by content.
  {
    method: "GET",
    path: "/tokens.css",
    handle: (c) =>
      new Response(tokensCss, {
        headers: {
          "content-type": "text/css; charset=utf-8",
          "cache-control": c.url.searchParams.has("v")
            ? "public, max-age=31536000, immutable"
            : "no-cache",
          ...SECURITY,
        },
      }),
  },

  // What the web expects of a site (specification.website). Crawlers read
  // the page, not the API; a preview is a draft and is read by nobody.
  // Where to report a vulnerability is the forge's to say: it runs this app.
  {
    method: "GET",
    path: "/robots.txt",
    handle: () =>
      text(
        env === "production"
          ? \`User-agent: *\\nDisallow: /api/\\nDisallow: /mcp\\nDisallow: /events\\nDisallow: /__forge/\\n\\nSitemap: \${publicOrigin}/sitemap.xml\\n\`
          : \`User-agent: *\\nDisallow: /\\n\\nSitemap: \${publicOrigin}/sitemap.xml\\n\`,
      ),
  },
  {
    method: "GET",
    path: "/sitemap.xml",
    handle: () => file(sitemap(), "application/xml; charset=utf-8"),
  },
  {
    method: "GET",
    path: "/llms.txt",
    handle: () => file(llmsTxt(), "text/plain; charset=utf-8"),
  },
  // The app's face outside the page: the tab's icon, the home-screen icon
  // and install manifest, and the card a shared link unfurls. Drawn from
  // the tokens and the app's name, so they change when those do.
  {
    method: "GET",
    path: "/icon.svg",
    handle: () => file(iconSvg(), "image/svg+xml", DAY),
  },
  {
    method: "GET",
    path: "/apple-touch-icon.png",
    handle: () => file(appleTouch(), "image/png", DAY),
  },
  {
    method: "GET",
    path: "/og.png",
    handle: () => file(card(), "image/png", DAY),
  },
  {
    method: "GET",
    path: "/manifest.webmanifest",
    handle: () => file(manifest(), "application/manifest+json", DAY),
  },
  // There is no password here: accounts are the forge's, so that is where
  // a person goes to change one (specification.website/#change-password).
  {
    method: "GET",
    path: "/.well-known/change-password",
    handle: () =>
      new Response(null, {
        status: 302,
        headers: { location: forgeUrl ?? "/", ...SECURITY },
      }),
  },
  {
    method: "GET",
    path: "/.well-known/security.txt",
    handle: () => text(securityTxt()),
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
        // A malformed escape is no match, never a thrown error.
        try {
          params[p.slice(1)] = decodeURIComponent(parts[i] ?? "");
          return true;
        } catch {
          return false;
        }
      }
      return p === parts[i];
    });
    if (hit) return { route, params };
  }
  return undefined;
}
`;

// What the web expects beyond the pages.
const SITE_TS = `/**
 * What the web expects of a site beyond its pages, each drawn from the
 * app's name and its tokens so nothing here is edited by hand: the icon,
 * the home-screen icon and install manifest, the card a shared link
 * unfurls, the sitemap, \`/llms.txt\` for agents that read, and the
 * structured data a search engine reads from the page. Plain data in,
 * a string or bytes out; \`routes.ts\` serves them.
 *
 * The cards are PNGs written here with \`node:zlib\`, since a link
 * unfurler will not draw an SVG and a dependency to draw text is more
 * than a starting point needs. They carry the app's colours and a mark,
 * not its name; put a designed \`og.png\` in \`static/\` and point
 * \`og:image\` at it when there is one.
 */

import { deflateSync } from "node:zlib";
import { description, forgeUrl, publicOrigin, title } from "./env.ts";
import { token } from "./tokens.ts";

/** The size a link card is drawn at, and what \`og:image:width\`/\`height\` say. */
export const CARD = { width: 1200, height: 630 } as const;

type Channels = readonly [number, number, number];

/** \`#rrggbb\` (the tokens' only colour form) as three bytes. */
function channels(hex: string): Channels {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (m === null) throw new Error(\`\${hex}: the site files need a #rrggbb token\`);
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The mark: the app's first letter, in the accent. */
const letter = (): string => [...title][0]?.toUpperCase() ?? "A";

export const iconSvg = (): string =>
  \`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="\${token("color-accent")}"/><text x="32" y="45" text-anchor="middle" font-family="system-ui, sans-serif" font-size="38" font-weight="700" fill="\${token("color-accent-fg")}">\${xml(letter())}</text></svg>\\n\`;

export const manifest = (): string =>
  JSON.stringify({
    name: title,
    short_name: title.slice(0, 12),
    description,
    start_url: "/",
    display: "standalone",
    background_color: token("color-bg"),
    theme_color: token("color-bg"),
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
  });

export const sitemap = (): string =>
  \`<?xml version="1.0" encoding="UTF-8"?>\\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\\n  <url><loc>\${xml(publicOrigin)}/</loc></url>\\n</urlset>\\n\`;

/**
 * Where to report a vulnerability: the forge that runs the app, or this
 * site when there is none. Expires a year out, so it is never stale.
 */
export const securityTxt = (): string =>
  \`Contact: \${forgeUrl ?? publicOrigin}/\\nExpires: \${new Date(Date.now() + 365 * 864e5).toISOString()}\\nPreferred-Languages: en\\nCanonical: \${publicOrigin}/.well-known/security.txt\\n\`;

/** \`/llms.txt\`: what the site is and where its machine-readable parts are, in the format llmstxt.org describes. */
export const llmsTxt = (): string =>
  \`# \${oneLine(title)}\\n\\n> \${oneLine(description)}\\n\\n## Pages\\n\\n- [Home](\${publicOrigin}/): the notes, and who may add them\\n\\n## For programs\\n\\n- [API description](\${publicOrigin}/openapi.json): every endpoint, as OpenAPI\\n- [MCP endpoint](\${publicOrigin}/mcp): the same actions as tools, POST JSON-RPC\\n- [Health](\${publicOrigin}/healthz): whether the app is up\\n\`;

/** The page as a \`WebSite\`, for a \`<script type="application/ld+json">\`. A \`<\` cannot close the tag: it is written \\\\u003c. */
export const websiteLd = (name: string, about: string, origin: string): string =>
  JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebSite",
    name,
    description: about,
    url: \`\${origin}/\`,
  }).replace(/</g, "\\\\u003c");

/** The 180px icon iOS puts on a home screen. */
export const appleTouch = (): Uint8Array => cached("apple", () => draw(180, 180, "icon"));

/** The card a shared link unfurls. */
export const card = (): Uint8Array => cached("card", () => draw(CARD.width, CARD.height, "card"));

const made = new Map<string, Uint8Array>();
function cached(key: string, make: () => Uint8Array): Uint8Array {
  let bytes = made.get(key);
  if (bytes === undefined) made.set(key, (bytes = make()));
  return bytes;
}

const xml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => \`&#\${c.charCodeAt(0)};\`);
const oneLine = (s: string): string => s.replace(/\\s+/g, " ").trim();

/** A flat PNG: the accent, with the accent's foreground as a mark at the middle (a square frame with a block inside). */
function draw(w: number, h: number, kind: "icon" | "card"): Uint8Array {
  const bg = channels(token("color-accent"));
  const fg = channels(token("color-accent-fg"));
  const side = Math.round(Math.min(w, h) * (kind === "icon" ? 0.5 : 0.4));
  const x0 = Math.round((w - side) / 2);
  const y0 = Math.round((h - side) / 2);
  const edge = Math.max(2, Math.round(side / 10));
  const row = 1 + w * 3;
  const raw = new Uint8Array(row * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside = x >= x0 && x < x0 + side && y >= y0 && y < y0 + side;
      const ring =
        inside &&
        (x < x0 + edge || x >= x0 + side - edge || y < y0 + edge || y >= y0 + side - edge);
      const block =
        inside && x >= x0 + 3 * edge && x < x0 + side - 3 * edge && y >= y0 + 3 * edge && y < y0 + side - 3 * edge;
      const c = ring || block ? fg : bg;
      raw.set(c, y * row + 1 + x * 3);
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, w);
  view.setUint32(4, h);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit, truecolour, no interlace
  return join([
    Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

const TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = TABLE[(c ^ b) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const body = join([new TextEncoder().encode(type), data]);
  const out = new Uint8Array(8 + data.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(8 + data.length, crc(body));
  return out;
}
function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
`;

// Smaller on the wire.
const COMPRESS_TS = `/**
 * Compression, in the app, so a deploy that no proxy sits in front of is
 * still small on the wire. A response is gzipped when the person's browser
 * said it reads gzip, the body is text (HTML, CSS, JS, JSON, XML, SVG)
 * and is worth the trouble (1 KiB or more). The event stream is never
 * touched — it must reach the browser as it is written — and neither is
 * anything already encoded. A proxy that compresses for itself sees
 * \`content-encoding\` and leaves the body alone.
 */

/** The least body worth compressing; below it the headers outweigh the gain. */
export const MIN_BYTES = 1024;

const TEXTUAL = /^(text\\/(?!event-stream)|application\\/([\\w.+-]*json|xml|javascript)|image\\/svg\\+xml)/i;

export async function compress(
  request: Request,
  response: Response,
): Promise<Response> {
  const type = response.headers.get("content-type") ?? "";
  if (
    request.method !== "GET" ||
    response.body === null ||
    response.headers.has("content-encoding") ||
    !/\\bgzip\\b/i.test(request.headers.get("accept-encoding") ?? "") ||
    !TEXTUAL.test(type)
  )
    return response;
  const headers = new Headers(response.headers);
  headers.append("vary", "accept-encoding");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length < MIN_BYTES || response.status === 206)
    return new Response(bytes, { status: response.status, headers });
  headers.set("content-encoding", "gzip");
  headers.delete("content-length");
  return new Response(Bun.gzipSync(bytes), { status: response.status, headers });
}
`;

// The specification, held.
const SITE_TEST = `/**
 * The specification a site is held to, as the template keeps it: the head
 * a crawler and a chat app read, the files they ask for, the pages that
 * are not the page, and the shape of the headings. A generated app
 * inherits every one of these and fails its own \`bun test\` if it loses one.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compress, MIN_BYTES } from "./compress.ts";
import { env, publicOrigin, title } from "./env.ts";
import { SECURITY } from "./http.ts";
import { problem } from "./page.ts";
import { CARD, websiteLd } from "./site.ts";
import { serve } from "./server.ts";
import { ANON } from "./who.ts";

const dataDir = mkdtempSync(join(tmpdir(), "app-"));
const server = serve({
  port: 0,
  dataDir,
  identityKey: "a-key-only-the-forge-holds",
});
const base = \`http://\${server.hostname}:\${server.port}\`;
afterAll(() => {
  server.stop(true);
  rmSync(dataDir, { recursive: true, force: true });
});
const get = (path: string, headers: Record<string, string> = {}) =>
  fetch(base + path, { headers, redirect: "manual" });

/** The heading levels in a page, in order. */
const levels = (page: string): number[] =>
  [...page.matchAll(/<h([1-6])[\\s>]/g)].map((m) => Number(m[1]));

/** One h1, and no level skipped on the way down: what a screen reader's outline needs. */
const outlineProblems = (page: string): string[] => {
  const all = levels(page);
  const problems: string[] = [];
  if (all.filter((n) => n === 1).length !== 1)
    problems.push("a page has exactly one h1");
  all.forEach((n, i) => {
    if (n > (all[i - 1] ?? 0) + 1) problems.push(\`h\${n} follows h\${all[i - 1] ?? 0}\`);
  });
  return problems;
};

test("the head says where the page lives, what it looks like and what it is", async () => {
  const page = await (await get("/")).text();
  expect(page).toContain(\`<link rel="canonical" href="\${publicOrigin}/">\`);
  expect(page).toContain('<link rel="icon" href="/icon.svg" type="image/svg+xml">');
  expect(page).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png">');
  expect(page).toContain('<link rel="manifest" href="/manifest.webmanifest">');
  expect(page).not.toContain('href="data:,"');
  expect(page).toContain(\`<meta property="og:image" content="\${publicOrigin}/og.png">\`);
  expect(page).toContain(\`<meta property="og:image:width" content="\${CARD.width}">\`);
  expect(page).toContain('<meta name="twitter:card" content="summary_large_image">');
  const ld = /<script type="application\\/ld\\+json">(.*?)<\\/script>/s.exec(page)?.[1];
  expect(JSON.parse(ld ?? "null")).toMatchObject({
    "@type": "WebSite",
    name: title,
    url: \`\${publicOrigin}/\`,
  });
});

test("structured data cannot close its own tag", () => {
  const out = websiteLd("</script><b>", "a & b", "https://x.test");
  expect(out).not.toContain("<");
  expect(JSON.parse(out).name).toBe("</script><b>");
});

test("the first stop for a keyboard skips to the main landmark", async () => {
  const page = await (await get("/")).text();
  expect(page.indexOf('<a class="skip" href="#main">')).toBeLessThan(page.indexOf("<header"));
  expect(page).toContain('<main id="main" tabindex="-1">');
  const css = readFileSync(join(import.meta.dir, "..", "static", "app.css"), "utf8");
  expect(css).toContain("@media (forced-colors: active)");
});

test("the icon, the home-screen icon, the manifest and the card are real files", async () => {
  const svg = await get("/icon.svg");
  expect(svg.headers.get("content-type")).toBe("image/svg+xml");
  expect(await svg.text()).toStartWith("<svg ");
  const size = async (path: string) => {
    const r = await get(path);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    const b = new Uint8Array(await r.arrayBuffer());
    expect([...b.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const view = new DataView(b.buffer);
    return [view.getUint32(16), view.getUint32(20)];
  };
  expect(await size("/apple-touch-icon.png")).toEqual([180, 180]);
  expect(await size("/og.png")).toEqual([CARD.width, CARD.height]);
  const m = await (await get("/manifest.webmanifest")).json();
  expect(m).toMatchObject({ name: title, start_url: "/" });
  expect(m.icons.map((i: { src: string }) => i.src)).toContain("/apple-touch-icon.png");
});

test("sitemap.xml lists the page, robots.txt points at it where crawlers are welcome, llms.txt introduces the site", async () => {
  const sitemap = await (await get("/sitemap.xml")).text();
  expect(sitemap).toContain(\`<loc>\${publicOrigin}/</loc>\`);
  expect((await get("/sitemap.xml")).headers.get("content-type")).toContain("xml");
  const robots = await (await get("/robots.txt")).text();
  if (env === "production") expect(robots).toContain(\`Sitemap: \${publicOrigin}/sitemap.xml\\n\`);
  else expect(robots).toBe(\`User-agent: *\\nDisallow: /\\n\\nSitemap: \${publicOrigin}/sitemap.xml\\n\`);
  const llms = await get("/llms.txt");
  expect(llms.headers.get("content-type")).toContain("text/plain");
  const body = await llms.text();
  expect(body).toStartWith(\`# \${title}\\n\\n> \`);
  expect(body).toContain(\`(\${publicOrigin}/openapi.json)\`);
});

test("HSTS covers subdomains and is never a preload promise", () => {
  const hsts = SECURITY["strict-transport-security"];
  if (publicOrigin.startsWith("https:")) {
    expect(hsts).toContain("includeSubDomains");
    expect(hsts).not.toContain("preload");
  } else expect(hsts).toBeUndefined();
});

test("a missing page is the app's own page with a 404, and a script gets the word", async () => {
  const browser = await get("/no/such/page", { accept: "text/html,*/*" });
  expect(browser.status).toBe(404);
  expect(browser.headers.get("content-type")).toContain("text/html");
  expect(browser.headers.get("content-security-policy")).not.toBeNull();
  const page = await browser.text();
  expect(page).toContain("<h1>Not found</h1>");
  expect(page).toContain('<meta name="robots" content="noindex">');
  expect(page).not.toContain('rel="canonical"');
  expect(outlineProblems(page)).toEqual([]);
  const script = await get("/no/such/page", { accept: "application/json" });
  expect(script.status).toBe(404);
  expect(await script.text()).toBe("not found");
});

test("a failure is the same frame with nothing of the cause in it", () => {
  const page = problem(500, ANON);
  expect(page).toContain("<h1>Something went wrong</h1>");
  expect(page).toContain('<meta name="robots" content="noindex">');
  expect(outlineProblems(page)).toEqual([]);
});

test("the home page has one h1 and no skipped level", async () => {
  expect(outlineProblems(await (await get("/")).text())).toEqual([]);
  expect(outlineProblems("<h1>a</h1><h3>b</h3>")).toEqual(["h3 follows h1"]);
  expect(outlineProblems("<h2>a</h2>")).toContain("a page has exactly one h1");
});

test("text over a kilobyte is gzipped for a browser that reads gzip, and nothing else is touched", async () => {
  const big = "x".repeat(MIN_BYTES * 2);
  const ask = (encoding?: string) =>
    new Request("http://x.test/", encoding ? { headers: { "accept-encoding": encoding } } : {});
  const html = () => new Response(big, { headers: { "content-type": "text/html" } });
  const squeezed = await compress(ask("gzip, br"), html());
  expect(squeezed.headers.get("content-encoding")).toBe("gzip");
  expect(squeezed.headers.get("vary")).toContain("accept-encoding");
  expect(Bun.gunzipSync(new Uint8Array(await squeezed.arrayBuffer()))).toEqual(new TextEncoder().encode(big));
  // Not asked for, too small, a stream, or an image: as they were.
  expect((await compress(ask(), html())).headers.get("content-encoding")).toBeNull();
  const small = new Response("tiny", { headers: { "content-type": "text/html" } });
  expect(await (await compress(ask("gzip"), small)).text()).toBe("tiny");
  const stream = new Response(big, { headers: { "content-type": "text/event-stream" } });
  expect((await compress(ask("gzip"), stream)).headers.get("content-encoding")).toBeNull();
  const png = new Response(big, { headers: { "content-type": "image/png" } });
  expect((await compress(ask("gzip"), png)).headers.get("content-encoding")).toBeNull();
});

// decompress: false keeps fetch from decoding the body behind the test's back.
const raw = (path: string, headers: Record<string, string>) =>
  fetch(base + path, { headers, redirect: "manual", decompress: false } as RequestInit);

test("the server gzips a large asset for a browser that reads gzip, and not for one that does not", async () => {
  const zipped = await raw("/static/app.css", { "accept-encoding": "gzip" });
  expect(zipped.headers.get("content-encoding")).toBe("gzip");
  expect(zipped.headers.get("vary")).toContain("accept-encoding");
  const bytes = new Uint8Array(await zipped.arrayBuffer());
  expect(new TextDecoder().decode(Bun.gunzipSync(bytes))).toContain(".button");
  const plain = await raw("/static/app.css", { "accept-encoding": "identity" });
  expect(plain.headers.get("content-encoding")).toBeNull();
  expect(await plain.text()).toContain(".button");
});

test("the event stream is never compressed", async () => {
  const r = await raw("/events", { "accept-encoding": "gzip" });
  expect(r.headers.get("content-type")).toContain("text/event-stream");
  expect(r.headers.get("content-encoding")).toBeNull();
  await r.body?.cancel();
});
`;

// Boot.
const SERVER_TS = `/**
 * The process the forge runs. \`serve\` opens the database and listens:
 * every request gets the floor (\`http.ts\`), an identity (\`who.ts\`), the
 * door (\`security.ts\`) and one route (\`routes.ts\`) — so a request from
 * another site, from someone going too fast, or from someone the contract
 * turns away is refused before a byte of it is read. Run directly, it
 * serves what the forge said; a test calls \`serve\` with its own.
 */

import { openDb } from "./db.ts";
import {
  dataDir,
  forgeUrl,
  identityKey,
  publicOrigin,
  title,
  where,
} from "./env.ts";
import { compress } from "./compress.ts";
import { html, revalidate, text } from "./http.ts";
import { problem } from "./page.ts";
import { match } from "./routes.ts";
import { door } from "./security.ts";
import { ensureClient, sessionWho, type Signin } from "./signin.ts";
import { ANON, who } from "./who.ts";

export interface ServeOptions {
  readonly port: number;
  readonly hostname?: string | undefined;
  readonly dataDir: string;
  readonly identityKey: string;
  /** Where people sign in; undefined turns sign-in off. */
  readonly signin?: Signin | undefined;
}

export function serve(options: ServeOptions) {
  const db = openDb(options.dataDir);
  // Register with the forge on first boot; a forge that is not up yet is
  // tried again at the first sign-in.
  options.signin !== undefined &&
    ensureClient(options.signin).catch((error) => console.error(error));
  return Bun.serve({
    port: options.port,
    hostname: options.hostname ?? "127.0.0.1",
    // A connection that says nothing for a minute is dropped. The event
    // stream heartbeats every 25 seconds to stay well inside that.
    idleTimeout: 60,
    async fetch(request, server) {
      const url = new URL(request.url);
      // A signed header from the forge says more than a session can (a
      // session is always a user; the header may say admin), so it wins.
      const signed = who(request, options.identityKey);
      const me =
        signed.role !== "anon" ? signed : (sessionWho(db, request) ?? signed);
      const refused = door(
        db,
        request,
        url,
        me,
        server.requestIP(request)?.address ?? "?",
      );
      if (refused !== undefined)
        return head(request, await compress(request, refused));
      const found = match(
        request.method === "HEAD" ? "GET" : request.method,
        url.pathname,
      );
      // A browser is shown the app's own page; a script gets the word.
      if (found === undefined)
        return head(
          request,
          await compress(
            request,
            (request.headers.get("accept") ?? "").includes("text/html")
              ? html(problem(404, me), 404)
              : text("not found", 404),
          ),
        );
      const response = await found.route.handle({
        request,
        url,
        db,
        who: me,
        params: found.params,
        signin: options.signin,
      });
      return head(request, await compress(request, await revalidate(request, response)));
    },
    // A bug answers with the floor and nothing else: never the runtime's
    // own error page, which carries source and paths, and never without
    // the headers. The detail goes to the log, where it belongs.
    error(error) {
      // Inside the generated app, which has no forge log module.
      console.error(error);
      try {
        return html(problem(500, ANON), 500);
      } catch {
        return html("<h1>Something went wrong</h1>", 500);
      }
    },
  });
}

// HEAD is GET without the body: a health check sees the app up.
const head = (request: Request, response: Response): Response =>
  request.method === "HEAD"
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;

if (import.meta.main) {
  const server = serve({
    port: Number(process.env.PORT ?? 8080),
    hostname: process.env.HOST,
    dataDir,
    identityKey,
    signin:
      forgeUrl === undefined
        ? undefined
        : { forge: forgeUrl, origin: publicOrigin, dataDir, name: \`\${title} (\${where})\` },
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
const APP_CSS = `/* The look, in the tokens' words. Every value that is a choice — a colour, a
   space, a radius, a size — is a var(--…) from /tokens.css, which
   design/tokens.json compiles to at boot; \`bun run lint:design\` refuses a raw
   colour here. Light and dark are the tokens' business, not this file's. */

/* The page. */
html {
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
}
body {
  margin: 0;
  background: var(--color-bg);
  color: var(--color-fg);
  font: var(--text-base) / var(--leading-body) var(--font-sans);
}
.page {
  max-width: 40rem;
  margin: 0 auto;
  padding: var(--space-5) var(--space-4) var(--space-6);
}
.head {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--space-3) var(--space-4);
  margin-bottom: var(--space-5);
}
h1 {
  margin: 0;
  font-size: var(--text-xl);
  font-weight: 650;
  letter-spacing: -0.01em;
  line-height: var(--leading-tight);
}
p {
  margin: 0;
}
a {
  color: var(--color-accent);
  text-decoration-thickness: 1px;
  text-underline-offset: 0.15em;
}
code,
.mono {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
}
:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}
.muted {
  color: var(--color-muted);
}
/* The first thing a keyboard reaches: a way past the header, seen only when focused. */
.skip {
  position: absolute;
  left: var(--space-3);
  top: var(--space-3);
  transform: translateY(-300%);
  padding: var(--space-2) var(--space-3);
  background: var(--color-accent);
  color: var(--color-accent-fg);
  border-radius: var(--radius-md);
}
.skip:focus {
  transform: none;
}
main:focus {
  outline: none;
}
.you {
  color: var(--color-muted);
  white-space: nowrap;
}
.signout {
  display: inline;
}

/* Blocks. */
.card {
  background: var(--color-surface);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  padding: var(--space-4);
  margin-bottom: var(--space-5);
}
.row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
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
  gap: var(--space-3);
  padding: var(--space-3) 0;
  border-top: 1px solid var(--color-line);
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
  padding: var(--space-6) var(--space-4);
  text-align: center;
  color: var(--color-muted);
  border: 1px dashed var(--color-line);
  border-radius: var(--radius-md);
}
footer {
  margin-top: var(--space-6);
  font-size: var(--text-sm);
  display: grid;
  gap: var(--space-1);
}
footer code {
  overflow-wrap: anywhere;
}

/* Controls: at least 44px on a side, keyboard and mouse alike. */
.input {
  flex: 1;
  min-width: 0;
  min-height: var(--size-tap);
  padding: 0 var(--space-3);
  font: inherit;
  font-size: max(16px, var(--text-base));
  color: inherit;
  background: var(--color-bg);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
}
.input::placeholder {
  color: var(--color-muted);
}
.button {
  min-height: var(--size-tap);
  padding: 0 var(--space-4);
  font: inherit;
  font-weight: 600;
  color: var(--color-accent-fg);
  background: var(--color-accent);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
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
  color: var(--color-muted);
  background: transparent;
  padding: 0 var(--space-3);
}
.button-quiet:hover {
  color: var(--color-fg);
  border-color: var(--color-line);
  filter: none;
}
.pill {
  display: inline-block;
  padding: 0.1rem 0.6rem;
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--color-muted);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-pill);
}
.pill[data-env="production"] {
  color: var(--color-accent);
  border-color: currentColor;
}

/* A word from the last request, shown once, gone in a moment. */
.toast {
  position: fixed;
  left: 50%;
  bottom: var(--space-5);
  transform: translateX(-50%);
  max-width: calc(100% - 2 * var(--space-4));
  padding: var(--space-3) var(--space-4);
  color: var(--color-toast-fg);
  background: var(--color-toast-bg);
  border-radius: var(--radius-pill);
  box-shadow: 0 8px 24px var(--color-shadow);
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
/* Forced colours replace ours with the person's own; what only a background
   or a shadow drew gets a border, so it is still there to see. */
@media (forced-colors: active) {
  .card,
  .input,
  .button,
  .pill,
  .toast,
  .skip {
    border: 1px solid CanvasText;
  }
  :focus-visible {
    outline-color: Highlight;
  }
}
/* Motion is a courtesy: whoever asked for less gets none. */
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
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
const ONCE_TS = `/**
 * A job the forge fires on a clock (\`schedules\` in forge.json, or a timer the
 * app armed). The forge wakes the app and POSTs the path with:
 *
 *   x-forge-schedule, x-forge-scheduled-at, x-forge-attempt
 *   idempotency-key:   <app>:<name>:<scheduled time>
 *   x-forge-identity:  forge-timer|<that key>|timer|<expiresMs>
 *   x-forge-signature: base64url(HMAC-SHA256(FORGE_APP_IDENTITY_KEY, identity))
 *
 * \`fromForge\` says whether the forge sent it. \`once\` runs a handler once per
 * key and answers 200 for a repeat, so a retry or a second delivery never
 * does the work twice. A handler that throws gives the key back, so the forge's
 * next attempt runs it.
 */

import type { Database } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import { sign } from "./who.ts";

export interface Delivery {
  key: string;
  schedule: string;
  scheduledAt: string;
  attempt: number;
}

/** The delivery, when its signature verifies under the app's identity key; otherwise null. */
export function fromForge(request: Request, identityKey: string, now = Date.now()): Delivery | null {
  const identity = request.headers.get("x-forge-identity");
  const signature = request.headers.get("x-forge-signature");
  const key = request.headers.get("idempotency-key");
  if (identityKey === "" || identity === null || signature === null || key === null) return null;
  const want = Buffer.from(sign(identity, identityKey));
  const got = Buffer.from(signature);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  const [who, signed, role, expires] = identity.split("|");
  if (who !== "forge-timer" || role !== "timer" || signed !== key || Number(expires) <= now) return null;
  return {
    key,
    schedule: request.headers.get("x-forge-schedule") ?? "",
    scheduledAt: request.headers.get("x-forge-scheduled-at") ?? "",
    attempt: Number(request.headers.get("x-forge-attempt") ?? 1),
  };
}

/** Run \`handler\` once for \`key\`; a repeat answers 200 "already done" without running it. */
export async function once(db: Database, key: string, handler: () => Promise<Response | void> | Response | void): Promise<Response> {
  db.run("CREATE TABLE IF NOT EXISTS once_key (key TEXT PRIMARY KEY, at INTEGER NOT NULL)");
  db.run("DELETE FROM once_key WHERE at < ?1", [Date.now() - 30 * 86_400_000]);
  if (db.run("INSERT OR IGNORE INTO once_key (key, at) VALUES (?1, ?2)", [key, Date.now()]).changes === 0)
    return new Response("already done", { status: 200 });
  try {
    return (await handler()) ?? new Response("done", { status: 200 });
  } catch (error) {
    db.run("DELETE FROM once_key WHERE key = ?1", [key]);
    throw error;
  }
}
`;

const ONCE_TEST = `import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { fromForge, once } from "./once.ts";
import { sign } from "./who.ts";

const KEY = "k";
const delivery = (key: string, over: Record<string, string> = {}): Request => {
  const identity = "forge-timer|" + key + "|timer|" + (Date.now() + 60_000);
  return new Request("http://app/jobs/print", {
    method: "POST",
    headers: { "idempotency-key": key, "x-forge-identity": identity, "x-forge-signature": sign(identity, KEY), "x-forge-schedule": "print", ...over },
  });
};

test("a delivery the forge signed is read; anything else is not", () => {
  expect(fromForge(delivery("a:print:1"), KEY)?.key).toBe("a:print:1");
  expect(fromForge(delivery("a:print:1"), "other")).toBeNull();
  expect(fromForge(delivery("a:print:1", { "idempotency-key": "a:print:2" }), KEY)).toBeNull();
  expect(fromForge(new Request("http://app/jobs/print", { method: "POST" }), KEY)).toBeNull();
});

test("a handler runs once per key; a repeat answers 200 and does not run it", async () => {
  const db = new Database(":memory:");
  let ran = 0;
  const handler = () => void ran++;
  expect((await once(db, "a:print:1", handler)).status).toBe(200);
  expect(await (await once(db, "a:print:1", handler)).text()).toBe("already done");
  expect(ran).toBe(1);
  await once(db, "a:print:2", handler);
  expect(ran).toBe(2);
});

test("a handler that throws gives the key back, so the next attempt runs", async () => {
  const db = new Database(":memory:");
  await expect(once(db, "k", () => { throw new Error("no paper"); })).rejects.toThrow("no paper");
  expect((await once(db, "k", () => new Response("printed"))).status).toBe(200);
});
`;

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

const SIGNIN_TEST = `import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.ts";
import { begin, finish, sessionWho, verify, type Signin } from "./signin.ts";

const dir = mkdtempSync(join(tmpdir(), "app-"));
const db = openDb(dir);
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
const ISS = "https://forge.test";
const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString("base64url");
const generate = () =>
  crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);

let good: CryptoKeyPair;
let other: CryptoKeyPair;
let jwk: JsonWebKey;
beforeAll(async () => {
  good = await generate();
  other = await generate();
  jwk = await crypto.subtle.exportKey("jwk", good.publicKey);
});

/** An id_token as the forge would sign it, then spoiled one way at a time. */
async function mint(
  claims: Record<string, unknown> = {},
  opts: { alg?: string; kid?: string; key?: CryptoKey } = {},
): Promise<string> {
  const head = b64({ alg: opts.alg ?? "ES256", typ: "JWT", kid: opts.kid ?? "k1" });
  const body = b64({
    iss: ISS,
    aud: "c1",
    nonce: "n1",
    sub: "u1",
    preferred_username: "alice",
    exp: Math.floor(Date.now() / 1000) + 600,
    ...claims,
  });
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    opts.key ?? good.privateKey,
    new TextEncoder().encode(\`\${head}.\${body}\`),
  );
  return \`\${head}.\${body}.\${Buffer.from(sig).toString("base64url")}\`;
}

// A forge that registers a client, publishes one key, and trades any code for \`token\`.
let token = "";
const forge = (async (url: string | URL | Request) => {
  const path = new URL(String(url)).pathname;
  if (path === "/oauth/register") return Response.json({ client_id: "c1" }, { status: 201 });
  if (path === "/oauth/jwks") return Response.json({ keys: [{ ...jwk, kid: "k1" }] });
  if (path === "/oauth/token") return Response.json({ id_token: token });
  return new Response("no", { status: 404 });
}) as unknown as typeof fetch;
const signin: Signin = {
  forge: ISS,
  origin: "https://app.test",
  dataDir: dir,
  name: "app",
  fetch: forge,
};

test("sign-in goes out with PKCE, state and nonce, to the registered redirect", async () => {
  const { location, state } = await begin(db, signin);
  const to = new URL(location);
  expect(\`\${to.origin}\${to.pathname}\`).toBe(\`\${ISS}/oauth/authorize\`);
  expect(to.searchParams.get("client_id")).toBe("c1");
  expect(to.searchParams.get("redirect_uri")).toBe("https://app.test/signin/callback");
  expect(to.searchParams.get("code_challenge_method")).toBe("S256");
  expect(to.searchParams.get("state")).toBe(state);
  expect(to.searchParams.get("nonce")?.length).toBeGreaterThan(16);
});

test("verify accepts the forge's token, and refuses each way it can be wrong", async () => {
  expect(await verify(signin, await mint(), "n1")).toEqual({
    sub: "u1",
    preferred_username: "alice",
  });
  const past = Math.floor(Date.now() / 1000) - 1;
  const refused: [string, string][] = [
    ["alg is not ES256", await mint({}, { alg: "HS256" })],
    ["alg none", await mint({}, { alg: "none" })],
    ["signed by another key", await mint({}, { key: other.privateKey })],
    ["unknown kid", await mint({}, { kid: "zz" })],
    ["wrong issuer", await mint({ iss: "https://evil.test" })],
    ["wrong audience", await mint({ aud: "c2" })],
    ["wrong nonce", await mint({ nonce: "n2" })],
    ["no nonce", await mint({ nonce: undefined })],
    ["expired", await mint({ exp: past })],
    ["no expiry", await mint({ exp: undefined })],
    ["empty sub", await mint({ sub: "" })],
    ["no sub", await mint({ sub: undefined })],
    ["not a jwt", "a.b"],
    ["garbage", "a.b.c"],
  ];
  for (const [why, jwt] of refused)
    expect([why, await verify(signin, jwt, "n1")]).toEqual([why, undefined]);
  // A payload swapped under a good signature is not the signed one.
  const [h, , s] = (await mint()).split(".");
  const swapped = \`\${h}.\${b64({ iss: ISS, aud: "c1", nonce: "n1", sub: "root", exp: past + 900 })}.\${s}\`;
  expect(await verify(signin, swapped, "n1")).toBeUndefined();
});

/** Start a sign-in and come back with an id_token; the request carries the cookie of the browser that began it. */
async function comeBack(spoil?: (nonce: string) => Promise<string>, cookie?: (state: string) => string) {
  const { location, state } = await begin(db, signin);
  const nonce = new URL(location).searchParams.get("nonce")!;
  token = spoil === undefined ? await mint({ nonce }) : await spoil(nonce);
  const url = new URL(\`https://app.test/signin/callback?code=x&state=\${state}\`);
  const request = new Request(url, {
    headers: { cookie: cookie === undefined ? \`signin=\${state}\` : cookie(state) },
  });
  return { state, url, request };
}

test("a return opens a session once, and the same return again opens nothing", async () => {
  const { url, request } = await comeBack();
  const done = await finish(db, signin, request, url);
  expect(done.ok).toBe(true);
  if (done.ok)
    expect(
      sessionWho(db, new Request("http://x", { headers: { cookie: \`session=\${done.session}\` } })),
    ).toEqual({ role: "user", id: "u1", name: "alice" });
  expect((await finish(db, signin, request, url)).ok).toBe(false);
});

test("a return is refused when the browser, the time or the token is not the sign-in's own", async () => {
  const stranger = await comeBack(undefined, () => "signin=other");
  expect((await finish(db, signin, stranger.request, stranger.url)).ok).toBe(false);
  const bare = await comeBack(undefined, () => "");
  expect((await finish(db, signin, bare.request, bare.url)).ok).toBe(false);

  const late = await comeBack();
  db.query("UPDATE login SET expires_at = ?1").run(Date.now() - 1);
  expect((await finish(db, signin, late.request, late.url)).ok).toBe(false);

  const wrongNonce = await comeBack(() => mint({ nonce: "not-this-sign-in" }));
  expect((await finish(db, signin, wrongNonce.request, wrongNonce.url)).ok).toBe(false);

  const denied = await comeBack();
  const url = new URL(\`https://app.test/signin/callback?error=access_denied&state=\${denied.state}\`);
  expect((await finish(db, signin, denied.request, url)).ok).toBe(false);
});

test("a session is a cookie that names a person, and only until it expires", () => {
  db.query("INSERT INTO session VALUES (?1, 'u2', 'bob', ?2)").run(
    new Bun.CryptoHasher("sha256").update("abc").digest("hex"),
    Date.now() + 1000,
  );
  const req = (cookie: string) => new Request("http://x", { headers: { cookie } });
  expect(sessionWho(db, req("session=abc"))).toEqual({ role: "user", id: "u2", name: "bob" });
  expect(sessionWho(db, req("session=abd"))).toBeUndefined();
  expect(sessionWho(db, req("session=abc"), Date.now() + 5000)).toBeUndefined();
});
`;

const DB_TEST = `import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, migrate, migrations, openDb } from "./db.ts";

test("migrations apply once, in order, and the file checks out", () => {
  const dir = mkdtempSync(join(tmpdir(), "app-db-"));
  const db = openDb(dir);
  try {
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
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
`;

const ACTIONS_TEST = `import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addNote, deleteNote, listNotes } from "./actions.ts";
import { openDb } from "./db.ts";
import type { Who } from "./who.ts";

const dir = mkdtempSync(join(tmpdir(), "app-actions-"));
const db = openDb(dir);
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
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

const CONTRACT_TEST = `/**
 * Every door answers as the table says. The test acts as each identity the
 * contract declares — on a note that names them and on one that names
 * someone else — and calls the real actions. A rule written by hand in an
 * action, or a cell changed without its door, fails here.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addNote,
  deleteNote,
  getAudit,
  getNote,
  listAudit,
  listNotes,
  updateNote,
} from "./actions.ts";
import { record } from "./audit.ts";
import { actingAs, identities, table, type Verb } from "./can.ts";
import { contract } from "./contract.ts";
import { openDb } from "./db.ts";
import type { Who } from "./who.ts";

const dir = mkdtempSync(join(tmpdir(), "app-contract-"));
const db = openDb(dir);
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The identity the evaluator acts as, as the forge would have signed it. */
function whoIs(identity: string): Who {
  const { actor } = actingAs(contract, identity);
  const role = actor.roles[0];
  if (actor.id === null || (role !== "user" && role !== "admin"))
    return { role: "anon" };
  return { role, id: actor.id, name: identity };
}

const noteBy = (authorId: string): number =>
  db
    .query<
      { id: number },
      [string]
    >("INSERT INTO note (body, author_id, author_name) VALUES ('n', ?1, ?1) RETURNING id")
    .get(authorId)!.id;

const auditRow = (): number => {
  record(db, {
    who: { role: "anon" },
    resource: "note",
    verb: "create",
    outcome: "signin_required",
  });
  return db.query<{ id: number }, []>("SELECT max(id) AS id FROM audit").get()!
    .id;
};

/** One door per verb an action serves: did it let \`who\` through, on \`row\`? */
const doors: Record<
  string,
  Partial<Record<Verb, (who: Who, authorId: string) => boolean>>
> = {
  note: {
    create: (who) => addNote(db, who, { body: "hello" }).ok,
    list: (who) => listNotes(db, who).ok,
    read: (who, authorId) => getNote(db, who, { id: noteBy(authorId) }).ok,
    update: (who, authorId) =>
      updateNote(db, who, { id: noteBy(authorId), body: "changed" }).ok,
    delete: (who, authorId) => deleteNote(db, who, { id: noteBy(authorId) }).ok,
  },
  // The trail is written by the app itself, never through a door: there
  // is no action that creates, changes or removes a row of it.
  audit: {
    list: (who) => listAudit(db, who).ok,
    read: (who) => getAudit(db, who, { id: auditRow() }).ok,
    create: () => false,
    update: () => false,
    delete: () => false,
  },
};

test("the contract names the identities the forge signs", () => {
  expect(identities(contract).sort()).toEqual(["admin", "anon", "user"]);
});

test("every resource in the contract has every door here", () => {
  expect(Object.keys(doors).sort()).toEqual(
    Object.keys(contract.resources).sort(),
  );
  for (const resource of Object.keys(contract.resources))
    expect(Object.keys(doors[resource] ?? {}).sort()).toEqual([
      "create",
      "delete",
      "list",
      "read",
      "update",
    ]);
});

test("every door answers as the table says, as every identity", () => {
  let asked = 0;
  for (const cell of table(contract)) {
    const door = doors[cell.resource]?.[cell.verb];
    if (door === undefined) continue;
    const who = whoIs(cell.as);
    const { mine, theirs } = actingAs(contract, cell.as);
    const onMine = door(who, String(mine["author_id"]));
    const onTheirs = door(who, String(theirs["author_id"]));
    const said = \`\${cell.resource}.\${cell.verb} as \${cell.as}\`;
    asked++;
    if (cell.answer === "yes")
      expect([said, onMine, onTheirs]).toEqual([said, true, true]);
    else if (cell.answer === "no")
      expect([said, onMine, onTheirs]).toEqual([said, false, false]);
    else if (cell.verb === "list") expect([said, onMine]).toEqual([said, true]);
    else expect([said, onMine, onTheirs]).toEqual([said, true, false]);
  }
  expect(asked).toBeGreaterThan(0);
});
`;

const SERVER_TEST = `import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.ts";
import { env, publicOrigin } from "./env.ts";
import { serve } from "./server.ts";
import { sign } from "./who.ts";

const KEY = "a-key-only-the-forge-holds";
const dataDir = mkdtempSync(join(tmpdir(), "app-"));
const server = serve({ port: 0, dataDir, identityKey: KEY });
const base = \`http://\${server.hostname}:\${server.port}\`;
afterAll(() => {
  server.stop(true);
  rmSync(dataDir, { recursive: true, force: true });
});

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

test("a session signs a person in, and a signed header from the forge outranks it", async () => {
  openDb(dataDir)
    .query("INSERT INTO session VALUES (?1, 'u1', 'sam', ?2)")
    .run(
      new Bun.CryptoHasher("sha256").update("sess").digest("hex"),
      Date.now() + 60_000,
    );
  const session = { cookie: "session=sess" };
  const alone = await (await api("/", {}, session)).text();
  expect(alone).toContain("<b>sam</b>");
  expect(alone).not.toContain("admin");
  // An admin who signs in this way keeps being an admin while the forge says so.
  const both = await (await api("/", {}, { ...session, ...root })).text();
  expect(both).toContain("<b>root</b> · admin");
  expect(both).not.toContain("<b>sam</b>");
  // A forged header does not outrank anything.
  const forged = await (
    await api("/", {}, { ...session, "x-forge-identity": "u0|root|admin|9999999999999", "x-forge-signature": "nope" })
  ).text();
  expect(forged).toContain("<b>sam</b>");
});

test("the page knows who you are and offers the right door", async () => {
  const guest = await (await fetch(base + "/")).text();
  expect(guest).toContain("<h1>");
  expect(guest).toContain('href="/signin"');
  expect(guest).toContain('href="/__forge/report"');
  expect(guest).not.toContain('action="/notes"');
  const signed = await (await api("/", {}, alice)).text();
  expect(signed).toContain("<b>alice</b>");
  expect(signed).toContain('action="/signout"');
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

test("/healthz says up, apart from the page", async () => {
  const response = await fetch(base + "/healthz");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const health = (await response.json()) as Record<string, unknown>;
  expect(health.ok).toBe(true);
  expect(health.version).toMatch(/^\\d+\\.\\d+\\.\\d+/);
  expect(Number.isInteger(health.uptime)).toBe(true);
  expect((await fetch(base + "/healthz", { method: "HEAD" })).status).toBe(200);
});

test("a link to the page unfurls: description, Open Graph, a card", async () => {
  const page = await (await fetch(base + "/")).text();
  for (const meta of [
    'name="description"',
    'property="og:title"',
    'property="og:description"',
    'property="og:url"',
    'property="og:type" content="website"',
    'name="twitter:card" content="summary_large_image"',
    'name="theme-color"',
  ])
    expect([meta, page.includes(meta)]).toEqual([meta, true]);
});

test("the look is the tokens: /tokens.css is linked by content and cached for a year", async () => {
  const page = await (await fetch(base + "/")).text();
  const href = /href="(\\/tokens\\.css\\?v=[0-9a-f]{8})"/.exec(page)?.[1];
  expect(href).toBeDefined();
  const css = await fetch(base + href!);
  expect(css.headers.get("content-type")).toContain("text/css");
  expect(css.headers.get("cache-control")).toContain("immutable");
  expect(await css.text()).toContain("--color-bg:");
  // The tokens come first, so every rule after them can use them.
  expect(page.indexOf("/tokens.css")).toBeLessThan(
    page.indexOf("/static/app.css"),
  );
});

test("a page carries an ETag and answers 304 to a copy already held", async () => {
  const first = await fetch(base + "/");
  const etag = first.headers.get("etag");
  expect(etag).toMatch(/^W\\/"/);
  const again = await fetch(base + "/", { headers: { "if-none-match": etag! } });
  expect(again.status).toBe(304);
  expect(again.headers.get("etag")).toBe(etag);
  expect((await fetch(base + "/", { headers: { "if-none-match": 'W/"x"' } })).status).toBe(200);
});

test("what the web expects: robots.txt, and security.txt from the forge that runs us", async () => {
  // Production is read by crawlers, the API is not; anything else is a
  // draft and asks not to be indexed at all.
  const robots = await (await fetch(base + "/robots.txt")).text();
  const noindex = (await fetch(base + "/")).headers.get("x-robots-tag");
  if (env === "production") {
    expect(robots).toContain("Disallow: /api/\\n");
    expect(noindex).toBeNull();
  } else {
    expect(robots).toContain("User-agent: *\\nDisallow: /\\n");
    expect(noindex).toBe("noindex");
  }
  const security = await fetch(base + "/.well-known/security.txt");
  expect(security.status).toBe(200);
  const body = await security.text();
  expect(body).toContain(\`Contact: \${process.env.FORGE_URL ?? publicOrigin}/\`);
  const expires = /^Expires: (\\S+)$/m.exec(body)?.[1] ?? "";
  expect(Date.parse(expires)).toBeGreaterThan(Date.now());
  const password = await fetch(base + "/.well-known/change-password", {
    redirect: "manual",
  });
  expect(password.status).toBe(302);
  expect(password.headers.get("location")).toBe(process.env.FORGE_URL ?? "/");
});
`;

// The look, as data.
const TOKENS_JSON = `{
  "$description": "The look, as data (W3C design tokens). Every colour the app shows is here and nowhere else: src/tokens.ts compiles this to /tokens.css at boot, and bun run lint:design refuses a raw colour anywhere else. A colour's $value is the light theme; $extensions.mode.dark is the dark one.",
  "color": {
    "$type": "color",
    "bg": {
      "$value": "#f6f6f3",
      "$extensions": { "mode": { "dark": "#131312" } }
    },
    "surface": {
      "$value": "#ffffff",
      "$extensions": { "mode": { "dark": "#1d1d1b" } }
    },
    "fg": {
      "$value": "#1c1c1a",
      "$extensions": { "mode": { "dark": "#ecece7" } }
    },
    "muted": {
      "$value": "#6b6b65",
      "$extensions": { "mode": { "dark": "#9a9a93" } }
    },
    "line": {
      "$value": "#e3e3dd",
      "$extensions": { "mode": { "dark": "#2c2c29" } }
    },
    "accent": {
      "$value": "#2f5bea",
      "$extensions": { "mode": { "dark": "#7c96ff" } }
    },
    "accent-fg": {
      "$value": "#ffffff",
      "$extensions": { "mode": { "dark": "#0f1a4d" } }
    },
    "danger": {
      "$value": "#c2410c",
      "$extensions": { "mode": { "dark": "#fb923c" } }
    },
    "toast-bg": {
      "$value": "#1c1c1a",
      "$extensions": { "mode": { "dark": "#ecece7" } }
    },
    "toast-fg": {
      "$value": "#f6f6f3",
      "$extensions": { "mode": { "dark": "#131312" } }
    },
    "shadow": {
      "$value": "#0000002e",
      "$extensions": { "mode": { "dark": "#00000080" } }
    }
  },
  "space": {
    "$type": "dimension",
    "1": { "$value": "0.25rem" },
    "2": { "$value": "0.5rem" },
    "3": { "$value": "0.75rem" },
    "4": { "$value": "1rem" },
    "5": { "$value": "1.5rem" },
    "6": { "$value": "2.5rem" }
  },
  "radius": {
    "$type": "dimension",
    "md": { "$value": "10px" },
    "pill": { "$value": "999px" }
  },
  "size": {
    "$type": "dimension",
    "tap": {
      "$value": "44px",
      "$description": "The least a control measures on a side."
    }
  },
  "font": {
    "$type": "fontFamily",
    "sans": {
      "$value": ["system-ui", "-apple-system", "Segoe UI", "sans-serif"]
    },
    "mono": {
      "$value": ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"]
    }
  },
  "text": {
    "$type": "dimension",
    "sm": { "$value": "0.875rem" },
    "base": {
      "$value": "1rem",
      "$description": "Never below 16px: a phone zooms into a smaller input."
    },
    "lg": { "$value": "1.125rem" },
    "xl": { "$value": "1.5rem" }
  },
  "leading": {
    "$type": "number",
    "body": { "$value": 1.55 },
    "tight": { "$value": 1.2 }
  }
}
`;

// The tokens, compiled at boot.
const TOKENS_TS = `/**
 * The look, compiled. \`design/tokens.json\` is the app's design tokens in the
 * W3C format — groups, \`$value\`, a \`$type\` a group hands down — and this
 * turns them into custom properties once, at boot: \`color.bg\` becomes
 * \`--color-bg\`. A colour's \`$value\` is the light theme and
 * \`$extensions.mode.dark\` the dark one; dark follows the system unless
 * \`<html data-theme="light|dark">\` decides. The page links the result as
 * \`/tokens.css\`, and every other stylesheet speaks only in \`var(--…)\`.
 *
 * Tokens that do not read are not a warning. The app does not start.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export interface Token {
  /** The custom property: \`--color-bg\`. */
  readonly name: string;
  readonly type: string;
  readonly light: string;
  readonly dark?: string;
}

const isGroup = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Every token in the tree, in order, with its type and both themes' values. */
export function flatten(
  tree: unknown,
  path: string[] = [],
  type = "",
): Token[] {
  if (!isGroup(tree))
    throw new Error(\`\${path.join(".") || "tokens"}: not a group\`);
  const here = typeof tree.$type === "string" ? tree.$type : type;
  if ("$value" in tree) {
    const name = \`--\${path.join("-")}\`;
    if (!/^--[a-z0-9-]+$/.test(name))
      throw new Error(\`\${path.join(".")}: not a name CSS can carry\`);
    if (here === "") throw new Error(\`\${path.join(".")}: no $type\`);
    const dark =
      isGroup(tree.$extensions) && isGroup(tree.$extensions.mode)
        ? tree.$extensions.mode.dark
        : undefined;
    return [
      {
        name,
        type: here,
        light: css(tree.$value, path),
        ...(dark === undefined ? {} : { dark: css(dark, path) }),
      },
    ];
  }
  return Object.entries(tree)
    .filter(([key]) => !key.startsWith("$"))
    .flatMap(([key, child]) => flatten(child, [...path, key], here));
}

// A value is a string, a number, or a font stack; nothing in it may close
// the declaration it sits in.
function css(value: unknown, path: string[]): string {
  const text = Array.isArray(value)
    ? value
        .map((f) =>
          /^[\\w-]+$/.test(String(f)) ? String(f) : JSON.stringify(String(f)),
        )
        .join(", ")
    : typeof value === "string" || typeof value === "number"
      ? String(value)
      : "";
  if (text === "" || /[;{}<]/.test(text))
    throw new Error(\`\${path.join(".")}: $value is not a CSS value\`);
  return text;
}

/** The stylesheet: every token on \`:root\`, the dark ones twice — for the system's choice and for the page's. */
export function compile(tokens: readonly Token[]): string {
  const block = (selector: string, lines: string[]): string =>
    \`\${selector} {\\n\${lines.map((l) => \`  \${l}\\n\`).join("")}}\\n\`;
  const light = tokens.map((t) => \`\${t.name}: \${t.light};\`);
  const dark = tokens.flatMap((t) =>
    t.dark === undefined ? [] : [\`\${t.name}: \${t.dark};\`],
  );
  return [
    block(":root", ["color-scheme: light dark;", ...light]),
    block(':root[data-theme="light"]', ["color-scheme: light;"]),
    \`@media (prefers-color-scheme: dark) {\\n\${block(':root:not([data-theme="light"])', dark)}}\\n\`,
    block(':root[data-theme="dark"]', ["color-scheme: dark;", ...dark]),
  ].join("\\n");
}

export const tokens: readonly Token[] = flatten(
  JSON.parse(
    readFileSync(new URL("../design/tokens.json", import.meta.url), "utf8"),
  ),
);
export const tokensCss: string = compile(tokens);
/** \`/tokens.css\`, addressed by its content, so it can be cached for a year. */
export const tokensHref = \`/tokens.css?v=\${createHash("sha256").update(tokensCss).digest("hex").slice(0, 8)}\`;

/** One token's value, for the few places a colour must be spelled out (the browser's own chrome). */
export const token = (
  name: string,
  mode: "light" | "dark" = "light",
): string => {
  const found = tokens.find((t) => t.name === \`--\${name}\`);
  if (found === undefined) throw new Error(\`no token \${name}\`);
  return mode === "dark" ? (found.dark ?? found.light) : found.light;
};
`;

// No colour but the tokens'.
const LINT_DESIGN_TS = `/**
 * Every colour comes from \`design/tokens.json\`. This refuses a raw one —
 * \`#hex\`, \`rgb(\`, \`hsl(\` — anywhere else the app draws from: \`static/\`
 * and \`src/\`, tests aside. A colour spelled out in a stylesheet is a colour
 * the dark theme never hears about. It refuses a \`var(--…)\` in a stylesheet
 * that names no token, too: a typo there is a page quietly unstyled.
 *
 *   bun run lint:design    exit 1 and one line per raw colour, or silence
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tokens } from "../src/tokens.ts";

const RAW =
  /(?<![\\w&])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\\w-])|\\b(?:rgba?|hsla?)\\(/gi;

/** The raw colours in one file's text: \`path:line: …\`, one per find. */
export function rawColours(path: string, text: string): string[] {
  return text
    .split("\\n")
    .flatMap((line, i) =>
      [...line.matchAll(RAW)].map(
        (m) =>
          \`\${path}:\${i + 1}: raw colour \${m[0]} — name it in design/tokens.json and use var(--…)\`,
      ),
    );
}

/** The custom properties a stylesheet uses that no token defines. */
export function unknownTokens(
  path: string,
  text: string,
  known = new Set(tokens.map((t) => t.name)),
): string[] {
  return text
    .split("\\n")
    .flatMap((line, i) =>
      [...line.matchAll(/var\\((--[\\w-]+)/g)]
        .filter((m) => !known.has(m[1]!))
        .map(
          (m) =>
            \`\${path}:\${i + 1}: \${m[1]} is not a token in design/tokens.json\`,
        ),
    );
}

/** The files the lint reads: what the page is drawn from, never the tokens themselves or the tests. */
export function drawnFrom(root: string): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return walk(path);
      return /\\.(css|js|ts|html)$/.test(entry.name) &&
        !/\\.test\\.ts$/.test(entry.name)
        ? [path]
        : [];
    });
  return ["static", "src"].flatMap(walk);
}

export function lint(root: string): string[] {
  return drawnFrom(root).flatMap((path) => {
    const text = readFileSync(join(root, path), "utf8");
    return [
      ...rawColours(path, text),
      ...(path.endsWith(".css") ? unknownTokens(path, text) : []),
    ];
  });
}

if (import.meta.main) {
  const problems = lint(join(import.meta.dir, ".."));
  // Generated app's lint CLI: stderr is its output.
  for (const problem of problems) console.error(problem);
  process.exit(problems.length === 0 ? 0 : 1);
}
`;

// Who tried to change what.
const AUDIT_TS = `/**
 * The audit trail: every attempt to change something, as one row — who,
 * what (a resource and a verb from the contract), on which row, when, and
 * whether they were let. Refusals are rows too: a stranger knocking on a
 * door that stays shut is exactly what an owner wants to read later.
 *
 * Recording never fails a request. A row that cannot be written becomes a
 * line in the log, with everything the row would have said, and the
 * request goes on; the log is where the forge keeps a run's output.
 *
 * Reads are not recorded (a page view is not an event), and neither is a
 * request refused for coming too fast: a flood must not become the history,
 * or push the real history out.
 */

import type { Database } from "bun:sqlite";
import type { Who } from "./who.ts";

export interface AuditRow {
  readonly id: number;
  readonly at: string;
  readonly who_id: string | null;
  readonly who_name: string | null;
  readonly role: string;
  readonly resource: string;
  readonly verb: string;
  readonly target: string | null;
  readonly allowed: 0 | 1;
  /** \`ok\`, or the failure: \`signin_required\`, \`forbidden\`, \`invalid\`, \`not_found\`, \`cross_site\`. */
  readonly outcome: string;
}

export interface Attempt {
  readonly who: Who;
  readonly resource: string;
  readonly verb: string;
  readonly target?: string | number | undefined;
  readonly outcome: string;
}

/** The newest rows kept; older ones go as new ones come. */
export const KEEP = 50_000;

/** Was it let? Only the door says no; a bad body or a missing row got past it. */
export const allowed = (outcome: string): boolean =>
  outcome !== "signin_required" &&
  outcome !== "forbidden" &&
  outcome !== "cross_site";

export function record(db: Database, attempt: Attempt): void {
  const { who, resource, verb, target, outcome } = attempt;
  const row = {
    who_id: who.role === "anon" ? null : who.id,
    who_name: who.role === "anon" ? null : who.name,
    role: who.role,
    resource,
    verb,
    target: target === undefined ? null : String(target),
    allowed: allowed(outcome) ? 1 : 0,
    outcome,
  };
  try {
    const { lastInsertRowid } = db
      .query(
        "INSERT INTO audit (who_id, who_name, role, resource, verb, target, allowed, outcome) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
      )
      .run(
        row.who_id,
        row.who_name,
        row.role,
        row.resource,
        row.verb,
        row.target,
        row.allowed,
        row.outcome,
      );
    db.query("DELETE FROM audit WHERE id <= ?1").run(
      Number(lastInsertRowid) - KEEP,
    );
  } catch (error) {
    // Generated app: one JSON line to stderr, its own log.
    console.error(
      JSON.stringify({
        audit: row,
        at: new Date().toISOString(),
        unrecorded: String(error),
      }),
    );
  }
}
`;

// The door.
const SECURITY_TS = `/**
 * The door: what every request passes before a route sees it, and before
 * a byte of its body is read. Three checks, in order:
 *
 * 1. **Rationing.** Writes are rationed per person (per address, for a
 *    stranger), and a stranger's calls to the API are rationed too.
 * 2. **Same origin.** A write that a browser says came from another site
 *    is refused: that is another page making this person's browser act.
 * 3. **The contract.** A request under a resource's \`api\` is that
 *    resource's verb (see docs/CONTRACT.md in the forge: \`GET api\` lists,
 *    \`POST api\` creates, \`GET|PATCH|DELETE api/<id>\` read, update,
 *    delete). If the table lets this person through that door for no row
 *    at all, they are refused here — 401 for a stranger, 403 for anyone
 *    else. The action asks again, about the real row; the door only turns
 *    away who could never pass. \`/openapi.json\` is shut to strangers when
 *    the table opens no door to them.
 *
 * Nothing here compares roles by hand: the answer is \`decide\`'s, from the
 * same table the actions read. Refused writes go into the audit trail.
 */

import type { Database } from "bun:sqlite";
import { record } from "./audit.ts";
import { decide, VERBS, type Contract, type Verb } from "./can.ts";
import { actorOf, contract } from "./contract.ts";
import { publicOrigin } from "./env.ts";
import { json, text } from "./http.ts";
import type { Who } from "./who.ts";

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

// A bucket of \`burst\` tokens that refills at \`perSecond\`. In memory, so a
// restart forgets — which is the right size for one process on one machine.
export interface Rate {
  readonly burst: number;
  readonly perSecond: number;
}
export const WRITES: Rate = { burst: 20, perSecond: 2 };
/** A stranger's API calls, reads too. Behind the forge every stranger shares one address, so this is all of them together. */
export const STRANGERS: Rate = { burst: 60, perSecond: 10 };
/** Each start of a sign-in writes a row; one address may not flush the rest. Behind the forge this is everyone together. */
export const SIGNINS: Rate = { burst: 20, perSecond: 1 };
const buckets = new Map<string, { tokens: number; at: number }>();
export function allow(
  key: string,
  rate: Rate = WRITES,
  now = Date.now(),
): boolean {
  const bucket = buckets.get(key) ?? { tokens: rate.burst, at: now };
  bucket.tokens = Math.min(
    rate.burst,
    bucket.tokens + ((now - bucket.at) / 1000) * rate.perSecond,
  );
  bucket.at = now;
  buckets.set(key, bucket);
  if (buckets.size > 10_000)
    for (const [k, b] of buckets) if (now - b.at > 60_000) buckets.delete(k);
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

const ROW_VERB: Readonly<Record<string, Verb>> = {
  GET: "read",
  PATCH: "update",
  DELETE: "delete",
};
const SET_VERB: Readonly<Record<string, Verb>> = {
  GET: "list",
  POST: "create",
};

/** The resource and verb a request is, by the contract's \`api\` paths; undefined for any other path. */
export function doorOf(
  method: string,
  pathname: string,
  table: Contract = contract,
): { resource: string; verb: Verb } | undefined {
  for (const [resource, { api }] of Object.entries(table.resources)) {
    if (api === undefined) continue;
    if (pathname === api) {
      const verb = SET_VERB[method];
      return verb === undefined ? undefined : { resource, verb };
    }
    const rest = pathname.startsWith(\`\${api}/\`)
      ? pathname.slice(api.length + 1)
      : undefined;
    if (rest !== undefined && rest !== "" && !rest.includes("/")) {
      const verb = ROW_VERB[method];
      return verb === undefined ? undefined : { resource, verb };
    }
  }
  return undefined;
}

/**
 * Could \`who\` pass this door for any row at all? The door asks about a row
 * that names them in every column a role is held by — the best row they
 * could hope for — so it refuses only what no row would open.
 */
export function mayKnock(
  who: Who,
  resource: string,
  verb: Verb,
  table: Contract = contract,
): boolean {
  const actor = actorOf(who);
  const columns = Object.values(table.roles).flatMap((role) =>
    role.held.by === "row" ? [role.held.column] : [],
  );
  const best =
    verb === "list" || verb === "create" || actor.id === null
      ? undefined
      : Object.fromEntries(columns.map((column) => [column, actor.id]));
  return decide(table, resource, verb, actor, best) !== "no";
}

/** Does the table open any door with an \`api\` to a stranger? Then the API's description is theirs to read. */
export const openToStrangers = (table: Contract = contract): boolean =>
  Object.entries(table.resources).some(
    ([resource, { api }]) =>
      api !== undefined &&
      VERBS.some((verb) => mayKnock({ role: "anon" }, resource, verb, table)),
  );
const describedToStrangers = openToStrangers();

/**
 * The door. \`undefined\` lets the request through to its route; a response
 * is the refusal. \`from\` is the caller's address, for rationing a stranger.
 */
export function door(
  db: Database,
  request: Request,
  url: URL,
  who: Who,
  from: string,
): Response | undefined {
  const method = request.method === "HEAD" ? "GET" : request.method;
  const writing = method !== "GET";
  const stranger = who.role === "anon";
  const api =
    url.pathname.startsWith("/api/") ||
    url.pathname === "/mcp" ||
    url.pathname === "/openapi.json";
  const key = stranger ? \`ip:\${from}\` : \`user:\${who.id}\`;

  if (writing && !allow(key)) return text("too many requests", 429);
  if (url.pathname === "/signin" && !allow(\`signin:\${from}\`, SIGNINS))
    return text("too many requests", 429);
  if (stranger && api && !allow(\`api:\${from}\`, STRANGERS))
    return text("too many requests", 429);

  const found = doorOf(method, url.pathname);
  if (writing && !sameOrigin(request)) {
    record(db, {
      who,
      resource: found?.resource ?? url.pathname,
      verb: found?.verb ?? method,
      outcome: "cross_site",
    });
    return text("forbidden", 403);
  }

  const shut =
    found === undefined
      ? url.pathname === "/openapi.json" && stranger && !describedToStrangers
      : !mayKnock(who, found.resource, found.verb);
  if (!shut) return undefined;
  const outcome = stranger ? "signin_required" : "forbidden";
  if (writing && found !== undefined)
    record(db, {
      who,
      resource: found.resource,
      verb: found.verb,
      target:
        url.pathname === contract.resources[found.resource]?.api
          ? undefined
          : url.pathname.split("/").at(-1),
      outcome,
    });
  return stranger
    ? json({ error: outcome, message: "Sign in first." }, 401)
    : json({ error: outcome, message: "You may not." }, 403);
}
`;

// The API, described.
const OPENAPI_TS = `/**
 * The API, described: every route in \`routes.ts\` that declares \`api\`, as an
 * OpenAPI 3.1 document. Each operation also names the contract cell it is
 * (\`x-contract\`: the resource, the verb, and the least role the table asks
 * for), so a change of policy is a change here too, and shows in the pull.
 *
 *   bun run contract:emit    write contract/openapi.json from the table
 *
 * \`src/openapi.test.ts\` fails when the committed file and the routes
 * disagree: the description can go stale only in a commit that fails.
 */

import { contract } from "./contract.ts";
import { description, title, version } from "./env.ts";
import { AUDIT_ROW, ERROR, NOTE, routes, type Schema } from "./routes.ts";
import { doorOf } from "./security.ts";

// The shapes said once, under components, and referred to wherever they appear.
const NAMED = new Map<Schema, string>([
  [NOTE, "Note"],
  [AUDIT_ROW, "AuditRow"],
  [ERROR, "Error"],
]);
const named = (schema: Schema): Schema => {
  const name = NAMED.get(schema);
  if (name !== undefined) return { $ref: \`#/components/schemas/\${name}\` };
  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => [
      key,
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? named(value as Schema)
        : value,
    ]),
  );
};
const content = (schema: Schema) => ({
  "application/json": { schema: named(schema) },
});

export function openapi(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of routes) {
    if (route.api === undefined) continue;
    const { summary, body, answer, status, query } = route.api;
    const path = route.path.replace(/:(\\w+)/g, "{$1}");
    const params = [...route.path.matchAll(/:(\\w+)/g)].map(([, name]) => ({
      name,
      in: "path",
      required: true,
      schema: { type: "integer" },
    }));
    const door = doorOf(route.method, route.path.replace(/:\\w+/g, "0"));
    const least =
      door === undefined
        ? undefined
        : contract.resources[door.resource]?.can[door.verb];
    paths[path] ??= {};
    paths[path][route.method.toLowerCase()] = {
      summary,
      operationId: \`\${route.method.toLowerCase()}\${path.replace(/[{}]/g, "").replace(/(^|[/._-])(\\w)/g, (_, __, c: string) => c.toUpperCase())}\`,
      ...(params.length > 0 || query !== undefined
        ? {
            parameters: [
              ...params,
              ...Object.entries(query ?? {}).map(([name, schema]) => ({
                name,
                in: "query",
                schema: named(schema),
              })),
            ],
          }
        : {}),
      ...(body === undefined
        ? {}
        : { requestBody: { required: true, content: content(body) } }),
      responses: {
        [String(status ?? 200)]: {
          description: summary,
          content: content(answer),
        },
        default: {
          description: "{ error, message }: why not",
          content: content(ERROR),
        },
      },
      ...(door === undefined ? {} : { "x-contract": { ...door, least } }),
    };
  }
  return {
    openapi: "3.1.0",
    info: { title, version, description },
    paths,
    components: {
      schemas: Object.fromEntries(
        [...NAMED].map(([schema, name]) => [name, schema]),
      ),
    },
  };
}

/** The file's text: stable, so the same table always writes the same bytes. */
export const emit = (): string => \`\${JSON.stringify(openapi(), null, 2)}\\n\`;
`;

// The description, written where git keeps it.
const CONTRACT_EMIT_TS = `/**
 * Write the API's description where git keeps it: contract/openapi.json,
 * from the routes' own \`api\` entries (src/openapi.ts). Run it after
 * changing a route or a cell of contract.json; the tests say when it is due.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emit } from "../src/openapi.ts";

const dir = join(import.meta.dir, "..", "contract");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "openapi.json"), emit());
console.log("wrote contract/openapi.json");
`;

// The tests for each of those.
const DESIGN_TEST = `/**
 * The look holds: the tokens compile to both themes, every pair of colours
 * a person must read meets WCAG AA in both, and no colour is spelled out
 * anywhere but design/tokens.json.
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lint, rawColours, unknownTokens } from "../scripts/lint-design.ts";
import { compile, flatten, token, tokens, tokensCss } from "./tokens.ts";

test("the tokens compile: light on :root, dark for the system and for data-theme", () => {
  expect(tokensCss).toContain(\`--color-bg: \${token("color-bg")};\`);
  expect(tokensCss).toContain("--space-4: 1rem;");
  expect(tokensCss).toContain(
    '--font-sans: system-ui, -apple-system, "Segoe UI", sans-serif;',
  );
  expect(tokensCss).toContain("@media (prefers-color-scheme: dark)");
  expect(tokensCss).toContain(':root:not([data-theme="light"])');
  expect(tokensCss).toContain(':root[data-theme="dark"]');
  // Every colour has a dark value, or the dark theme would inherit a light one.
  for (const t of tokens.filter((t) => t.type === "color"))
    expect([t.name, t.dark !== undefined]).toEqual([t.name, true]);
  expect(
    tokensCss.split(\`--color-bg: \${token("color-bg", "dark")};\`).length,
  ).toBe(3);
});

test("tokens that do not read stop the app, with the path named", () => {
  expect(() => flatten({ color: { bg: { $value: "#fff" } } })).toThrow(
    "color.bg: no $type",
  );
  expect(() =>
    flatten({
      color: { $type: "color", bg: { $value: "red; } body { display: none" } },
    }),
  ).toThrow("color.bg: $value is not a CSS value");
  expect(() =>
    flatten({ color: { $type: "color", "b g": { $value: "#fff" } } }),
  ).toThrow("not a name CSS can carry");
  expect(
    compile(flatten({ size: { $type: "dimension", tap: { $value: "44px" } } })),
  ).toContain("--size-tap: 44px;");
});

// WCAG 2 relative luminance and contrast, from a #rrggbb.
const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string): number => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [
    number,
    number,
  ];
  return (x + 0.05) / (y + 0.05);
};

test("every pair a person reads is at least 4.5:1, in both themes", () => {
  const pairs = [
    ["color-fg", "color-bg"],
    ["color-fg", "color-surface"],
    ["color-muted", "color-bg"],
    ["color-muted", "color-surface"],
    ["color-accent", "color-bg"],
    ["color-accent", "color-surface"],
    ["color-accent-fg", "color-accent"],
    ["color-toast-fg", "color-toast-bg"],
  ] as const;
  for (const mode of ["light", "dark"] as const)
    for (const [fg, bg] of pairs) {
      const ratio = contrast(token(fg, mode), token(bg, mode));
      expect([mode, fg, bg, ratio >= 4.5]).toEqual([mode, fg, bg, true]);
    }
});

test("the app spells out no colour but in its tokens", () => {
  expect(lint(join(import.meta.dir, ".."))).toEqual([]);
});

test("the lint refuses a raw colour and a token that is not there", () => {
  expect(
    rawColours(
      "a.css",
      ".x { color: #ff0000; }\\n.y { background: rgb(0 0 0); }",
    ),
  ).toEqual([
    "a.css:1: raw colour #ff0000 — name it in design/tokens.json and use var(--…)",
    "a.css:2: raw colour rgb( — name it in design/tokens.json and use var(--…)",
  ]);
  // Not colours: an entity, an id selector's word, a pull number.
  expect(rawColours("a.ts", "\`&#39;\` #notes pull #12 #abcdefg")).toEqual([]);
  expect(
    unknownTokens(
      "a.css",
      ".x { color: var(--color-fg); gap: var(--spcae-2); }",
    ),
  ).toEqual(["a.css:1: --spcae-2 is not a token in design/tokens.json"]);
  const root = mkdtempSync(join(tmpdir(), "app-lint-"));
  try {
    mkdirSync(join(root, "static"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "static", "extra.css"), "a {\\n  color: #fff;\\n}\\n");
    writeFileSync(join(root, "src", "ok.test.ts"), "const red = '#f00';\\n");
    expect(lint(root)).toEqual([
      "static/extra.css:2: raw colour #fff — name it in design/tokens.json and use var(--…)",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
`;

const AUDIT_TEST = `/**
 * The trail: an allowed change and a refused one each leave a row, through
 * the real server; only an admin reads them; and a trail that cannot be
 * written costs a log line, never the request.
 */
import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addNote } from "./actions.ts";
import type { AuditRow } from "./audit.ts";
import { openDb } from "./db.ts";
import { serve } from "./server.ts";
import { sign } from "./who.ts";

const KEY = "a-key-only-the-forge-holds";
const dataDir = mkdtempSync(join(tmpdir(), "app-audit-"));
const server = serve({ port: 0, dataDir, identityKey: KEY });
const base = \`http://\${server.hostname}:\${server.port}\`;
afterAll(() => {
  server.stop(true);
  rmSync(dataDir, { recursive: true, force: true });
});

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
const call = (
  path: string,
  init: RequestInit = {},
  who: Record<string, string> = {},
) =>
  fetch(base + path, {
    ...init,
    headers: { "content-type": "application/json", ...who },
  });
const trail = async (): Promise<AuditRow[]> =>
  (await (await call("/api/audit", {}, root)).json()) as AuditRow[];

test("an allowed change and a refused one each leave a row", async () => {
  const made = await call(
    "/api/notes",
    { method: "POST", body: JSON.stringify({ body: "kept" }) },
    alice,
  );
  expect(made.status).toBe(201);
  const note = (await made.json()) as { id: number };
  // Refused at the door: a stranger may create nothing.
  expect(
    (
      await call("/api/notes", {
        method: "POST",
        body: JSON.stringify({ body: "x" }),
      })
    ).status,
  ).toBe(401);
  // Refused by the action: bob could delete a note of his own, not alice's.
  expect(
    (await call(\`/api/notes/\${note.id}\`, { method: "DELETE" }, bob)).status,
  ).toBe(403);
  // Refused as cross-site, before the table is asked.
  const forged = await fetch(\`\${base}/api/notes/\${note.id}\`, {
    method: "DELETE",
    headers: { ...alice, "sec-fetch-site": "cross-site" },
  });
  expect(forged.status).toBe(403);

  const rows = (await trail()).slice(0, 4).reverse();
  expect(
    rows.map(
      ({ who_name, role, resource, verb, target, allowed, outcome }) => ({
        who_name,
        role,
        resource,
        verb,
        target,
        allowed,
        outcome,
      }),
    ),
  ).toEqual([
    {
      who_name: "alice",
      role: "user",
      resource: "note",
      verb: "create",
      target: String(note.id),
      allowed: 1,
      outcome: "ok",
    },
    {
      who_name: null,
      role: "anon",
      resource: "note",
      verb: "create",
      target: null,
      allowed: 0,
      outcome: "signin_required",
    },
    {
      who_name: "bob",
      role: "user",
      resource: "note",
      verb: "delete",
      target: String(note.id),
      allowed: 0,
      outcome: "forbidden",
    },
    {
      who_name: "alice",
      role: "user",
      resource: "note",
      verb: "delete",
      target: null,
      allowed: 0,
      outcome: "cross_site",
    },
  ]);
  for (const row of rows)
    expect(Date.parse(row.at)).toBeGreaterThan(Date.now() - 60_000);
});

test("reading is not an event: a GET leaves no row", async () => {
  const before = (await trail()).length;
  await call("/api/notes");
  await call("/", {}, alice);
  expect((await trail()).length).toBe(before);
});

test("only an admin reads the trail, at every door the table names", async () => {
  expect((await call("/api/audit")).status).toBe(401);
  expect((await call("/api/audit", {}, alice)).status).toBe(403);
  const rows = await trail();
  expect(rows.length).toBeGreaterThan(0);
  expect((await call(\`/api/audit/\${rows[0]!.id}\`, {}, root)).status).toBe(200);
  expect((await call(\`/api/audit/\${rows[0]!.id}\`, {}, alice)).status).toBe(403);
  expect((await call("/api/audit/999999", {}, root)).status).toBe(404);
  // Nobody writes the trail through a door: not even an admin.
  expect(
    (await call("/api/audit", { method: "POST", body: "{}" }, root)).status,
  ).toBe(403);
  expect(
    (await call(\`/api/audit/\${rows[0]!.id}\`, { method: "DELETE" }, root))
      .status,
  ).toBe(403);
  // Paging back: \`before\` an id is everything older.
  const older = (await (
    await call(\`/api/audit?before=\${rows[0]!.id}&limit=1\`, {}, root)
  ).json()) as AuditRow[];
  expect(older.map((r) => r.id)).toEqual([rows[1]!.id]);
});

test("a trail that cannot be written is a log line, and the change still happens", () => {
  const db = openDb(mkdtempSync(join(dataDir, "broken-")));
  db.exec("DROP TABLE audit");
  const said = spyOn(console, "error").mockImplementation(() => {});
  try {
    const added = addNote(
      db,
      { role: "user", id: "u1", name: "alice" },
      { body: "still here" },
    );
    expect(added.ok).toBe(true);
    expect(said).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(said.mock.calls[0]![0]));
    expect(line.audit).toMatchObject({
      who_name: "alice",
      resource: "note",
      verb: "create",
      allowed: 1,
      outcome: "ok",
    });
    expect(line.unrecorded).toContain("audit");
  } finally {
    said.mockRestore();
  }
});
`;

const SECURITY_TEST = `/**
 * The door turns away, before a byte of the body is read, exactly who the
 * table says could never pass — and nobody it would let through.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readContract } from "./can.ts";
import { openDb } from "./db.ts";
import {
  allow,
  door,
  doorOf,
  mayKnock,
  openToStrangers,
  SIGNINS,
  STRANGERS,
} from "./security.ts";
import { serve } from "./server.ts";
import { sign } from "./who.ts";

const KEY = "a-key-only-the-forge-holds";
const dataDir = mkdtempSync(join(tmpdir(), "app-door-"));
const server = serve({ port: 0, dataDir, identityKey: KEY });
const base = \`http://\${server.hostname}:\${server.port}\`;
afterAll(() => {
  server.stop(true);
  rmSync(dataDir, { recursive: true, force: true });
});
const as = (id: string, role: "user" | "admin"): Record<string, string> => {
  const identity = \`\${id}|\${id}|\${role}|\${Date.now() + 60_000}\`;
  return {
    "x-forge-identity": identity,
    "x-forge-signature": sign(identity, KEY),
  };
};

test("a path is a resource's door by the contract's api, and nothing else is", () => {
  expect(doorOf("GET", "/api/notes")).toEqual({
    resource: "note",
    verb: "list",
  });
  expect(doorOf("POST", "/api/notes")).toEqual({
    resource: "note",
    verb: "create",
  });
  expect(doorOf("GET", "/api/notes/7")).toEqual({
    resource: "note",
    verb: "read",
  });
  expect(doorOf("PATCH", "/api/notes/7")).toEqual({
    resource: "note",
    verb: "update",
  });
  expect(doorOf("DELETE", "/api/notes/7")).toEqual({
    resource: "note",
    verb: "delete",
  });
  expect(doorOf("GET", "/api/audit")).toEqual({
    resource: "audit",
    verb: "list",
  });
  for (const [method, path] of [
    ["PUT", "/api/notes"],
    ["GET", "/api/notes/7/x"],
    ["GET", "/api/notesy"],
    ["GET", "/api/notes/"],
    ["POST", "/notes"],
  ] as const)
    expect(doorOf(method, path)).toBeUndefined();
});

test("the door refuses only what no row would open", () => {
  const anon = { role: "anon" } as const;
  const alice = { role: "user", id: "u1", name: "alice" } as const;
  const root = { role: "admin", id: "u0", name: "root" } as const;
  expect(mayKnock(anon, "note", "list")).toBe(true);
  expect(mayKnock(anon, "note", "create")).toBe(false);
  expect(mayKnock(anon, "note", "delete")).toBe(false);
  // alice may delete a note of her own, so the door lets her ask; the action decides which.
  expect(mayKnock(alice, "note", "delete")).toBe(true);
  expect(mayKnock(alice, "audit", "list")).toBe(false);
  expect(mayKnock(root, "audit", "list")).toBe(true);
  expect(mayKnock(root, "audit", "create")).toBe(false);
});

test("a stranger is refused /api before the body is read, when the contract closes it", async () => {
  // A body past the cap: read, it would be 413. The door answers first.
  const huge = "x".repeat(128 * 1024);
  const refused = await fetch(\`\${base}/api/notes\`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: huge,
  });
  expect(refused.status).toBe(401);
  const signedIn = await fetch(\`\${base}/api/notes\`, {
    method: "POST",
    headers: { "content-type": "application/json", ...as("u1", "user") },
    body: huge,
  });
  expect(signedIn.status).toBe(413);
  expect(await refused.json()).toEqual({
    error: "signin_required",
    message: "Sign in first.",
  });
  expect((await fetch(\`\${base}/api/audit\`)).status).toBe(401);
  expect((await fetch(\`\${base}/api/audit/1\`)).status).toBe(401);
  expect(
    (await fetch(\`\${base}/api/audit\`, { headers: as("u1", "user") })).status,
  ).toBe(403);
  // What the table opens stays open.
  expect((await fetch(\`\${base}/api/notes\`)).status).toBe(200);
  expect((await fetch(\`\${base}/api/notes/0\`)).status).toBe(404);
  expect((await fetch(\`\${base}/openapi.json\`)).status).toBe(200);
});

test("the API's description is shut to strangers when the table opens them no door", () => {
  const closed = readContract(
    JSON.stringify({
      roles: {
        anon: { above: [], held: { by: "everyone" } },
        user: { above: ["anon"], held: { by: "identity", role: "user" } },
      },
      resources: {
        note: {
          api: "/api/notes",
          can: {
            create: "user",
            read: "user",
            update: "user",
            delete: "user",
            list: "user",
          },
        },
      },
    }),
  );
  if (!closed.ok) throw new Error(closed.problems.join("; "));
  expect(openToStrangers(closed.contract)).toBe(false);
  expect(openToStrangers()).toBe(true);
});

test("strangers are rationed at the API, reads too", () => {
  const db = openDb(mkdtempSync(join(dataDir, "rate-")));
  const knock = () =>
    door(
      db,
      new Request("http://app/api/notes"),
      new URL("http://app/api/notes"),
      { role: "anon" },
      "203.0.113.7",
    );
  const answers = Array.from({ length: STRANGERS.burst + 5 }, knock);
  expect(answers.slice(0, STRANGERS.burst).every((a) => a === undefined)).toBe(
    true,
  );
  expect(answers.at(-1)?.status).toBe(429);
  // The page itself is not the API: a stranger reading it is never rationed here.
  expect(
    door(
      db,
      new Request("http://app/"),
      new URL("http://app/"),
      { role: "anon" },
      "203.0.113.7",
    ),
  ).toBeUndefined();
  // Starting a sign-in writes a row, so it is rationed per address, signed in or not.
  const start = (from: string) =>
    door(
      db,
      new Request("http://app/signin"),
      new URL("http://app/signin"),
      { role: "anon" },
      from,
    );
  const starts = Array.from({ length: SIGNINS.burst + 5 }, () => start("198.51.100.9"));
  expect(starts.slice(0, SIGNINS.burst).every((a) => a === undefined)).toBe(true);
  expect(starts.at(-1)?.status).toBe(429);
  expect(start("198.51.100.10")).toBeUndefined();
  // A bucket refills.
  const t = Date.now();
  for (let i = 0; i < 25; i++) allow("k", { burst: 20, perSecond: 2 }, t);
  expect(allow("k", { burst: 20, perSecond: 2 }, t)).toBe(false);
  expect(allow("k", { burst: 20, perSecond: 2 }, t + 1000)).toBe(true);
});
`;

const OPENAPI_TEST = `/**
 * The API's description is the routes' own, committed: emitting it twice
 * says the same bytes, the file in git is what the table says now, and the
 * app serves exactly that file.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emit, openapi } from "./openapi.ts";
import { routes } from "./routes.ts";
import { serve } from "./server.ts";

const committed = readFileSync(
  new URL("../contract/openapi.json", import.meta.url),
  "utf8",
);

test("emission is stable", () => {
  expect(emit()).toBe(emit());
});

test("contract/openapi.json is what the routes say now (else: bun run contract:emit)", () => {
  const now = JSON.parse(emit());
  const stale = !Bun.deepEquals(JSON.parse(committed), now);
  if (stale)
    // Generated app's contract CLI: stderr is its output.
    console.error(
      "contract/openapi.json is stale: run \`bun run contract:emit\` and commit it",
    );
  expect(stale).toBe(false);
});

test("every API route is described, and every door names its cell of the table", () => {
  const doc = openapi() as {
    paths: Record<
      string,
      Record<
        string,
        { "x-contract"?: { resource: string; verb: string; least: string } }
      >
    >;
  };
  for (const route of routes.filter((r) => r.path.startsWith("/api/"))) {
    const op =
      doc.paths[route.path.replace(/:(\\w+)/g, "{$1}")]?.[
        route.method.toLowerCase()
      ];
    expect([route.method, route.path, op !== undefined]).toEqual([
      route.method,
      route.path,
      true,
    ]);
    expect(typeof op?.["x-contract"]?.least).toBe("string");
  }
  expect(doc.paths["/api/audit"]?.get?.["x-contract"]).toEqual({
    resource: "audit",
    verb: "list",
    least: "admin",
  });
});

test("GET /openapi.json serves the committed file", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "app-openapi-"));
  const server = serve({ port: 0, dataDir, identityKey: "k" });
  afterAll(() => {
    server.stop(true);
    rmSync(dataDir, { recursive: true, force: true });
  });
  const response = await fetch(
    \`http://\${server.hostname}:\${server.port}/openapi.json\`,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.text()).toBe(committed);
});
`;

/**
 * What `bun run contract:emit` writes for the routes above, with the app's
 * own name and sentence (`src/env.ts` reads them from package.json): the
 * app's `src/openapi.test.ts` holds the two equal from the first commit.
 */
const openapiJson = (title: string, description: string): string => {
  const doc = JSON.parse(OPENAPI_JSON) as { info: Record<string, string> };
  doc.info.title = title;
  doc.info.description = description || "A new app on the forge.";
  return `${JSON.stringify(doc, null, 2)}\n`;
};
const OPENAPI_JSON = `{
  "openapi": "3.1.0",
  "info": {
    "title": "notes",
    "version": "0.1.0",
    "description": "A place for notes"
  },
  "paths": {
    "/api/notes": {
      "get": {
        "summary": "The notes, newest first.",
        "operationId": "getApiNotes",
        "parameters": [
          {
            "name": "limit",
            "in": "query",
            "schema": {
              "type": "integer",
              "minimum": 1,
              "maximum": 500,
              "default": 100
            }
          }
        ],
        "responses": {
          "200": {
            "description": "The notes, newest first.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "array",
                  "items": {
                    "$ref": "#/components/schemas/Note"
                  }
                }
              }
            }
          },
          "default": {
            "description": "{ error, message }: why not",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/Error"
                }
              }
            }
          }
        },
        "x-contract": {
          "resource": "note",
          "verb": "list",
          "least": "anon"
        }
      },
      "post": {
        "summary": "Add a note as the person asking.",
        "operationId": "postApiNotes",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "properties": {
                  "body": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 500
                  }
                },
                "required": [
                  "body"
                ]
              }
            }
          }
        },
        "responses": {
          "201": {
            "description": "Add a note as the person asking.",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/Note"
                }
              }
            }
          },
          "default": {
            "description": "{ error, message }: why not",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/Error"
                }
              }
            }
          }
        },
        "x-contract": {
          "resource": "note",
          "verb": "create",
          "least": "user"
        }
      }
    },
    "/api/notes/{id}": {
      "get": {
        "summary": "One note.",
        "operationId": "getApiNotesId",
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "integer"
            }
          }
        ],
        "responses": {
          "200": {
            "description": "One note.",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/Note"
                }
              }
            }
          },
          "default": {
            "description": "{ error, message }: why not",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/Error"
                }
              }
            }
          }
        },
        "x-contract": {
          "resource": "note",
          "verb": "read",
          "least": "anon"
        }
      },
      "patch": {
        "summary": "Change a note's words.",
        "operationId": "patchApiNotesId",
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "integer"
            }
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "properties": {
                  "body": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 500
                  }
                },
                "required": [
                  "body"
                ]
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Change a note's words.",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/Note"
                }
              }
            }
          },
          "default": {
            "description": "{ error, message }: why not",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/Error"
                }
              }
            }
          }
        },
        "x-contract": {
          "resource": "note",
          "verb": "update",
          "least": "author"
        }
      },
      "delete": {
        "summary": "Remove a note.",
        "operationId": "deleteApiNotesId",
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "integer"
            }
          }
        ],
        "responses": {
          "200": {
            "description": "Remove a note.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "integer"
                    }
                  },
                  "required": [
                    "id"
                  ]
                }
              }
            }
          },
          "default": {
            "description": "{ error, message }: why not",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/Error"
                }
              }
            }
          }
        },
        "x-contract": {
          "resource": "note",
          "verb": "delete",
          "least": "author"
        }
      }
    },
    "/api/audit": {
      "get": {
        "summary": "The audit trail, newest first; \`before\` pages back by id.",
        "operationId": "getApiAudit",
        "parameters": [
          {
            "name": "limit",
            "in": "query",
            "schema": {
              "type": "integer",
              "minimum": 1,
              "maximum": 500,
              "default": 100
            }
          },
          {
            "name": "before",
            "in": "query",
            "schema": {
              "type": "integer"
            }
          }
        ],
        "responses": {
          "200": {
            "description": "The audit trail, newest first; \`before\` pages back by id.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "array",
                  "items": {
                    "$ref": "#/components/schemas/AuditRow"
                  }
                }
              }
            }
          },
          "default": {
            "description": "{ error, message }: why not",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/Error"
                }
              }
            }
          }
        },
        "x-contract": {
          "resource": "audit",
          "verb": "list",
          "least": "admin"
        }
      }
    },
    "/api/audit/{id}": {
      "get": {
        "summary": "One row of the audit trail.",
        "operationId": "getApiAuditId",
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "integer"
            }
          }
        ],
        "responses": {
          "200": {
            "description": "One row of the audit trail.",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/AuditRow"
                }
              }
            }
          },
          "default": {
            "description": "{ error, message }: why not",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/Error"
                }
              }
            }
          }
        },
        "x-contract": {
          "resource": "audit",
          "verb": "read",
          "least": "admin"
        }
      }
    },
    "/mcp": {
      "post": {
        "summary": "One JSON-RPC 2.0 message to the MCP server; its tools are the actions.",
        "operationId": "postMcp",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "properties": {
                  "jsonrpc": {
                    "const": "2.0"
                  },
                  "id": {},
                  "method": {
                    "type": "string"
                  },
                  "params": {
                    "type": "object"
                  }
                },
                "required": [
                  "jsonrpc",
                  "method"
                ]
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "One JSON-RPC 2.0 message to the MCP server; its tools are the actions.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object"
                }
              }
            }
          },
          "default": {
            "description": "{ error, message }: why not",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/Error"
                }
              }
            }
          }
        }
      }
    },
    "/healthz": {
      "get": {
        "summary": "Whether the app is up: its version, commit, environment and seconds since it started.",
        "operationId": "getHealthz",
        "responses": {
          "200": {
            "description": "Whether the app is up: its version, commit, environment and seconds since it started.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "ok": {
                      "type": "boolean"
                    },
                    "version": {
                      "type": "string"
                    },
                    "commit": {
                      "type": "string"
                    },
                    "env": {
                      "type": "string"
                    },
                    "uptime": {
                      "type": "integer"
                    }
                  },
                  "required": [
                    "ok",
                    "version",
                    "uptime"
                  ]
                }
              }
            }
          },
          "default": {
            "description": "{ error, message }: why not",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/Error"
                }
              }
            }
          }
        }
      }
    }
  },
  "components": {
    "schemas": {
      "Note": {
        "type": "object",
        "properties": {
          "id": {
            "type": "integer"
          },
          "body": {
            "type": "string",
            "minLength": 1,
            "maxLength": 500
          },
          "author_id": {
            "type": "string"
          },
          "author_name": {
            "type": "string"
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          }
        },
        "required": [
          "id",
          "body",
          "author_id",
          "author_name",
          "created_at",
          "updated_at"
        ]
      },
      "AuditRow": {
        "type": "object",
        "properties": {
          "id": {
            "type": "integer"
          },
          "at": {
            "type": "string",
            "format": "date-time"
          },
          "who_id": {
            "type": [
              "string",
              "null"
            ]
          },
          "who_name": {
            "type": [
              "string",
              "null"
            ]
          },
          "role": {
            "enum": [
              "anon",
              "user",
              "admin"
            ]
          },
          "resource": {
            "type": "string"
          },
          "verb": {
            "type": "string"
          },
          "target": {
            "type": [
              "string",
              "null"
            ]
          },
          "allowed": {
            "enum": [
              0,
              1
            ]
          },
          "outcome": {
            "type": "string"
          }
        },
        "required": [
          "id",
          "at",
          "role",
          "resource",
          "verb",
          "allowed",
          "outcome"
        ]
      },
      "Error": {
        "type": "object",
        "properties": {
          "error": {
            "type": "string"
          },
          "message": {
            "type": "string"
          }
        },
        "required": [
          "error"
        ]
      }
    }
  }
}
`;
