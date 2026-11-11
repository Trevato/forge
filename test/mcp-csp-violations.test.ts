// An agent watching security reads CSP violations through MCP `system` `{ kind: "csp" }` (#10906).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { recordViolation, violationsByDirective } from "../src/http/csp_report.ts";
import { recordScriptError } from "../src/http/script_errors.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dir = "";
let app: App;
let servers: Servers;
let admin = "";
let member = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mcp-csp-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const mk = async (username: string, extra: Record<string, unknown> = {}) => {
    const u = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", ...extra });
    if (!u.ok) throw new Error(u.error);
    return u.value;
  };
  admin = createToken(app.db, (await mk("alice", { adminIfFirst: true })).id, "a", "ro").token;
  member = createToken(app.db, (await mk("bob")).id, "b", "admin").token;
}, 30_000);
afterAll(async () => {
  await servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

async function csp(token: string, kind: unknown = "csp"): Promise<{ isError?: boolean; body: any; text: string }> {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "system", arguments: { kind } } }),
  });
  const result = ((await res.json()) as any).result;
  const text: string = result.content[0].text;
  return { isError: result.isError, text, body: result.isError ? undefined : JSON.parse(text) };
}

const report = (directive: string, blocked: string) =>
  fetch(`${servers.url}/csp-report`, {
    method: "POST",
    headers: { "content-type": "application/csp-report", "x-forwarded-for": "10.7.7.7" },
    body: JSON.stringify({ "csp-report": { "document-uri": `${servers.url}/x`, "effective-directive": directive, "blocked-uri": blocked } }),
  });

test("a posted report is read back by directive, with its count and newest blocked host", async () => {
  // A day-old count is outside the 24 hours.
  recordViolation(app.db, { directive: "frame-src", blocked: "old.example", path: "/" }, new Date(Date.now() - 25 * 3_600_000));
  expect((await report("script-src-elem", "https://a.example/x.js")).status).toBe(204);
  expect((await report("script-src-elem", "https://a.example/x.js")).status).toBe(204);
  await Bun.sleep(5);
  expect((await report("script-src-elem", "https://b.example/y.js?secret=1")).status).toBe(204);
  expect((await report("img-src", "data:image/png;base64,AAAA")).status).toBe(204);
  const got = await csp(admin);
  expect(got.isError).toBeFalsy();
  expect(got.body).toEqual({
    hours: 24,
    since: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:00:00\.000Z$/),
    directives: [
      { directive: "script-src-elem", n: 3, newest: "b.example" },
      { directive: "img-src", n: 1, newest: "data" },
    ],
    scriptErrors: [],
  });
  recordScriptError(app.db, { page: "/claim", src: "/a.js", line: 2, msg: "boom" });
  expect((await csp(admin)).body.scriptErrors).toEqual([{ page: "/claim", where: "/a.js:2", message: "boom", n: 1, last: expect.any(String) }]);
  // The same function the security page reads.
  expect(got.body.directives).toEqual(violationsByDirective(app.db, 24));
});

test("one directive reported 25 h ago and again now counts 1 in the 24 h, not the whole UTC day", () => {
  app.db.run("DELETE FROM csp_violation");
  const now = new Date("2026-11-10T12:30:00Z");
  const v = { directive: "connect-src", blocked: "c.example", path: "/" };
  recordViolation(app.db, v, new Date(now.getTime() - 25 * 3_600_000));
  recordViolation(app.db, v, now);
  expect(violationsByDirective(app.db, 24, now)).toEqual([{ directive: "connect-src", n: 1, newest: "c.example" }]);
  // Both reports fall in the week.
  expect(violationsByDirective(app.db, 7 * 24, now)).toEqual([{ directive: "connect-src", n: 2, newest: "c.example" }]);
  // Same UTC day, 11 h apart: a 6 h window still counts only the late one.
  recordViolation(app.db, v, new Date("2026-11-10T01:00:00Z"));
  expect(violationsByDirective(app.db, 6, now)).toEqual([{ directive: "connect-src", n: 1, newest: "c.example" }]);
});

test("a non-admin is refused, and an unknown kind is invalid", async () => {
  const refused = await csp(member);
  expect(refused.isError).toBe(true);
  expect(refused.text).toContain("forbidden");
  expect(refused.text).not.toContain("a.example");
  const odd = await csp(admin, "secrets");
  expect(odd.isError).toBe(true);
  expect(odd.text).toContain("invalid");
});
