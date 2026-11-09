import { afterEach, describe, expect, test } from "bun:test";
import { pull } from "../src/pull.ts";
import { makeHandler } from "../src/server.ts";
import { readPage, RefusedHost, sourceFetch, type Fetch, type Page } from "../src/source.ts";
import { openStore, type Store } from "../src/store.ts";
import { sign } from "../src/who.ts";

/** A source of three records; a page after "c3" is empty. */
function fakeSource(): { read: (cursor: string) => Promise<Page>; reads: string[] } {
  const reads: string[] = [];
  const all = [
    { id: "a", name: "Ada" },
    { id: "b", name: "Bo" },
    { id: "c", name: "Cy" },
  ];
  return {
    reads,
    read: async (cursor) => {
      reads.push(cursor);
      return cursor === "c3" ? { records: [], cursor } : { records: all, cursor: "c3" };
    },
  };
}

let store: Store | undefined;
afterEach(() => store?.close());

const KEY = "test-identity-key";
const NOW = 1_800_000_000_000;

/** A POST /pull as the forge proxies it, signed for `role` until `expires`. */
function pullAs(
  role: string,
  { expires = NOW + 60_000, key = KEY, headers = {} as Record<string, string> } = {},
): Request {
  const identity = `u1|ada|${role}|${expires}`;
  return new Request("http://adapter/pull", {
    method: "POST",
    headers: { "x-forge-identity": identity, "x-forge-signature": sign(identity, key), ...headers },
  });
}

describe("POST /pull answers the four fields", () => {
  test("an admin's pull writes every record and moves the cursor", async () => {
    store = openStore(":memory:");
    const handle = makeHandler(store, { read: fakeSource().read, key: KEY, now: () => NOW });
    const answer = await handle(pullAs("admin"));
    expect(answer.status).toBe(200);
    expect(answer.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await answer.json()).toEqual({ pulled: 3, skipped: 0, cursor: "c3", errors: 0 });
    expect(store.count()).toBe(3);
  });

  test("a cross-origin POST is refused and pulls nothing", async () => {
    store = openStore(":memory:");
    const source = fakeSource();
    const handle = makeHandler(store, { read: source.read, key: KEY, now: () => NOW });
    const answer = await handle(pullAs("admin", { headers: { origin: "https://evil.test" } }));
    expect(answer.status).toBe(403);
    expect(source.reads).toEqual([]);
  });

  test("a failed read answers a fixed 502 and keeps the cursor", async () => {
    store = openStore(":memory:");
    store.setCursor("before");
    const handle = makeHandler(store, {
      read: () => Promise.reject(new Error("https://secret.internal/records?token=x")),
      key: KEY,
      now: () => NOW,
    });
    const quiet = console.error;
    console.error = () => {};
    try {
      const answer = await handle(pullAs("admin"));
      expect(answer.status).toBe(502);
      expect(await answer.json()).toEqual({ error: "pull failed" });
    } finally {
      console.error = quiet;
    }
    expect(store.cursor()).toBe("before");
  });
});

describe("only an admin the forge signed for may pull", () => {
  const cases: [string, () => Request, number][] = [
    ["no headers", () => new Request("http://adapter/pull", { method: "POST" }), 401],
    ["a bad signature", () => pullAs("admin", { key: "another-key" }), 401],
    ["an expired identity", () => pullAs("admin", { expires: NOW - 1 }), 401],
    ["an identity expiring now", () => pullAs("admin", { expires: NOW }), 401],
    ["a non-admin", () => pullAs("user"), 403],
  ];
  for (const [what, req, status] of cases) {
    test(`${what} is refused with ${status} and reads nothing from the source`, async () => {
      store = openStore(":memory:");
      const source = fakeSource();
      const handle = makeHandler(store, { read: source.read, key: KEY, now: () => NOW });
      const answer = await handle(req());
      expect(answer.status).toBe(status);
      expect(source.reads).toEqual([]);
      expect(store.count()).toBe(0);
    });
  }

  test("without an identity key nobody may pull, even with signed headers", async () => {
    store = openStore(":memory:");
    const source = fakeSource();
    const handle = makeHandler(store, { read: source.read, key: "", now: () => NOW });
    const answer = await handle(pullAs("admin", { key: "" }));
    expect(answer.status).toBe(401);
    expect(source.reads).toEqual([]);
  });

  test("GET / shows the cursor to an admin only, inside <main>", async () => {
    store = openStore(":memory:");
    store.setCursor("page-token-7");
    const handle = makeHandler(store, { read: fakeSource().read, key: KEY, now: () => NOW });
    const anon = await (await handle(new Request("http://adapter/"))).text();
    expect(anon).toContain("<main>");
    expect(anon).not.toContain("page-token-7");
    const identity = `u1|ada|admin|${NOW + 60_000}`;
    const admin = await (
      await handle(
        new Request("http://adapter/", {
          headers: { "x-forge-identity": identity, "x-forge-signature": sign(identity, KEY) },
        }),
      )
    ).text();
    expect(admin).toContain("page-token-7");
  });
});

describe("idempotent", () => {
  test("a replay from the same cursor writes nothing new", async () => {
    store = openStore(":memory:");
    const source = fakeSource();
    const first = await pull(store, source.read);
    expect(first).toEqual({ pulled: 3, skipped: 0, cursor: "c3", errors: 0 });
    // The forge repeats the pull from the cursor it last held: "".
    store.setCursor("");
    const replay = await pull(store, source.read);
    expect(source.reads).toEqual(["", ""]);
    expect(replay).toEqual({ pulled: 0, skipped: 3, cursor: "c3", errors: 0 });
    expect(store.count()).toBe(3);
  });

  test("a record without a source id is counted as an error, not written", async () => {
    store = openStore(":memory:");
    const result = await pull(store, async () => ({ records: [{ name: "no id" }, null], cursor: "x" }));
    expect(result).toEqual({ pulled: 0, skipped: 0, cursor: "x", errors: 2 });
    expect(store.count()).toBe(0);
  });
});

describe("only the declared source is reachable", () => {
  const ok: Fetch = async () => Response.json({ records: [], cursor: "next" });

  test("a host outside the source is refused before any request", async () => {
    const seen: string[] = [];
    const get = sourceFetch(["api.example.com"], async (url) => {
      seen.push(url);
      return ok(url);
    });
    for (const url of [
      "https://evil.example.net/records",
      "https://api.example.com.evil.test/records",
      "http://api.example.com/records",
      "not a url",
    ]) {
      await expect(get(url)).rejects.toBeInstanceOf(RefusedHost);
    }
    expect(seen).toEqual([]);
    const answer = await get("https://api.example.com/records");
    expect(answer.ok).toBe(true);
    expect(seen).toEqual(["https://api.example.com/records"]);
  });

  test("readPage goes only to the declared host, and does not follow redirects", async () => {
    const seen: { url: string; redirect: string | undefined }[] = [];
    const page = await readPage(
      "c 1",
      sourceFetch(["api.example.com"], async (url, init) => {
        seen.push({ url, redirect: init?.redirect });
        return ok(url);
      }),
    );
    expect(page).toEqual({ records: [], cursor: "next" });
    expect(seen).toEqual([{ url: "https://api.example.com/records?after=c%201", redirect: "manual" }]);
  });
});
