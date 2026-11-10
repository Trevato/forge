// CSP violations are reported to the forge, counted by directive, and shown on the security page (#10759).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { CSP_REPORT_MAX, parseCspReport, recordViolation, violationsByDirective } from "../src/http/csp_report.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { cspRows, entry as controlsEntry } from "../src/tui/screens/controls.ts";

let dir: string;
let app: App;
let servers: Servers;
let base: string;
let cookie = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "csp-report-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  base = `http://127.0.0.1:${servers.port}`;
  const made = await createUser(app.db, { origin: "seed", trusted: true, password: "a-good-passphrase", username: "alice", email: "alice@forge.local", isAdmin: true });
  if (!made.ok) throw new Error("no user");
  cookie = `forge_session=${createSession(app.db, made.value.id).token}`;
});
afterAll(async () => {
  await servers.stop();
  await rm(dir, { recursive: true, force: true });
});

const rows = () => app.db.query("SELECT day, directive, blocked, path, n FROM csp_violation ORDER BY directive").all() as Record<string, unknown>[];
const send = (body: string, type = "application/csp-report", headers: Record<string, string> = {}) =>
  fetch(`${base}/csp-report`, { method: "POST", headers: { "content-type": type, "x-forwarded-for": "10.9.9.9", ...headers }, body });
const legacy = (o: Record<string, unknown>) => JSON.stringify({ "csp-report": o });

describe("POST /csp-report", () => {
  test("a valid report is counted with only its directive, host and path", async () => {
    const body = legacy({
      "document-uri": `${base}/alice/secret/issues?token=abc`,
      "violated-directive": "script-src-elem 'self'",
      "effective-directive": "script-src-elem",
      "blocked-uri": "https://evil.example:8443/x.js?q=private",
      "original-policy": "default-src 'none'",
    });
    expect((await send(body)).status).toBe(204);
    expect((await send(body)).status).toBe(204);
    expect(rows()).toEqual([
      { day: new Date().toISOString().slice(0, 10), directive: "script-src-elem", blocked: "evil.example:8443", path: "/alice/secret/issues", n: 2 },
    ]);
  });

  test("the Reporting API's shape is counted too", async () => {
    const body = JSON.stringify([
      { type: "csp-violation", body: { documentURL: `${base}/`, effectiveDirective: "style-src-attr", blockedURL: "inline" } },
    ]);
    expect((await send(body, "application/reports+json")).status).toBe(204);
    expect(rows().find((r) => r.directive === "style-src-attr")).toMatchObject({ blocked: "inline", path: "/", n: 1 });
  });

  test("oversized, malformed, wrong-type or foreign reports are 4xx and store nothing", async () => {
    const before = JSON.stringify(rows());
    const big = legacy({ "document-uri": `${base}/`, "violated-directive": "img-src", "blocked-uri": "https://x.example/" + "a".repeat(CSP_REPORT_MAX) });
    expect((await send(big)).status).toBe(413);
    expect((await send("{not json")).status).toBe(400);
    expect((await send(JSON.stringify({ hello: 1 }))).status).toBe(400);
    expect((await send(legacy({ "document-uri": `${base}/`, "violated-directive": "<script>", "blocked-uri": "inline" }))).status).toBe(400);
    expect((await send(legacy({ "document-uri": "not a url", "violated-directive": "img-src", "blocked-uri": "inline" }))).status).toBe(400);
    const ok = legacy({ "document-uri": `${base}/`, "violated-directive": "img-src", "blocked-uri": "inline" });
    expect((await send(ok, "text/plain")).status).toBe(415);
    expect((await send(ok, "application/csp-report", { origin: "https://elsewhere.example" })).status).toBe(403);
    expect(JSON.stringify(rows())).toBe(before);
  });

  test("an anonymous caller is rate limited", async () => {
    const ok = legacy({ "document-uri": `${base}/`, "violated-directive": "font-src", "blocked-uri": "data" });
    const statuses: number[] = [];
    for (let i = 0; i < 35; i++) statuses.push((await send(ok, "application/csp-report", { "x-forwarded-for": "10.7.7.7" })).status);
    expect(statuses).toContain(429);
  });
});

describe("the policy names the endpoint", () => {
  test("a normal page carries report-uri and Reporting-Endpoints without loosening", async () => {
    const res = await fetch(`${base}/explore`);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("report-uri /csp-report");
    expect(csp).toContain("report-to csp");
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("unsafe");
    expect(res.headers.get("reporting-endpoints")).toBe('csp="/csp-report"');
  });

  test("a non-document answer's floor policy stays bare: an app's host could not count a relative report", async () => {
    const res = await fetch(`${base}/api/v1/nothing-here`);
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  });
});

describe("the security page", () => {
  test("one quiet line by directive this week, and nothing when there are none", async () => {
    const page = async () => (await fetch(`${base}/settings/security`, { headers: { cookie } })).text();
    app.db.run("DELETE FROM csp_violation");
    expect(await page()).not.toContain('id="csp"');
    const now = new Date();
    recordViolation(app.db, { directive: "img-src", blocked: "x.example", path: "/" }, now);
    recordViolation(app.db, { directive: "img-src", blocked: "y.example", path: "/a" }, now);
    recordViolation(app.db, { directive: "frame-src", blocked: "z.example", path: "/" }, new Date(now.getTime() - 10 * 86_400_000));
    expect(violationsByDirective(app.db, 7, now)).toEqual([{ directive: "img-src", n: 2 }]);
    const html = await page();
    expect(html).toContain('id="csp"');
    expect(html).toMatch(/<span class="mono">img-src<\/span> 2/);
    expect(html).not.toContain("frame-src");
  });

  test("a parse never keeps a query string", () => {
    const got = parseCspReport(legacy({ "document-uri": "https://f.example/p?x=1#h", "violated-directive": "img-src", "blocked-uri": "https://h.example/i.png?k=v" }));
    expect(got).toEqual([{ directive: "img-src", blocked: "h.example", path: "/p" }]);
  });
});

describe("the terminal's security controls screen", () => {
  test("lists the week's counts by directive, and nothing when there are none", () => {
    app.db.run("DELETE FROM csp_violation");
    const now = Date.now();
    expect(cspRows(app.db, now)).toEqual([]);
    recordViolation(app.db, { directive: "script-src-elem", blocked: "inline", path: "/" }, new Date(now));
    recordViolation(app.db, { directive: "script-src-elem", blocked: "inline", path: "/" }, new Date(now));
    recordViolation(app.db, { directive: "frame-src", blocked: "z.example", path: "/" }, new Date(now - 10 * 86_400_000));
    expect(cspRows(app.db, now)).toEqual([{ title: "Blocked by the page policy: script-src-elem", secondary: "", meta: "2 in 7 days" }]);
  });

  test("the screen is a human admin's only", () => {
    const session = (user: unknown) => ({ user }) as never;
    expect(controlsEntry.offered(session({ isAdmin: true, kind: "human" }))).toBe(true);
    expect(controlsEntry.offered(session({ isAdmin: true, kind: "agent" }))).toBe(false);
    expect(controlsEntry.offered(session({ isAdmin: false, kind: "human" }))).toBe(false);
    expect(controlsEntry.offered(session(undefined))).toBe(false);
  });
});
