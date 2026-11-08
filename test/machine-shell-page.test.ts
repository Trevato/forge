/**
 * The machine shell page (#9472): a writer gets a terminal page at the
 * socket's own path, a reader is refused it; the machines list offers "Open
 * shell"; the page alone admits WebAssembly in its CSP and carries the
 * security floor; the terminal's script and WebAssembly are served immutable,
 * the script without the vendored module's inlined copy of the WebAssembly.
 * The wiring sends one resize frame per settled size, and a reattached
 * connection's first size redraws the screen (`resizePlan`).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { resizePlan, RESIZE } from "../src/machines/shell.ts";
import { closedWords, resizeFrame, wire, type Size, type Term } from "../src/web/machine-term-wire.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let app: App;
let servers: Servers;
const cookies: Record<string, string> = {};

async function person(name: string): Promise<string> {
  const made = await createUser(app.db, { username: name, email: `${name}@x.test`, password: "correct horse battery", origin: "seed", trusted: true });
  if (!made.ok) throw new Error(String(made.error));
  cookies[name] = `forge_session=${createSession(app.db, made.value.id).token}`;
  return made.value.id;
}

beforeAll(async () => {
  app = createApp({ dataDir: mkdtempSync(join(tmpdir(), "machine-shell-page-")), port: 0 });
  const alice = await person("alice");
  await person("bob");
  for (const [name, visibility] of [["lab", "public"], ["shut", "private"]] as const) {
    const made = await createRepo(app.db, app.reposRoot, { ownerId: alice, name, visibility });
    if (!made.ok) throw new Error(String(made.error));
  }
  servers = await serve(app);
});

afterAll(() => {
  servers.stop();
  app.close();
});

const get = (path: string, who?: string) =>
  fetch(`${servers.url}${path}`, { headers: who === undefined ? {} : { cookie: cookies[who]! } });

test("a writer gets the terminal page, its CSP admitting WebAssembly and nothing looser", async () => {
  const res = await get("/alice/lab/machines/standard/shell", "alice");
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain('id="machine-term"');
  expect(body).toMatch(/data-wasm="\/assets\/ghostty-vt-[0-9a-f]{16}\.wasm"/);
  // Without JavaScript nothing connects: the server never claims to be
  // connecting, and a noscript line says what the shell needs.
  expect(body).not.toContain("Connecting");
  expect(body).toMatch(/<noscript>[^]*needs JavaScript[^]*<\/noscript>/);
  expect(body).toMatch(/<script type="module" src="\/assets\/machine-term-[0-9a-f]{16}\.js"><\/script>/);
  const csp = res.headers.get("content-security-policy") ?? "";
  expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval';");
  expect(csp).not.toContain("unsafe-inline");
  expect(csp).not.toContain("'unsafe-eval'");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("referrer-policy")).toBe("same-origin");
});

test("a reader is refused the page; a stranger to a private repository and an undeclared machine get 404", async () => {
  expect((await get("/alice/lab/machines/standard/shell", "bob")).status).toBe(403);
  expect((await get("/alice/lab/machines/standard/shell")).status).toBe(403);
  expect((await get("/alice/shut/machines/standard/shell", "bob")).status).toBe(404);
  expect((await get("/alice/lab/machines/nope/shell", "alice")).status).toBe(404);
});

test("the machines list offers Open shell, and its own CSP admits no WebAssembly", async () => {
  const res = await get("/alice/lab/settings/machines", "alice");
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain('href="/alice/lab/machines/standard/shell"');
  expect(body).toContain("Open shell");
  expect(res.headers.get("content-security-policy")).not.toContain("wasm-unsafe-eval");
});

test("the terminal's script and WebAssembly are immutable, and the script carries no inlined WebAssembly", async () => {
  const page = await (await get("/alice/lab/machines/standard/shell", "alice")).text();
  const script = page.match(/\/assets\/machine-term-[0-9a-f]{16}\.js/)![0];
  const wasm = page.match(/\/assets\/ghostty-vt-[0-9a-f]{16}\.wasm/)![0];
  const js = await get(script);
  expect(js.status).toBe(200);
  expect(js.headers.get("cache-control")).toContain("immutable");
  const code = await js.text();
  expect(code).not.toContain("application/wasm;base64");
  expect(code.length).toBeLessThan(200_000);
  const bin = await get(wasm);
  expect(bin.status).toBe(200);
  expect(bin.headers.get("content-type")).toBe("application/wasm");
  expect(bin.headers.get("cache-control")).toContain("immutable");
  expect([...new Uint8Array(await bin.arrayBuffer()).slice(0, 4)]).toEqual([0, 0x61, 0x73, 0x6d]);
  expect((await get("/assets/ghostty-vt-0000000000000000.wasm")).status).toBe(404);
  expect((await get("/assets/machine-term-0000000000000000.js")).status).toBe(404);
});

/** A terminal whose box is whatever size the test says. */
function fakeTerm(): { term: Term; box: { size: Size }; typed: (text: string) => void; written: Uint8Array[] } {
  const box = { size: { cols: 80, rows: 24 } as Size };
  const written: Uint8Array[] = [];
  let listener: (text: string) => void = () => {};
  return {
    box,
    written,
    typed: (text) => listener(text),
    term: {
      write: (bytes) => written.push(bytes),
      onData: (l) => {
        listener = l;
      },
      resize: () => {},
      fit: () => box.size,
    },
  };
}

