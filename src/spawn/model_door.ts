/**
 * The model endpoint a parent lends a child (#10484): `POST /v1/messages`
 * and `GET /api/v1/credit` on the beat door. The child's crew presents the
 * bearer the parent minted for it; the parent forwards the call on its own
 * credential, which the child never holds, counts the reply's usage at list
 * price (`spawn/list_price.ts`) against the child's dollar cap
 * (`spawn/credit.ts`), and refuses the next call once the cap is spent.
 * This is a path through the parent: it opens no egress for the child, and
 * the only host it reaches is the one the parent's own credential names.
 * A call in flight when the cap runs out finishes and is counted, and at most
 * `MAX_IN_FLIGHT` calls run at once per child (`spawn/door_guard.ts`), so the
 * spend can pass the cap by no more than what those calls cost.
 */

import type { App } from "../app.ts";
import { addSpend, creditOfToken, leftUsd, readCredit, spentWords, type Credit } from "./credit.ts";
import { listPriceUsd, NO_USAGE, type Usage } from "./list_price.ts";
import { readCapped } from "./bounded_read.ts";
import { enter, MAX_IN_FLIGHT, noteBad } from "./door_guard.ts";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Where the parent's own credential points: a base URL and the headers that carry it. */
export interface ModelUpstream {
  readonly base: string;
  readonly headers: Record<string, string>;
}

export interface ModelDeps {
  readonly fetch?: FetchLike;
  readonly upstream?: () => ModelUpstream | undefined;
}

/** The parent's own credential from its environment, never from a request. */
export function ownUpstream(): ModelUpstream | undefined {
  const base = (process.env["ANTHROPIC_BASE_URL"] ?? "https://api.anthropic.com").replace(/\/+$/, "");
  const key = process.env["ANTHROPIC_API_KEY"];
  const auth = process.env["ANTHROPIC_AUTH_TOKEN"];
  const oauth = process.env["CLAUDE_CODE_OAUTH_TOKEN"];
  if (key !== undefined && key !== "") return { base, headers: { "x-api-key": key } };
  if (auth !== undefined && auth !== "") return { base, headers: { authorization: `Bearer ${auth}` } };
  if (oauth !== undefined && oauth !== "")
    return { base, headers: { authorization: `Bearer ${oauth}`, "anthropic-beta": "oauth-2025-04-20" } };
  return undefined;
}

export const MODEL_BODY_MAX = 16 * 1024 * 1024;

const refuse = (status: number, type: string, message: string): Response =>
  Response.json({ type: "error", error: { type, message } }, { status });

function bearerOf(req: Request): string {
  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S{8,200})$/i.exec(auth);
  return m?.[1] ?? req.headers.get("x-api-key") ?? "";
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

function usageOf(u: unknown, into: Usage): Usage {
  if (typeof u !== "object" || u === null) return into;
  const r = u as Record<string, unknown>;
  return {
    inputTokens: "input_tokens" in r ? num(r["input_tokens"]) : into.inputTokens,
    outputTokens: "output_tokens" in r ? num(r["output_tokens"]) : into.outputTokens,
    cacheWriteTokens: "cache_creation_input_tokens" in r ? num(r["cache_creation_input_tokens"]) : into.cacheWriteTokens,
    cacheReadTokens: "cache_read_input_tokens" in r ? num(r["cache_read_input_tokens"]) : into.cacheReadTokens,
  };
}

/** Reads usage out of a server-sent stream as it passes: `message_start` carries the input, `message_delta` the output so far. */
class Tally {
  usage: Usage = NO_USAGE;
  model = "";
  private buf = "";
  private readonly dec = new TextDecoder();

  feed(chunk: Uint8Array): void {
    this.buf += this.dec.decode(chunk, { stream: true });
    let at: number;
    while ((at = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, at).trimEnd();
      this.buf = this.buf.slice(at + 1);
      if (!line.startsWith("data:")) continue;
      try {
        const ev = JSON.parse(line.slice(5)) as { type?: unknown; message?: { model?: unknown; usage?: unknown }; usage?: unknown };
        if (ev.type === "message_start") {
          if (typeof ev.message?.model === "string") this.model = ev.message.model;
          this.usage = usageOf(ev.message?.usage, this.usage);
        } else if (ev.type === "message_delta") this.usage = usageOf(ev.usage, this.usage);
      } catch {
        // not an event we count
      }
    }
    if (this.buf.length > 1_000_000) this.buf = "";
  }
}

