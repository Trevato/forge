import { afterEach, expect, test } from "bun:test";
import { runDrill } from "../scripts/drills/run.ts";

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => server?.stop(true));

interface Stub {
  down: boolean;
  posts: { auth: string | null; body: unknown }[];
  refuse: boolean;
  /** `/` answers a sign-in redirect while up. */
  redirect?: boolean;
  hits?: number;
}

function stub(state: Stub): string {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/api/v1/health")
        return state.down
          ? Response.json({ ok: false, note: "Disk is nearly full: 97%", tick: `up ${(state.hits = (state.hits ?? 0) + 1)}s` }, { status: 503 })
          : Response.json({ ok: true });
      if (path === "/")
        return state.down
          ? new Response("<p>The runner is stuck</p>", { status: 503, headers: { "content-type": "text/html" } })
          : state.redirect
          ? new Response(null, { status: 302, headers: { location: "/sign-in" } })
          : new Response("<p>fine</p>", { headers: { "content-type": "text/html" } });
      if (path === "/api/v1/drills") {
        state.posts.push({ auth: req.headers.get("authorization"), body: await req.json() });
        return state.refuse
          ? Response.json({ error: "forbidden", message: "admins only" }, { status: 403 })
          : Response.json({ id: 1, green: true, why: "every phrase seen" }, { status: 201 });
      }
      return new Response("no", { status: 404 });
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

function harness(state: Stub, extra: { ceilingMs?: number } = {}) {
  const lines: string[] = [];
  let t = 0;
  let sleeps = 0;
  const run = (domain: string, forge: string) =>
    runDrill({
      domain,
      forge,
      token: "tok",
      say: (l) => lines.push(l),
      enter: async () => { state.down = true; },
      now: () => t,
      sleep: async (ms) => {
        t += ms;
        sleeps++;
        if (sleeps === 3 && !extra.ceilingMs) state.down = false;
      },
      intervalMs: 1000,
      ceilingMs: extra.ceilingMs ?? 60_000,
    });
  return { lines, run };
}

test("goes down and comes back: posts what it saw and prints the verdict", async () => {
  const state: Stub = { down: false, posts: [], refuse: false };
  const h = harness(state);
  const code = await h.run("runner", stub(state));
  expect(code).toBe(0);
  expect(state.posts).toHaveLength(1);
  expect(state.posts[0]!.auth).toBe("Bearer tok");
  const body = state.posts[0]!.body as { domain: string; seen: { health: string; board: string }; backSeconds: number };
  expect(body.domain).toBe("runner");
  expect(body.seen.health).toContain("Disk is nearly full: 97%");
  expect(body.seen.board).toContain("The runner is stuck");
  expect(body.backSeconds).toBe(3);
  expect(h.lines.filter((l) => l.includes("The runner is stuck"))).toHaveLength(1);
  expect(h.lines).toContain("GREEN: every phrase seen");
});

test("stays down past the ceiling: posts nothing, exits 0, says so", async () => {
  const state: Stub = { down: false, posts: [], refuse: false };
  const h = harness(state, { ceilingMs: 5_000 });
  const code = await h.run("runner", stub(state));
  expect(code).toBe(0);
  expect(state.posts).toHaveLength(0);
  expect(h.lines.some((l) => l.includes("did not come back within the ceiling of 5s"))).toBe(true);
  const last = JSON.parse(h.lines.at(-1)!);
  expect(last).toEqual({ domain: "runner", backSeconds: null, posted: false, ceilingSeconds: 5 });
});

test("a refused post prints the forge's message and exits non-zero", async () => {
  const state: Stub = { down: false, posts: [], refuse: true };
  const h = harness(state);
  const code = await h.run("runner", stub(state));
  expect(code).toBe(1);
  expect(h.lines.some((l) => l.includes("403") && l.includes("admins only"))).toBe(true);
});

test("an unknown domain and a domain with no drill are refused before anything is asked", async () => {
  const state: Stub = { down: false, posts: [], refuse: false };
  const h = harness(state);
  expect(await h.run("nope", stub(state))).toBe(1);
  expect(await h.run("state", stub(state))).toBe(1);
  expect(h.lines.some((l) => l.includes("no drill"))).toBe(true);
  expect(state.down).toBe(false);
  expect(state.posts).toHaveLength(0);
});

test("a sign-in redirect from / is up, and a changing counter is one line", async () => {
  const state: Stub = { down: false, posts: [], refuse: false, redirect: true };
  const h = harness(state);
  expect(await h.run("runner", stub(state))).toBe(0);
  expect(state.posts).toHaveLength(1);
  expect(h.lines.filter((l) => l.startsWith("health: up "))).toHaveLength(1);
});
