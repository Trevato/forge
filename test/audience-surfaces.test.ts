/**
 * The page, the API and the MCP say the same sentence about who can see a
 * repository (#809); the wording itself is tested in audience.test.ts.
 */
import { proveAll } from "./helpers/verified.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { audienceFor } from "../src/core/audience.ts";
import { createApp as makeApp } from "../src/core/apps.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The audience line of a page: the settings link if any, the Split badge if any, and the sentence. */
function audienceOn(page: string) {
  const m = /<p class="muted small"\s*>\s*(?:<span\s+class="badge"\s+data-variant="attn"\s*>(Split)<\/span\s*>)?\s*(?:<a href="([^"]*)"\s*>)?([^<]*Public: anyone[^<]*|The code is public[^<]*)(?:<\/a\s*>)?\s*<\/p\s*>/.exec(page);
  if (m === null) throw new Error("no audience line on the page");
  return { badge: m[1], href: m[2], text: m[3]!.trim() };
}

describe("one sentence on every surface", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let olive: User;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-audience-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const made = await createUser(app.db, {
      origin: "seed",
      username: "olive",
      email: "olive@f.dev",
      password: "a-good-passphrase",
      isAdmin: true,
    });
    if (!made.ok) throw new Error(made.error);
    olive = made.value;
    proveAll(app);
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the API and the MCP say the same words, and the page shows them", async () => {
    const made = await createRepo(app, olive, { name: "garden", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    makeApp(app.db, { repoId: made.value.id, slug: "garden", access: "private" });
    const token = createToken(app.db, olive.id, "t", "ro").token;
    const auth = { authorization: `Bearer ${token}` };
    const res = await fetch(`${servers.url}/api/v1/repos/olive/garden`, { headers: auth });
    const body = (await res.json()) as { audience: { level: string; sentence: string } };
    expect(body.audience).toEqual(audienceFor(app.db, made.value, olive));
    expect(body.audience.sentence).toStartWith("The code is public; the app answers only to");

    const mcp = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        ...auth,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "repo", arguments: { repo: "olive/garden" } },
      }),
    });
    expect(await mcp.text()).toContain("The code is public; the app answers only to");

    const page = await (await fetch(`${servers.url}/olive/garden`, { headers: auth })).text();
    const said = esc(body.audience.sentence);
    expect(audienceOn(page)).toEqual({
      badge: "Split",
      href: "/olive/garden/settings",
      text: said,
    });
  });

  test("signed out, the page and the API say the same; a non-admin gets no link", async () => {
    const made = await createRepo(app, olive, { name: "meadow", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const api = (await (await fetch(`${servers.url}/api/v1/repos/olive/meadow`)).json()) as {
      audience: { sentence: string };
    };
    expect(api.audience.sentence).toStartWith("Public: anyone can read this");
    const said = esc(api.audience.sentence);
    const out = await (await fetch(`${servers.url}/olive/meadow`)).text();
    expect(audienceOn(out)).toEqual({ badge: undefined, href: undefined, text: said });
    expect(out).not.toContain("repo-desc");

    const wren = await createUser(app.db, {
      origin: "seed",
      username: "wren",
      email: "wren@f.dev",
      password: "a-good-passphrase",
    });
    if (!wren.ok) throw new Error(wren.error);
    proveAll(app);
    const token = createToken(app.db, wren.value.id, "t", "ro").token;
    const seen = await (
      await fetch(`${servers.url}/olive/meadow`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).text();
    expect(audienceOn(seen)).toEqual({ badge: undefined, href: undefined, text: said });
  });
});
