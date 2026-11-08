/**
 * A told page never carries credentials into an issue: `user:pass@` and the
 * query parameters that hold a sign-in, invite or reset secret are dropped
 * from `context.page` and from `from`, because the issue a tell opens may
 * be public. Checked on the two functions, on `tell()` itself, and through
 * the web's tell form and MCP `tell`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { parseFrom } from "../src/actions/tell_from.ts";
import { tell } from "../src/actions/tell.ts";
import { contextNote, parseContext } from "../src/actions/tell_context.ts";
import { listIssues } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

const NAMES = [
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "key",
  "api_key",
  "api-key",
  "apikey",
  "secret",
  "client_secret",
  "password",
  "code",
  "sig",
  "signature",
  "invite",
  "reset",
  "session",
  "sessionid",
  "sid",
  "auth",
  "authorization",
  "jwt",
  "otp",
  "magic",
  "ticket",
  // By suffix, not by name.
  "upload_token",
  "x-api-key",
  "app_secret",
];

/** One name in three spellings: as given, shouted, and mixed. */
const spellings = (n: string): string[] => [
  n,
  n.toUpperCase(),
  n.replace(/^./, (c) => c.toUpperCase()),
];

describe("parseContext", () => {
  test("credentials before the host are removed", () => {
    expect(parseContext({ page: "https://user:pass@app.example/x" })).toEqual({
      page: "https://app.example/x",
    });
    expect(parseContext({ page: "https://user@app.example/x" })).toEqual({
      page: "https://app.example/x",
    });
  });

  test("each named parameter is dropped in any case, the rest kept in order", () => {
    for (const name of NAMES)
      for (const n of spellings(name))
        expect(parseContext({ page: `https://app.example/x?a=1&${n}=abc&b=2` })).toEqual({
          page: "https://app.example/x?a=1&b=2",
        });
  });

  test("a page holding only secrets loses its query entirely", () => {
    expect(parseContext({ page: "https://app.example/x?token=abc&Code=def" })).toEqual({
      page: "https://app.example/x",
    });
  });

  test("the issue's example: neither the password nor the token survives", () => {
    const c = parseContext({ page: "https://user:pass@app.example/x?token=abc&tab=2" });
    expect(c).toEqual({ page: "https://app.example/x?tab=2" });
    const note = contextNote(c ?? undefined);
    expect(note).not.toContain("pass");
    expect(note).not.toContain("abc");
  });

  test("a page with nothing to drop is left as it was", () => {
    for (const page of [
      "https://app.example/x?tab=2&sort=desc&tokens=1&keyword=k&monkey=1&tokenizer=a",
      "https://app.example/x?q=a%20b&tab",
      "https://app.example/",
    ])
      expect(parseContext({ page })).toEqual({ page });
  });

  test("nothing accepted today is refused", () => {
    expect(parseContext({ page: "https://app.example/x?=&&token" })).not.toBeNull();
  });
});

describe("parseFrom", () => {
  test("each named parameter is dropped in any case, the rest kept in order", () => {
    for (const name of NAMES)
      for (const n of spellings(name))
        expect(parseFrom(`/alice/notes/pulls/3?a=1&${n}=abc&b=2`)).toBe(
          "/alice/notes/pulls/3?a=1&b=2",
        );
  });

  test("a query of only secrets is removed, a path without one is kept", () => {
    expect(parseFrom("/alice/notes?invite=abc")).toBe("/alice/notes");
    expect(parseFrom("/alice/notes?tab=files&sort=x")).toBe("/alice/notes?tab=files&sort=x");
    expect(parseFrom("/alice/notes/pulls/3")).toBe("/alice/notes/pulls/3");
    expect(parseFrom("/alice/notes?token=abc#line-3")).toBe("/alice/notes#line-3");
  });

  test("nothing accepted today is refused: a scrubbed path is a path, not undefined", () => {
    expect(parseFrom("/a?token=x")).toBe("/a");
    expect(parseFrom("/a?=&&token")).toBe("/a?=&");
  });
});

describe("the doors", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let rw: string;
  let alice: User;
  let game: Repo;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tell-scrub-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    rw = createToken(app.db, a.value.id, "rw", "rw").token;
    const made = await createRepo(app, a.value, { name: "game", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    game = made.value;
    await commitToBranch(app, a.value, game, {
      message: "seed",
      files: [{ path: "README.md", content: "# game\n" }],
    });
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a tell with a credentialed page makes an issue holding neither secret", async () => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${rw}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "tell",
          arguments: {
            repo: "alice/game",
            text: "the reset link is broken",
            from: "/alice/game/issues?Session=abc&state=open",
            context: { page: "https://user:pass@app.example/x?token=abc&tab=2" },
          },
        },
      }),
    });
    const body = (await res.json()) as { result: { isError?: boolean } };
    expect(body.result.isError).not.toBe(true);
    const issue = listIssues(app.db, game.id, {}).find(
      (i) => i.title === "the reset link is broken",
    );
    expect(issue?.body).toContain("page: https://app.example/x?tab=2");
    expect(issue?.body).toContain("/alice/game/issues?state=open");
    expect(issue?.body).not.toContain("pass");
    expect(issue?.body).not.toContain("abc");
  });

  const issueTitled = (title: string) =>
    listIssues(app.db, game.id, {}).find((i) => i.title === title);

  test("tell() takes a from with a secret, stores it without, and is not bad_from", async () => {
    const t = await tell(app, alice, game, "the invite page", 1, "/alice/game?invite=abc&tab=2");
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    expect(t.value.issue.body).toContain("Told from [/alice/game?tab=2](/alice/game?tab=2)");
    expect(issueTitled("the invite page")?.body).not.toContain("abc");
  });

  test("the web's tell form with a credentialed page or from stores neither secret", async () => {
    const post = (fields: Record<string, string>) =>
      fetch(`${servers.url}/alice/game/tell`, {
        method: "POST",
        headers: { authorization: `Bearer ${rw}` },
        body: new URLSearchParams(fields),
        redirect: "manual",
      });
    expect(
      (await post({ text: "told from the pill", page: "https://user:pass@app.example/x?Token=abc&tab=2" }))
        .status,
    ).toBe(200);
    const pill = issueTitled("told from the pill")?.body ?? "";
    expect(pill).toContain("- page: https://app.example/x?tab=2");
    expect(pill).not.toContain("pass");
    expect(pill).not.toContain("abc");
    await post({ text: "told from a forge page", from: "/alice/game/issues?API-Key=abc&state=open" });
    const page = issueTitled("told from a forge page")?.body ?? "";
    expect(page).toContain("/alice/game/issues?state=open");
    expect(page).not.toContain("abc");
  });
});
