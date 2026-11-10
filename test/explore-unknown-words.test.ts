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
import { exploreLine, exploreNote, exploreSuggestion, readExploreLine } from "../src/actions/explore.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { exploreParams } from "../src/actions/explore.ts";
/** The href the page gives a line: separate parameters, `&` escaped as in markup. */
const linkOf = (line: string): string => `/explore?${exploreParams(readExploreLine(line).query)}`.replace(/&/g, "&amp;");

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
      const res = await fetch(`${s.url}/api/v1/explore?q=${q}`);
      expect(res.status).toBe(422);
      const body = (await res.json()) as { message: string };
      expect(body.message).toBe("updated:2y is not a window — use 1d, 7d, 30d; archived:maybe is not an answer — use yes, no");
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
    expect(out).toContain(`href="${linkOf("kind:app garden")}"`);
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

  test("the API answers 422 naming the allowed words (#10387)", async () => {
    const res = await fetch(`${servers.url}/api/v1/explore?q=${encodeURIComponent("kind:nope")}`);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("unknown_filter");
    expect(body.message).toContain("kind:nope is not a kind — use app, person, forge");
    const fine = await fetch(`${servers.url}/api/v1/explore?q=kind:app`);
    expect(fine.status).toBe(200);
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
      const out = ((await res.json()) as any).result as { isError?: boolean; content: { text: string }[] };
      return { isError: out.isError === true, text: out.content[0]!.text };
    };
    const sort = await call("sort:bogus");
    expect(sort.isError).toBe(true);
    expect(sort.text).toContain("unknown_filter: sort:bogus is not a sort — use score, forks, ships, likes, use, fresh, name");
    const fine = await call("sort:forks");
    expect(fine.isError).toBe(false);
    expect(JSON.parse(fine.text)).toHaveProperty("items");
    expect(await call("archived:maybe")).toEqual({ isError: true, text: "unknown_filter: archived:maybe is not an answer — use yes, no" });
    expect(await call("updated:2y")).toEqual({ isError: true, text: "unknown_filter: updated:2y is not a window — use 1d, 7d, 30d" });
    expect(await call("owner:a/b")).toEqual({ isError: true, text: "unknown_filter: owner:a/b is not a name" });
  });
});

describe("did you mean", () => {
  test("the nearest known word mends the whole line; far words and owner: give none", () => {
    expect(exploreSuggestion("garden sort:froks")?.line).toBe("garden sort:forks");
    expect(exploreSuggestion("garden sort:froks")?.fix).toBe("sort:forks");
    expect(exploreSuggestion("kind:aps")?.line).toBe("kind:app");
    expect(exploreSuggestion("archived:yse")?.line).toBe("archived:yes");
    expect(exploreSuggestion("sort:zzzzzzzz")).toBeUndefined();
    expect(exploreSuggestion("owner:a/b")).toBeUndefined();
    expect(exploreSuggestion("sort:forks")).toBeUndefined();
  });

  test("two unknown words mend the first; a repeated typo is mended everywhere", () => {
    expect(exploreSuggestion("sort:froks kind:aps")?.line).toBe("sort:forks kind:aps");
    expect(exploreSuggestion("sort:froks sort:froks")?.line).toBe("sort:forks sort:forks");
    expect(exploreSuggestion("sort:zzzzzzzz kind:aps")?.line).toBe("sort:zzzzzzzz kind:app");
  });

  test("one or two characters of junk suggest nothing", () => {
    expect(exploreSuggestion("archived:x")).toBeUndefined();
    expect(exploreSuggestion("updated:2y")).toBeUndefined();
    expect(exploreSuggestion("archived:ye")?.line).toBe("archived:yes");
  });

  test("page, API and MCP carry it, escaped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-explore-suggest-"));
    const a = createApp({ dataDir: dir, port: 0 });
    const s = await serve(a);
    try {
      const q = encodeURIComponent("garden sort:froks");
      const html = await (await fetch(`${s.url}/explore?q=${q}`)).text();
      expect(html).toContain(`Did you mean <a href="${linkOf("garden sort:forks")}">sort:forks</a>?`);
      const api = (await (await fetch(`${s.url}/api/v1/explore?q=${q}`)).json()) as { suggest?: string };
      expect(api.suggest).toBe("garden sort:forks");
      const none = (await (await fetch(`${s.url}/api/v1/explore?q=sort:zzzzzzzz`)).json()) as { suggest?: string };
      expect(none.suggest).toBeUndefined();
      const evil = await (await fetch(`${s.url}/explore?q=${encodeURIComponent("sort:<script>")}`)).text();
      expect(evil).not.toContain("<script>");
      expect(evil).toContain("sort:&lt;script&gt; is not a sort");
      const { tool } = await import("../src/http/mcp/tools/explore.ts");
      const out = await tool.run({ app: a } as never, undefined as never, { q: "garden sort:froks" });
      expect(JSON.stringify(out)).toContain("garden sort:forks");
      expect(JSON.stringify(out)).toContain("did you mean");
      const quiet = await tool.run({ app: a } as never, undefined as never, { q: "garden sort:forks" });
      expect(JSON.stringify(quiet)).not.toContain("did you mean");
      const far = await tool.run({ app: a } as never, undefined as never, { q: "sort:zzzzzzzz" });
      expect(JSON.stringify(far)).not.toContain("suggest");
      expect(JSON.stringify(far)).toContain("is not a sort");
    } finally {
      await s.stop();
      a.db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
