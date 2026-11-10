/**
 * The Muse test, end to end (#10383): a stranger agent opens a public app's
 * door, reads only what the door says (its `Link` headers, the forge's
 * `/.well-known/mcp.json` and `/llms.txt`), and files a report with no
 * account, over HTTP and then over the MCP `report` tool. A person who
 * writes the repository finds both marked as a stranger's, with the page
 * they came from. A private app's door offers nothing and names nothing.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { AppsRuntime, type EnvStatus } from "../src/apps/runtime.ts";
import { OUTSIDE_LABEL } from "../src/core/reports.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const DOMAIN = "apps.test";

/** The target of the first link relation `rel` in a `Link` header. */
const linkTo = (res: Response, rel: string): string | undefined =>
  (res.headers.get("link") ?? "")
    .split(",")
    .map((part) => /<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(part.trim()))
    .find((m) => m?.[2] === rel)?.[1];

describe("the Muse test: a stranger agent needs no teaching", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let backend: ReturnType<typeof Bun.serve>;
  let status: ReturnType<typeof spyOn>;
  let token = "";
  let source = 0;
  const from = () => ({ "x-forwarded-for": `198.51.100.${++source}` });

  beforeAll(async () => {
    backend = Bun.serve({
      port: 0,
      fetch: () =>
        new Response("<html><body>hi</body></html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    });
    dataDir = await mkdtemp(join(tmpdir(), "forge-muse-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    servers = await serve(app);
    runtime = new AppsRuntime(app, {
      domain: DOMAIN,
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      concurrency: 1,
    });
    await runtime.start();
    status = spyOn(AppsRuntime.prototype, "envStatus").mockImplementation(
      () =>
        ({
          env: "production",
          state: "running",
          port: backend.port,
          commitOid: "a".repeat(40),
        }) as EnvStatus,
    );
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    token = createToken(app.db, a.value.id, "t", "rw").token;
    for (const [name, visibility] of [
      ["notes", "public"],
      ["diary", "private"],
    ] as const) {
      const made = await newApp(app, a.value, { name, description: "Words", visibility });
      if (!made.ok) throw new Error(String(made.error));
    }
  }, 120_000);

  afterAll(async () => {
    status.mockRestore();
    await runtime.stop();
    servers.stop();
    backend.stop(true);
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const door = (slug: string, path: string) =>
    fetch(`${servers.url}${path}`, {
      headers: { host: `${slug}.${DOMAIN}`, accept: "text/html" },
      redirect: "manual",
    });
  const owner = (path: string, init: RequestInit = {}) =>
    fetch(`${servers.url}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
    });
  const rpc = (payload: unknown, headers: Record<string, string> = from()) =>
    fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(payload),
    });
  const pending = (): number =>
    (app.db.query("SELECT count(*) AS n FROM report WHERE state = 'pending'").get() as { n: number }).n;

  test("reading only the door, the forge's card and llms.txt, a stranger files over HTTP and over the MCP", async () => {
    const page = "http://notes.apps.test/leaderboard";

    // 1. The door's own headers.
    const first = await door("notes", "/leaderboard");
    const help = linkTo(first, "help");
    expect(help).toBe("/__forge/report");
    const manifest = linkTo(first, "alternate")!;
    expect(manifest).toStartWith(`${servers.url}/api/v1/here`);

    // 2. The manifest names the report action, HTTP and MCP, as needing no account.
    const here = (await (await fetch(manifest)).json()) as any;
    const act = here.can.find((x: any) => x.do === "report a problem");
    expect(act.http).toBe("POST /api/v1/repos/alice/notes/reports");
    expect(act.mcp).toBe("report");
    expect(act.account).toBe(false);

    // 3. The server card lists the tool as open, and says where the MCP is.
    const card = (await (await fetch(`${servers.url}/.well-known/mcp.json`)).json()) as any;
    expect(card.tokenFreeTools).toContain("report");
    const tool = card.tokenFreeTools.find((t: string) => t === "report");
    expect(card.documentation).toBe(`${servers.url}/llms.txt`);
    const llms = await (await fetch(card.documentation)).text();
    expect(llms).toContain("POST " + servers.url + "/api/v1/repos/{owner}/{name}/reports");
    expect(llms).toContain("report");

    // 4. rel=help leads to the form, told which page the visitor came from.
    const helped = await door("notes", `${help}?from=/leaderboard`);
    expect(helped.status).toBe(303);
    const form = new URL(helped.headers.get("location")!);
    expect(form.pathname).toBe("/alice/notes/report");
    expect(form.searchParams.get("from")).toStartWith("http://notes.apps.test");
    expect((await fetch(form)).status).toBe(200);

    // 5. HTTP, no token.
    const before = pending();
    const http = await fetch(`${servers.url}/api/v1/repos/alice/notes/reports`, {
      method: "POST",
      headers: { "content-type": "application/json", ...from() },
      body: JSON.stringify({ title: "Leaderboard is empty", body: "HTTP report", page }),
    });
    expect(http.status).toBe(202);
    const httpId = ((await http.json()) as any).id as string;

    // 6. MCP, no token; `report` is the one tool the card lists as open.
    const call = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: tool,
        arguments: { repo: "alice/notes", title: "Leaderboard is slow", body: "MCP report", page },
      },
    });
    expect(call.status).toBe(200);
    const mcpId = JSON.parse(((await call.json()) as any).result.content[0].text).id as string;
    expect(pending()).toBe(before + 2);

    // 7. Both wait as a stranger's words, with the page, until a person decides.
    const listed = (await (await owner("/api/v1/repos/alice/notes/reports")).json()) as any;
    const items: any[] = listed.items ?? listed;
    for (const id of [httpId, mcpId]) {
      const r = items.find((x) => x.id === id);
      expect(r.untrusted).toBe(true);
      expect(r.from).toBe("outside");
      expect(r.page).toBe(page);
    }

    // 8. Accepted, each is an issue behind the outside marker, naming the page.
    for (const id of [httpId, mcpId]) {
      const accepted = await owner(`/api/v1/repos/alice/notes/reports/${id}/accept`, {
        method: "POST",
        body: "{}",
      });
      expect(accepted.status).toBe(201);
      const issue = (await accepted.json()) as any;
      expect(issue.title).toContain("Leaderboard");
      expect(issue.body).toContain(`Sent from: ${page}`);
      expect(issue.body).toContain("without an account");
      expect(JSON.stringify(issue.labels ?? [])).toContain(OUTSIDE_LABEL);
    }
  });

  test("the open door keeps its rate limit and its body cap", async () => {
    const before = pending();
    const one = { "x-forwarded-for": "203.0.113.77" };
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${servers.url}/api/v1/repos/alice/notes/reports`, {
        method: "POST",
        headers: { "content-type": "application/json", ...one },
        body: JSON.stringify({ title: `t${i}` }),
      });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([202, 202, 202, 429, 429]);
    // The MCP tool is the same door and the same source, so the same limit.
    const limited = (await (
      await rpc(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "report", arguments: { repo: "alice/notes", title: "x" } },
        },
        one,
      )
    ).json()) as any;
    expect(limited.result.isError).toBe(true);
    expect(limited.result.content[0].text.toLowerCase()).toMatch(/rate|limit|too_many|many/);
    const huge = await fetch(`${servers.url}/api/v1/repos/alice/notes/reports`, {
      method: "POST",
      headers: { "content-type": "application/json", ...from() },
      body: JSON.stringify({ title: "t", body: "x".repeat(70_000) }),
    });
    expect(huge.status).toBe(413);
    const hugeMcp = await rpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "report", arguments: { repo: "alice/notes", title: "t", body: "x".repeat(70_000) } },
    });
    expect(hugeMcp.status).toBe(413);
    expect(pending()).toBe(before + 3);
  });

  test("a private app's door answers neither route and leaks no repository name", async () => {
    const res = await door("diary", "/");
    const seen = [res.headers.get("link") ?? "", await res.text()].join("\n");
    expect(seen).not.toContain("__forge/report");
    expect(seen).not.toContain("alice/diary");
    expect(linkTo(res, "help")).toBeUndefined();

    const route = await door("diary", "/__forge/report");
    expect(route.headers.get("location") ?? "").not.toContain("/report");
    expect(await route.text()).not.toContain("alice/diary");

    const before = pending();
    const api = await fetch(`${servers.url}/api/v1/repos/alice/diary/reports`, {
      method: "POST",
      headers: { "content-type": "application/json", ...from() },
      body: JSON.stringify({ title: "hello" }),
    });
    expect(api.status).toBe(404);
    const viaMcp = (await (
      await rpc({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "report", arguments: { repo: "alice/diary", title: "hello" } },
      })
    ).json()) as any;
    expect(viaMcp.result.isError).toBe(true);
    expect(viaMcp.result.content[0].text).toStartWith("not_found");
    expect(pending()).toBe(before);

    const llms = await (await fetch(`${servers.url}/llms.txt`)).text();
    expect(llms).not.toContain("diary");
    const card = await (await fetch(`${servers.url}/.well-known/mcp.json`)).text();
    expect(card).not.toContain("diary");
  });
});
