/**
 * Changing a thread's labels or planning it is refused in the same words by
 * every door, because every door reads them from src/actions/thread_words.ts.
 * Each refusal is triggered through the page and through MCP, and each
 * answer must be the module's sentence.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { THREAD_SAYS } from "../src/actions/thread_words.ts";
import { createIssue, createLabel } from "../src/core/issues.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { FLASH_COOKIE } from "../src/web/flash.ts";
import { promote } from "./helpers/members.ts";

const PASSWORD = "a-good-passphrase";

describe("label and plan refusals on a thread", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let aliceRw: string;
  let bobRw: string;
  let aliceCookie: string;
  let bobCookie: string;
  let first: number;
  let second: number;
  let id = 1;

  const mcp = async (token: string, name: string, args: unknown) => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: id++,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const body: any = await res.json();
    expect(body.result.isError).toBe(true);
    return body.result.content[0].text as string;
  };
  const signIn = async (username: string): Promise<string> =>
    (
      (
        await fetch(`${base}/signin`, {
          method: "POST",
          body: new URLSearchParams({ username, password: PASSWORD }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;
  /** Post a form and read back the message its flash carries. */
  const flashed = async (
    path: string,
    cookie: string,
    fields: [string, string][],
  ): Promise<string> => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        cookie,
        origin: base,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(fields).toString(),
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    const flash = res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0]!)
      .find((c) => c.startsWith(`${FLASH_COOKIE}=`));
    expect(flash).toBeDefined();
    return JSON.parse(decodeURIComponent(flash!.slice(FLASH_COOKIE.length + 1)))
      .message;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-thread-words-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: PASSWORD,
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    const b = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: PASSWORD,
    });
    if (!b.ok) throw new Error(b.error);
    promote(app.db, b.value);
    aliceRw = createToken(app.db, a.value.id, "rw", "rw").token;
    bobRw = createToken(app.db, b.value.id, "rw", "rw").token;
    const made = await createRepo(app, a.value, {
      name: "game",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    createLabel(app.db, made.value.id, "bug", "d73a4a");
    for (const title of ["First", "Second"]) {
      const issue = createIssue(app.db, {
        repoId: made.value.id,
        authorId: a.value.id,
        title,
      });
      if (!issue.ok) throw new Error(issue.error);
      if (title === "First") first = issue.value.number;
      else second = issue.value.number;
    }
    aliceCookie = await signIn("alice");
    bobCookie = await signIn("bob");
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a label that does not exist", async () => {
    expect(
      await flashed(`/alice/game/issues/${first}/labels`, aliceCookie, [
        ["labels", "nope"],
      ]),
    ).toBe(THREAD_SAYS.unknownLabel);
    expect(
      await mcp(aliceRw, "labels", {
        repo: "alice/game",
        number: first,
        labels: ["nope"],
      }),
    ).toBe(`unknown_label: ${THREAD_SAYS.unknownLabel}`);
  });

  test("a reader changing labels", async () => {
    expect(
      await flashed(`/alice/game/issues/${first}/labels`, bobCookie, [
        ["labels", "bug"],
      ]),
    ).toBe(THREAD_SAYS.labelsForbidden);
    expect(
      await mcp(bobRw, "labels", {
        repo: "alice/game",
        number: first,
        labels: ["bug"],
      }),
    ).toBe(`forbidden: ${THREAD_SAYS.labelsForbidden}`);
  });

  test("a reader planning", async () => {
    expect(
      await flashed(`/alice/game/issues/${second}/dependencies`, bobCookie, [
        ["blockedBy", String(first)],
      ]),
    ).toBe(THREAD_SAYS.planForbidden);
    expect(
      await mcp(bobRw, "wait_for", {
        app: "alice/game",
        issue: second,
        blockedBy: first,
      }),
    ).toBe(`forbidden: ${THREAD_SAYS.planForbidden}`);
  });
});
