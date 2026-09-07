/**
 * The app a new app starts as. Small enough to read in a minute, real
 * enough to demonstrate the one idea a first-time user needs: this app has
 * *data*, that data lives under `FORGE_APP_DATA`, and so production and a
 * preview each have their own. Notes written in production are there in
 * the preview a moment later; notes written in the preview never reach
 * production. Zero dependencies, like the forge that grew it.
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
    { path: "package.json", content: packageJson(input.name) },
    { path: ".gitignore", content: GITIGNORE },
    { path: "README.md", content: readme(title, description) },
    { path: "AGENTS.md", content: AGENTS_MD },
    { path: "src/server.ts", content: server(title, description) },
    { path: "src/server.test.ts", content: SERVER_TEST },
    { path: "src/tty.ts", content: tty(title) },
  ];
}

const FORGE_JSON = `${JSON.stringify(
  {
    app: {
      run: "bun run src/server.ts",
      test: "bun test",
      tty: "bun run src/tty.ts",
    },
  },
  null,
  2,
)}\n`;

const packageJson = (name: string): string =>
  `${JSON.stringify(
    {
      name,
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
FORGE_APP_DATA=./data bun run src/tty.ts                # the terminal interface
\`\`\`

It also has a terminal: the exact command is in \`FORGE_APP_SSH\` when the app
runs (\`ssh -p 2222 <name>@<forge>\` — the app is the login name, the forge is
the host; \`<name>--<pull>@<forge>\` for a preview's). It opens \`src/tty.ts\` on
a real pty over the same data.

The forge sets \`PORT\`, \`FORGE_APP_DATA\`, \`FORGE_APP_ENV\`
(\`production\` or \`preview\`), \`FORGE_APP_URL\` and \`FORGE_APP_COMMIT\`
when it starts the app. \`forge.json\` says how.
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
- \`src/tty.ts\` is the app's terminal interface. The exact command that
  reaches it is \`FORGE_APP_SSH\` at runtime; print that verbatim wherever the
  app tells people how to connect. Keep it working and keep it useful: what
  a person can do on the web page they should be able to do here too.
- Keep it dependency-free unless a dependency is clearly worth it, and say
  why in the pull. A dependency is code you now maintain.
- When you are done, push and stop. Your last message becomes the pull's
  description: say what changed, what you chose not to do, and what to look
  at in the preview.

## The bar

- Shape: small modules named after one concept, plain data in and out. When
  \`src/server.ts\` stops fitting in one read, split it — \`src/db.ts\` for
  the schema and queries, \`src/pages/<page>.ts\` for rendering,
  \`src/routes.ts\` for the table of paths — and keep the pattern you find.
- Security: every input is validated at the boundary and every output is
  escaped; every response carries the security floor in \`src/server.ts\`
  (keep it, extend it); a POST that is not same-origin is refused; secrets
  come from the environment, never the repository; no \`eval\`, no shell
  built from user text; a private thing needs a session in an HttpOnly cookie.
  Every request body is capped by the bytes actually read (\`readBody\` in
  \`src/server.ts\`) — never by a Content-Length, which a chunked request does
  not have and a lie does not honour. \`HEAD\` answers like \`GET\`.
  An app with an owner or admin is never claimed by whoever visits first:
  the first sign-in needs a secret only the operator holds — a password from
  the environment, or a one-time token printed to the run log and the app's
  terminal — and a generated password is shown there once, never on a page.
- Secrets come from the environment: the app's Settings → Environment
  (write-only), read at start-up; never the repository.
- Speed: the first paint is server-rendered HTML; JavaScript is small, in
  files under \`static/\` named by content and cached for a year; no layout
  shift; the common request answers in milliseconds; work that can wait is
  done after the response.
- Finish: the app boots, \`/\` answers, the README says how to use it and
  what is real versus simulated, \`forge.json\` says how to run it.
`;

const server = (title: string, description: string): string => `/**
 * ${title} — a small app with real data.
 *
 * Notes live in a SQLite file under FORGE_APP_DATA. Production and each
 * preview get their own directory, so a preview starts with production's
 * notes and never writes back to them.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const dataDir = process.env.FORGE_APP_DATA ?? "./data";
mkdirSync(dataDir, { recursive: true });
const db = new Database(join(dataDir, "app.db"));
db.exec("PRAGMA journal_mode = WAL");
db.exec(
  "CREATE TABLE IF NOT EXISTS note (id INTEGER PRIMARY KEY, body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))",
);

const env = process.env.FORGE_APP_ENV ?? "local";
const pull = process.env.FORGE_APP_PULL;
const commit = (process.env.FORGE_APP_COMMIT ?? "").slice(0, 7);

const escape = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

// The security floor every response stands on. Scripts and styles come from
// this origin (inline styles allowed, inline scripts not), nothing frames us,
// browsers never guess a content type, and referrers stay on this site.
// The app's public address is what the forge told us, never the socket's.
const publicOrigin = new URL(process.env.FORGE_APP_URL ?? "http://localhost").origin;

const SECURITY = {
  "content-security-policy":
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  // Once served over https, always: browsers remember for a year.
  ...(publicOrigin.startsWith("https:")
    ? { "strict-transport-security": "max-age=31536000" }
    : {}),
};
const html = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...SECURITY } });

// A browser on another site can make a person's browser POST here; it cannot
// make that request look same-origin. Browsers say where a request came from
// (Sec-Fetch-Site, or Origin); a request that names another site is refused.
const sameOrigin = (request: Request): boolean => {
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
const BODY_MAX = 64 * 1024;
async function readBody(request: Request, max = BODY_MAX): Promise<Uint8Array | undefined> {
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

// The form fields of a capped body, decoded the way the browser sent them
// (a plain form or a multipart one), by handing the bytes back to a Request.
async function readForm(request: Request): Promise<FormData | undefined> {
  const body = await readBody(request);
  if (body === undefined) return undefined;
  return new Request(request.url, {
    method: "POST",
    headers: { "content-type": request.headers.get("content-type") ?? "" },
    body,
  }).formData();
}

function page(): string {
  const notes = db
    .query<{ id: number; body: string; created_at: string }, []>(
      "SELECT id, body, created_at FROM note ORDER BY id DESC LIMIT 100",
    )
    .all();
  const where =
    env === "preview" ? \`preview of pull #\${pull ?? "?"}\` : env;
  return \`<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
  :root { color-scheme: light dark; font: 16px/1.5 system-ui, sans-serif; }
  body { max-width: 40rem; margin: 3rem auto; padding: 0 1rem; }
  .env { display: inline-block; padding: .1rem .5rem; border-radius: 999px; font-size: .8rem;
         background: \${env === "production" ? "#16a34a" : "#2563eb"}; color: white; }
  form { display: flex; gap: .5rem; margin: 1.5rem 0; }
  input { flex: 1; padding: .6rem .8rem; font: inherit; border: 1px solid #8884; border-radius: .5rem; }
  button { padding: .6rem 1rem; font: inherit; border: 0; border-radius: .5rem; background: #111; color: white; }
  li { padding: .5rem 0; border-top: 1px solid #8883; list-style: none; }
  small { opacity: .6; }
</style>
<h1>${escape(title)}</h1>
<p>${escape(description || "A new app on the forge.")}</p>
<p><span class="env">\${escape(where)}</span> <small>\${commit ? "@ " + commit : ""}</small></p>
<form method="post" action="/notes">
  <input name="body" placeholder="Write a note" required maxlength="500" autofocus>
  <button>Add</button>
</form>
<ul>\${notes
    .map((n) => \`<li>\${escape(n.body)} <small>\${n.created_at}</small></li>\`)
    .join("")}</ul>
<p><small>\${notes.length === 0 ? "No notes yet. Notes written here stay in this environment's data." : \`\${notes.length} note\${notes.length === 1 ? "" : "s"} in \${escape(where)} data.\`}</small></p>
\`;
}

export const server = Bun.serve({
  port: Number(process.env.PORT ?? 8080),
  hostname: process.env.HOST ?? "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && !sameOrigin(request))
      return new Response("forbidden", { status: 403 });
    if (request.method === "POST" && url.pathname === "/notes") {
      const form = await readForm(request);
      if (form === undefined)
        return new Response("too large", { status: 413, headers: SECURITY });
      const body = String(form.get("body") ?? "").trim().slice(0, 500);
      if (body) db.query("INSERT INTO note (body) VALUES (?1)").run(body);
      return Response.redirect("/", 303);
    }
    // HEAD is GET without the body: a health check sees the app up.
    if (url.pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
      const full = html(page());
      return request.method === "HEAD"
        ? new Response(null, { status: full.status, headers: full.headers })
        : full;
    }
    // Files under ./static are served as they are, cached for a year: name
    // them by content (app.3f2a9c.js) and a change is a new name, never a
    // stale cache. The path is confined to the directory.
    if (url.pathname.startsWith("/static/") && !url.pathname.includes("..")) {
      const file = Bun.file(join(import.meta.dir, "..", url.pathname.slice(1)));
      if (await file.exists())
        return new Response(file, {
          headers: { "cache-control": "public, max-age=31536000, immutable", ...SECURITY },
        });
    }
    return new Response("not found", { status: 404, headers: SECURITY });
  },
  // A bug answers with the floor and nothing else: never the runtime's own
  // error page, which carries source and paths, and never without the
  // headers. The detail goes to the log, where it belongs.
  error(error) {
    console.error(error);
    return html("<h1>Something went wrong</h1>", 500);
  },
});

console.log(\`${escape(title)} listening on http://\${server.hostname}:\${server.port} (\${env})\`);
`;

const tty = (title: string): string => `/**
 * ${title}, in a terminal. The forge runs this on a pty when someone
 * \`ssh\`es to the app, with FORGE_APP_DATA pointing at the same data the
 * web page uses. j/k move, a adds a note, d deletes the one under the
 * cursor, q leaves. Plain ANSI, no dependencies.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const dataDir = process.env.FORGE_APP_DATA ?? "./data";
mkdirSync(dataDir, { recursive: true });
const db = new Database(join(dataDir, "app.db"));
db.exec("PRAGMA journal_mode = WAL");
db.exec(
  "CREATE TABLE IF NOT EXISTS note (id INTEGER PRIMARY KEY, body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))",
);
const where = process.env.FORGE_APP_ENV === "preview" ? \`preview of #\${process.env.FORGE_APP_PULL ?? "?"}\` : (process.env.FORGE_APP_ENV ?? "local");

type Note = { id: number; body: string; created_at: string };
const notes = (): Note[] => db.query<Note, []>("SELECT id, body, created_at FROM note ORDER BY id DESC").all();

let cursor = 0;
let typing: string | undefined;
const out = (s: string): void => { process.stdout.write(s); };
const esc = "\\x1b[";

function draw(): void {
  const rows = notes();
  const lines: string[] = [];
  lines.push(\`\${esc}1m${title}\${esc}0m  \${esc}2m\${where}\${esc}0m\`);
  lines.push("");
  if (rows.length === 0) lines.push(\`\${esc}2mNo notes yet. Press a to add one.\${esc}0m\`);
  rows.forEach((n, i) => {
    const mark = i === cursor ? "▸" : " ";
    const body = i === cursor ? \`\${esc}1m\${n.body}\${esc}0m\` : n.body;
    lines.push(\`\${mark} \${body}  \${esc}2m\${n.created_at}\${esc}0m\`);
  });
  lines.push("");
  lines.push(typing === undefined ? \`\${esc}2mj/k move · a add · d delete · q quit\${esc}0m\` : \`New note: \${typing}\${esc}7m \${esc}0m\`);
  out(\`\${esc}2J\${esc}H\` + lines.join("\\r\\n"));
}

process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");
draw();
process.stdin.on("data", (key: string) => {
  if (typing !== undefined) {
    if (key === "\\r") {
      const body = typing.trim();
      if (body) db.query("INSERT INTO note (body) VALUES (?1)").run(body.slice(0, 500));
      typing = undefined;
      cursor = 0;
    } else if (key === "\\x1b") typing = undefined;
    else if (key === "\\x7f") typing = typing.slice(0, -1);
    else if (key >= " ") typing += key;
    draw();
    return;
  }
  if (key === "q" || key === "\\x03") { out(\`\${esc}2J\${esc}H\`); process.exit(0); }
  const count = notes().length;
  if (key === "j" || key === "\\x1b[B") cursor = Math.min(cursor + 1, Math.max(0, count - 1));
  if (key === "k" || key === "\\x1b[A") cursor = Math.max(cursor - 1, 0);
  if (key === "a") typing = "";
  if (key === "d") {
    const n = notes()[cursor];
    if (n) db.query("DELETE FROM note WHERE id = ?1").run(n.id);
    cursor = Math.min(cursor, Math.max(0, notes().length - 1));
  }
  draw();
});
process.stdout.on("resize", draw);
`;

const SERVER_TEST = `import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FORGE_APP_DATA = mkdtempSync(join(tmpdir(), "app-"));
process.env.PORT = "0";
const { server } = await import("./server.ts");
const base = \`http://\${server.hostname}:\${server.port}\`;

test("serves the page", async () => {
  const response = await fetch(base + "/");
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("<h1>");
});

test("keeps a note", async () => {
  const form = new FormData();
  form.set("body", "hello from a test");
  const posted = await fetch(base + "/notes", { method: "POST", body: form, redirect: "manual" });
  expect(posted.status).toBe(303);
  expect(await (await fetch(base + "/")).text()).toContain("hello from a test");
});

test("stands on the security floor", async () => {
  const response = await fetch(base + "/");
  expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
});

test("a bug answers with the floor, not the runtime's page", async () => {
  // A percent-escape that is not one makes the search params throw.
  const response = await fetch(base + "/notes", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "body=%E0%A4%A",
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
});

test("a body is capped by the bytes read, whatever it claims", async () => {
  // The cap counts bytes as they arrive and never reads Content-Length, so
  // a chunked body with no length is refused the same way this one is.
  const response = await fetch(base + "/notes", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "body=" + "x".repeat(1024 * 1024),
  });
  expect(response.status).toBe(413);
});

test("HEAD sees the app up", async () => {
  const response = await server.fetch(new Request(base + "/", { method: "HEAD" }));
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("");
});

test("refuses a cross-site post", async () => {
  const form = new FormData();
  form.set("body", "from another site");
  const posted = await fetch(base + "/notes", {
    method: "POST",
    body: form,
    redirect: "manual",
    headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
  });
  expect(posted.status).toBe(403);
  expect(await (await fetch(base + "/")).text()).not.toContain("from another site");
});
`;
