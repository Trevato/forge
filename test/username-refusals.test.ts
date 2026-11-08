/**
 * Unsafe usernames are refused at sign-up, through the page and the API,
 * before any account is made (#7135): `createUser` answers `invalid_username`
 * when `isSafeName` rejects a name. A reserved word is a different refusal
 * (`username_reserved`), also made before any row exists.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { NAME_RESERVED } from "../src/actions/signup_words.ts";
import { setLimit } from "../src/settings/limits.ts";
import { serve, type Servers } from "../src/http/server.ts";

const UNSAFE: [string, string][] = [
  ["dot-dot", ".."],
  ["a slash", "a/b"],
  ["markup", "<b>"],
  ["a NUL", "al\u0000ice"],
  ["200 characters", "a".repeat(200)],
];
const RESERVED = ["settings", "api"];
const PASSWORD = "a-long-passphrase";

describe("username refusals at sign-up", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;

  const users = () => app.db.query<{ n: number }, []>("SELECT count(*) AS n FROM user").get()!.n;
  const api = (username: string) =>
    fetch(`${base}/api/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password: PASSWORD }),
    });
  const form = (username: string) =>
    fetch(`${base}/signup`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username, password: PASSWORD }).toString(),
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-username-refusals-"));
    delete process.env.FORGE_EDGE_TOKEN;
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    setLimit(app.db, "signup.per_source", 1000, "system");
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  for (const [what, name] of UNSAFE) {
    test(`the API refuses ${what} with invalid_username and makes no user`, async () => {
      const before = users();
      const res = await api(name);
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_username");
      expect(users()).toBe(before);
    });

    test(`the page refuses ${what} and makes no user`, async () => {
      const before = users();
      const res = await form(name);
      expect(res.status).toBe(422);
      expect(res.headers.get("set-cookie")).toBeNull();
      const html = await res.text();
      expect(html).toContain("Usernames are letters, digits, dots, dashes.");
      expect(html).not.toContain("<b>");
      expect(users()).toBe(before);
    });
  }

  for (const name of RESERVED) {
    test(`the API refuses the reserved word ${name} and makes no user`, async () => {
      const before = users();
      const res = await api(name);
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: string }).error).toBe("username_reserved");
      expect(users()).toBe(before);
    });

    test(`the page refuses the reserved word ${name} and makes no user`, async () => {
      const before = users();
      const res = await form(name);
      expect(res.status).toBe(422);
      expect(await res.text()).toContain(NAME_RESERVED);
      expect(users()).toBe(before);
    });
  }

  test("a plain name signs up through the API and through the page", async () => {
    const res = await api("alice-2");
    expect(res.status).toBe(201);
    expect(users()).toBe(1);
    const page = await form("alice-3");
    expect(page.status).toBe(303);
    expect(users()).toBe(2);
  });
});