test("the wiring sends the size on open, one frame per new size, and keystrokes only while open", () => {
  const { term, box, typed, written } = fakeTerm();
  const frames: (string | Uint8Array)[] = [];
  const said: string[] = [];
  const wired = wire(term, (f) => frames.push(f), (w) => said.push(w));
  typed("early");
  expect(frames).toEqual([]);
  wired.opened();
  expect(frames).toEqual([resizeFrame({ cols: 80, rows: 24 })]);
  // A window dragged: many refits, one settled size, one frame.
  box.size = { cols: 120, rows: 40 };
  wired.refit();
  wired.refit();
  wired.refit();
  expect(frames.filter((f) => typeof f === "string")).toEqual([
    '{"type":"resize","cols":80,"rows":24}',
    '{"type":"resize","cols":120,"rows":40}',
  ]);
  typed("ls\r");
  expect(new TextDecoder().decode(frames.at(-1) as Uint8Array)).toBe("ls\r");
  wired.received(new Uint8Array([104, 105]));
  expect(written).toHaveLength(1);
  wired.closed(1011, "this forge cannot hold a machine's shell");
  expect(said.at(-1)).toBe("Disconnected: this forge cannot hold a machine's shell. Reload to reattach.");
  const count = frames.length;
  typed("late");
  box.size = { cols: 100, rows: 30 };
  wired.refit();
  expect(frames).toHaveLength(count);
  expect(closedWords(1000, "")).toBe("Disconnected: the shell exited. Reload to reattach.");
});

test("a joining connection's first size redraws the screen; a new size is set once; a repeat changes nothing", () => {
  const at = { cols: 80, rows: 24 };
  expect(resizePlan(at, { cols: 100, rows: 30 }, true)).toEqual([{ cols: 100, rows: 30 }]);
  expect(resizePlan(at, { cols: 100, rows: 30 }, false)).toEqual([{ cols: 100, rows: 30 }]);
  expect(resizePlan(at, { cols: 80, rows: 24 }, true)).toEqual([{ cols: 80, rows: 23 }, { cols: 80, rows: 24 }]);
  expect(resizePlan(at, { cols: 80, rows: 24 }, false)).toEqual([]);
  const one = { cols: 80, rows: RESIZE.rows.min };
  expect(resizePlan(one, one, true)).toEqual([{ cols: 80, rows: 2 }, one]);
});

test("Settings › Machines is headed sections of rows, never a card (#9788)", async () => {
  const body = await (await get("/alice/lab/settings/machines", "alice")).text();
  const main = body.slice(body.indexOf("<main"), body.indexOf("</main>"));
  expect(main).toContain('<section class="settings-block">');
  expect(main).toContain("<h2>Machines</h2>");
  expect(main).toContain("<h2>Last sessions</h2>");
  const machines = main.slice(main.indexOf('id="machines"'));
  expect(machines.slice(0, machines.indexOf("</ul>"))).toContain('class="row-title"');
  expect(main).toContain('data-machine="standard"');
  expect(main).toContain('href="/alice/lab/machines/standard/shell"');
  expect(main).toContain("No shell has been opened here yet.");
  for (const boxed of ['class="card', "card-head", "card-body", "<table"]) expect(main).not.toContain(boxed);
});
