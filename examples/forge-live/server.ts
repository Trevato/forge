/**
 * Live UI into the forge, from inside an app: what the crew is doing right
 * now, kept current by the forge's own event stream, and a way to say
 * something about it.
 *
 * The forge hands every app process three things (docs/APPS.md):
 *   FORGE_URL      the forge, for `/mcp` and `/events`
 *   FORGE_API_URL  its JSON API
 *   FORGE_TOKEN    read-only, the app owner's, revoked when this process stops
 *
 * The token stays on this server. The browser gets rendered HTML and a
 * stream that only says "changed" — never the token, never an event's
 * payload, so a visitor learns nothing the list does not already show.
 * Saying something is a link to the forge, where the person speaks under
 * their own name: a read-only token cannot, and a page any visitor loads
 * must not speak as the owner.
 *
 * Zero dependencies; `bun run server.ts`.
 */

const FORGE = (process.env.FORGE_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.FORGE_TOKEN ?? "";
const HERE = import.meta.dir;

export interface NowRun {
  readonly run: string;
  readonly app: string;
  readonly who: string;
  readonly on: string | null;
  readonly why: string;
  readonly state: string;
  readonly since: string;
}

const escape = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

/** Ask the forge's MCP endpoint for `now`. A failure is said, not thrown. */
export async function readNow(): Promise<NowRun[] | string> {
  if (FORGE === "" || TOKEN === "")
    return "No forge token: this page reads the forge only when the forge runs it as an app.";
  try {
    const answer = await fetch(`${FORGE}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "now", arguments: {} },
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!answer.ok) return `The forge answered ${answer.status}.`;
    const body = (await answer.json()) as {
      result?: { content?: { text?: string }[]; isError?: boolean };
    };
    const text = body.result?.content?.[0]?.text ?? "";
    if (body.result?.isError) return `The forge refused: ${text}`;
    const runs: unknown = JSON.parse(text);
    return Array.isArray(runs) ? (runs as NowRun[]) : "Unexpected answer.";
  } catch (error) {
    return `The forge did not answer: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Where a person says something about a run: its issue, on the forge. */
function sayHref(run: NowRun): string | undefined {
  const number = /^#(\d+)\b/.exec(run.on ?? "")?.[1];
  if (number === undefined || !/^[\w.-]+\/[\w.-]+$/.test(run.app))
    return undefined;
  return `${FORGE}/${run.app}/issues/${number}#say`;
}

export function renderList(now: NowRun[] | string): string {
  if (typeof now === "string") return `<li>${escape(now)}</li>`;
  if (now.length === 0) return "<li>The crew is idle.</li>";
  return now
    .map((run) => {
      const href = sayHref(run);
      return `<li>${
        href === undefined
          ? ""
          : `<a class="say" href="${escape(href)}">say</a>`
      }<span class="who">${escape(run.who)}</span> on ${escape(run.on ?? run.app)}
<div class="meta">${escape(run.app)} · ${escape(run.state)} · ${escape(run.why)} · since <time datetime="${escape(run.since)}">${escape(run.since)}</time></div></li>`;
    })
    .join("\n");
}

const page = (list: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Now — the crew</title>
<link rel="stylesheet" href="style.css">
<script src="live.js" defer></script>
</head><body>
<h1>Now</h1>
<p class="note">What the crew is doing, live from the forge. Read with this app's read-only token; <em>say</em> opens the issue on the forge.</p>
<ul id="now">${list}</ul>
</body></html>`;

const SECURITY = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
};

const html = (body: string): Response =>
  new Response(body, {
    headers: {
      ...SECURITY,
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });

/**
 * The forge's `/events`, read with the token, relayed as bare "changed"
 * frames. One upstream stream per browser, closed with it.
 */
function live(request: Request): Response {
  const upstream = new AbortController();
  request.signal.addEventListener("abort", () => upstream.abort());
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (text: string): boolean => {
        try {
          controller.enqueue(encoder.encode(text));
          return true;
        } catch {
          upstream.abort();
          return false;
        }
      };
      const ping = setInterval(() => send(": ping\n\n"), 20_000);
      send(": connected\n\n");
      try {
        if (FORGE === "" || TOKEN === "") return;
        const answer = await fetch(`${FORGE}/events`, {
          headers: {
            authorization: `Bearer ${TOKEN}`,
            accept: "text/event-stream",
          },
          signal: upstream.signal,
        });
        if (!answer.ok || answer.body === null) return;
        const decoder = new TextDecoder();
        let buffered = "";
        for await (const chunk of answer.body) {
          buffered += decoder.decode(chunk, { stream: true });
          let end: number;
          while ((end = buffered.indexOf("\n\n")) !== -1) {
            const frame = buffered.slice(0, end);
            buffered = buffered.slice(end + 2);
            if (/^event: forge$/m.test(frame) && !send("event: changed\ndata: {}\n\n"))
              return;
          }
        }
      } catch {
        // The browser left, or the forge went away; either ends this stream.
      } finally {
        clearInterval(ping);
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
    cancel() {
      upstream.abort();
    },
  });
  return new Response(stream, {
    headers: {
      ...SECURITY,
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
    },
  });
}

const asset = (name: string, type: string): Response =>
  new Response(Bun.file(`${HERE}/${name}`), {
    headers: { ...SECURITY, "content-type": type, "cache-control": "max-age=300" },
  });

export async function handle(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response("method not allowed", {
      status: 405,
      headers: { ...SECURITY, allow: "GET, HEAD" },
    });
  switch (pathname) {
    case "/":
      return html(page(renderList(await readNow())));
    case "/now":
      return html(renderList(await readNow()));
    case "/live":
      return live(request);
    case "/live.js":
      return asset("live.js", "text/javascript; charset=utf-8");
    case "/style.css":
      return asset("style.css", "text/css; charset=utf-8");
    case "/healthz":
      return new Response("ok", { headers: SECURITY });
    default:
      return new Response("not found", { status: 404, headers: SECURITY });
  }
}

if (import.meta.main) {
  Bun.serve({
    port: Number(process.env.PORT ?? 3000),
    hostname: process.env.HOST ?? "127.0.0.1",
    // Longer than the ping, so a quiet stream is never cut for idleness.
    idleTimeout: 60,
    fetch: handle,
  });
}
