// The front door of one forge: a Worker that hands every request to the
// forge's Durable Object, which forwards it to the body (BODY_URL) and
// answers /healthz itself when the body is asleep. No dependencies.

const HOP = ["host", "cf-connecting-ip", "x-forwarded-host"];

/** The request the body sees: same path and query, the body's origin, the public scheme told. */
export function forward(request, bodyUrl) {
  const from = new URL(request.url);
  const to = new URL(from.pathname + from.search, bodyUrl);
  const headers = new Headers(request.headers);
  for (const h of HOP) headers.delete(h);
  headers.set("x-forwarded-proto", "https");
  headers.set("x-forwarded-host", from.host);
  const init = { method: request.method, headers, redirect: "manual" };
  if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;
  return new Request(to, init);
}

export class Forge {
  constructor(state, env) {
    this.env = env;
  }
  async fetch(request) {
    try {
      return await fetch(forward(request, this.env.BODY_URL));
    } catch {
      const { pathname } = new URL(request.url);
      if (pathname === "/healthz")
        return Response.json({ ok: false, body: "unreachable" }, { status: 503 });
      return new Response("the forge's body is not answering\n", { status: 502 });
    }
  }
}

export default {
  fetch(request, env) {
    const id = env.FORGE.idFromName("forge");
    return env.FORGE.get(id).fetch(request);
  },
};
