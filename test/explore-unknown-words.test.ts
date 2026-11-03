/**
 * An unknown `kind:` or `sort:` word is a note, not an error (#7595): the
 * parser hands it back as data, the page and the API say it once and name
 * what is taken, the filter links drop it, and results still show.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { exploreLine, exploreNote, readExploreLine } from "../src/actions/explore.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("readExploreLine", () => {
  test("an unknown sort and an unknown kind are returned, and left out of the query", () => {
    const read = readExploreLine("sort:bogus kind:nope garden");
    expect(read.unknown).toEqual(["sort:bogus", "kind:nope"]);
    expect(read.query.sort).toBe("score");
    expect(read.query.kind).toBe("all");
    expect(exploreLine(read.query)).toBe("garden");
  });

  test("an unknown updated: is returned, left out, and worded as a window", () => {
    const read = readExploreLine("updated:2y garden");
    expect(read.unknown).toEqual(["updated:2y"]);
    expect(read.query.updated).toBe("all");
    expect(exploreLine(read.query)).toBe("garden");
    expect(exploreNote(read.unknown)).toBe("updated:2y is not a window — use 1d, 7d, 30d");
  });

  test("an unknown archived: is returned, left out, and worded", () => {
    const read = readExploreLine("archived:maybe");
    expect(read.unknown).toEqual(["archived:maybe"]);
    expect(read.query.archived).toBe(false);
    expect(exploreLine(read.query)).toBe("");
    expect(exploreNote(read.unknown)).toBe("archived:maybe is not an answer — use yes, no");
  });

  test("an unsafe owner: is returned, left out, and worded as a name", () => {
    const read = readExploreLine("owner:a/b owner:trevato");
    expect(read.unknown).toEqual(["owner:a/b"]);
    expect(read.query.owner).toBe("trevato");
    expect(exploreNote(["owner:a/b"])).toBe("owner:a/b is not a name");
  });

  test("a bare key and a word with a colon stay free text", () => {
    for (const w of ["updated:", "archived:", "owner:", "http://x"]) {
      const read = readExploreLine(w);
      expect(read.unknown).toEqual([]);
      expect(read.query.text).toBe(w);
    }
  });

  test("the API carries the note for all three", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-explore-keys-"));
    const a = createApp({ dataDir: dir, port: 0 });
    const s = await serve(a);
    try {
      const q = encodeURIComponent("owner:trevato updated:2y archived:maybe");
      const body = (await (await fetch(`${s.url}/api/v1/explore?q=${q}`)).json()) as { note?: string; query: string };
      expect(body.note).toBe("updated:2y is not a window — use 1d, 7d, 30d; archived:maybe is not an answer — use yes, no");
      expect(body.query).toBe("owner:trevato");
    } finally {
      await s.stop();
      a.db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("known words yield none", () => {
    expect(readExploreLine("sort:forks kind:apps garden").unknown).toEqual([]);
    expect(exploreNote([])).toBe("");
  });

  test("the note names what is taken", () => {
    expect(exploreNote(["sort:bogus"])).toBe("sort:bogus is not a sort — use score, forks, ships, likes, use, fresh, name");
    expect(exploreNote(["kind:x"])).toBe("kind:x is not a kind — use app, person, forge");
  });
});

describe("the page and the API", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-explore-unknown-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
  });
  afterAll(async () => {
    await servers.stop();
    app.db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the page says it once and the filter links drop the word", async () => {
    const q = encodeURIComponent("sort:bogus garden");
    const out = await (await fetch(`${servers.url}/explore?q=${q}`)).text();
    expect(out.split("is not a sort").length).toBe(2);
    expect(out).toContain("sort:bogus is not a sort — use score, forks, ships, likes, use, fresh, name");
    expect(out).not.toContain(encodeURIComponent("sort:bogus"));
    expect(out).toContain(`href="/explore?q=${encodeURIComponent("kind:app garden")}"`);
  });

  test("the page says an updated:, archived: or owner: word once, escaped", async () => {
    const page = async (q: string) => await (await fetch(`${servers.url}/explore?q=${encodeURIComponent(q)}`)).text();
    expect(await page("updated:2y")).toContain("updated:2y is not a window — use 1d, 7d, 30d");
    expect(await page("archived:maybe")).toContain("archived:maybe is not an answer — use yes, no");
    const out = await page("owner:<b>");
    expect(out).toContain("owner:&lt;b&gt; is not a name");
    expect(out).not.toContain("<b>");
  });

  test("a known word draws no note", async () => {
    const out = await (await fetch(`${servers.url}/explore?q=${encodeURIComponent("sort:forks")}`)).text();
    expect(out).not.toContain("is not a");
  });

  test("the note is escaped", async () => {
    const out = await (await fetch(`${servers.url}/explore?q=${encodeURIComponent("sort:<b>")}`)).text();
    expect(out).toContain("sort:&lt;b&gt; is not a sort");
    expect(out).not.toContain("<b>");
  });

  test("the API answers a note in a field, not an error", async () => {
    const res = await fetch(`${servers.url}/api/v1/explore?q=${encodeURIComponent("kind:nope")}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { note?: string; query: string; items: unknown[] };
    expect(body.note).toContain("kind:nope is not a kind");
    expect(body.query).toBe("");
    expect(Array.isArray(body.items)).toBe(true);
    const fine = (await (await fetch(`${servers.url}/api/v1/explore?q=kind:app`)).json()) as { note?: string };
    expect(fine.note).toBeUndefined();
  });

  test("the MCP tool answers the same note", async () => {
    const made = await createUser(app.db, { origin: "seed", trusted: true, username: "mcpuser", email: "mcp@forge.test", password: "a-long-passphrase" });
    if (!made.ok) throw new Error(made.error);
    const token = createToken(app.db, made.value.id, "ro", "ro").token;
    const call = async (query: string) => {
      const res = await fetch(`${servers.url}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "explore", arguments: { query } } }),
      });
      return JSON.parse(((await res.json()) as any).result.content[0].text) as { note?: string };
    };
    expect((await call("sort:bogus")).note).toContain("sort:bogus is not a sort");
    expect((await call("sort:forks")).note).toBeUndefined();
    expect((await call("archived:maybe")).note).toBe("archived:maybe is not an answer — use yes, no");
    expect((await call("updated:2y")).note).toBe("updated:2y is not a window — use 1d, 7d, 30d");
    expect((await call("owner:a/b")).note).toBe("owner:a/b is not a name");
  });
});