/** Counts a reply as it passes and gives the call's place back when it ends, however it ends. */
function meter(app: App, credit: Credit, fetched: Response, release: () => void): Response {
  const type = fetched.headers.get("content-type") ?? "";
  const headers = new Headers({ "content-type": type || "application/json" });
  // A refusal or an error from the provider is not a call that was served: nothing is charged.
  if (!fetched.ok || fetched.body === null) {
    release();
    return new Response(fetched.body, { status: fetched.status, headers });
  }
  const streamed = type.includes("text/event-stream");
  const reader = fetched.body.getReader();
  const tally = new Tally();
  const dec = new TextDecoder();
  let text = "";
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    release();
    if (streamed) return void addSpend(app, credit.name, listPriceUsd(tally.model, tally.usage));
    try {
      const doc = JSON.parse(text) as { model?: unknown; usage?: unknown };
      addSpend(app, credit.name, listPriceUsd(typeof doc.model === "string" ? doc.model : "", usageOf(doc.usage, NO_USAGE)));
    } catch {
      // an unreadable answer is not counted; the provider's own ledger is the check
    }
  };
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(c) {
        try {
          const { done: end, value } = await reader.read();
          if (end) {
            finish();
            c.close();
            return;
          }
          if (streamed) tally.feed(value);
          else if (text.length < MODEL_BODY_MAX) text += dec.decode(value, { stream: true });
          c.enqueue(value);
        } catch (e) {
          finish();
          c.error(e);
        }
      },
      // The client left: what the provider already said is still owed.
      cancel(why) {
        finish();
        return reader.cancel(why);
      },
    }),
    { status: fetched.status, headers },
  );
}

/**
 * `POST /v1/messages`: one lent model call. The bearer is checked before a
 * byte of the body is read; the body is then read by bytes arrived, at most
 * `MODEL_BODY_MAX`.
 */
export async function lendModel(app: App, req: Request, deps: ModelDeps = {}): Promise<Response> {
  const credit = creditOfToken(app, bearerOf(req));
  if (credit === undefined)
    return noteBad(app) ? refuse(429, "rate_limit_error", "too many keys this forge does not fund; slow down") : refuse(401, "authentication_error", "this forge does not fund that key");
  if (readCredit(app, credit.name)!.spentUsd >= credit.capUsd)
    return refuse(402, "billing_error", spentWords(credit.name, credit.capUsd));
  const own = (deps.upstream ?? ownUpstream)();
  if (own === undefined) return refuse(503, "api_error", "the parent has no model credential to lend");
  // Checked and taken with no await between, so parallel calls cannot all pass.
  const release = enter(app, credit.name);
  if (release === undefined) return refuse(429, "rate_limit_error", `${credit.name} has ${MAX_IN_FLIGHT} calls under way; wait for one to finish`);
  let handed = false;
  try {
    const raw = await readCapped(req, MODEL_BODY_MAX);
    if (raw === undefined) return refuse(413, "invalid_request_error", "request too large");
    const headers: Record<string, string> = { "content-type": "application/json", "anthropic-version": req.headers.get("anthropic-version") ?? "2023-06-01" };
    const beta = [req.headers.get("anthropic-beta"), own.headers["anthropic-beta"]].filter((b): b is string => !!b && /^[\w.,-]{1,300}$/.test(b));
    Object.assign(headers, own.headers);
    if (beta.length > 0) headers["anthropic-beta"] = beta.join(",");
    let fetched: Response;
    try {
      fetched = await (deps.fetch ?? fetch)(`${own.base}/v1/messages`, { method: "POST", headers, body: raw, redirect: "error" });
    } catch {
      return refuse(502, "api_error", "the parent could not reach its model provider");
    }
    handed = true;
    return meter(app, credit, fetched, release);
  } finally {
    if (!handed) release();
  }
}

/** `GET /api/v1/credit`: what the bearer's child may spend and has. */
export function creditAnswer(app: App, req: Request): Response {
  const credit = creditOfToken(app, bearerOf(req));
  if (credit === undefined)
    return noteBad(app) ? refuse(429, "rate_limit_error", "too many keys this forge does not fund; slow down") : refuse(401, "authentication_error", "this forge does not fund that key");
  return Response.json({ capUsd: credit.capUsd, spentUsd: credit.spentUsd, leftUsd: leftUsd(credit) });
}
