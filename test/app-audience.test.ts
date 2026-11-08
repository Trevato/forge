/**
 * The app page says who the app answers to, once, in the repository's head:
 * a public app, a private app, and a private app on a public repository
 * (#620).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newApp } from "../src/actions/apps.ts";
import { updateApp } from "../src/core/apps.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("the app page's audience sentence", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let cookie = "";

  const sentence = async (name: string, withCookie = cookie) => {
    const res = await fetch(`${servers.url}/alice/${name}/app`, {
      headers: withCookie ? { cookie: withCookie } : {},
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    // Said once, under the title (the repo head), not again in the app's own head.
    expect(body).not.toContain("app-audience");
    const line = /<header class="repo-head">[\s\S]*?<p class="muted small">([\s\S]*?)<\/p>/.exec(body)?.[1];
    // The Split badge that leads a split repository's line is a word, not the sentence.
    return line?.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().replace(/^Split /, "");
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-app-audience-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    servers = await serve(app);
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    alice = made.value;
    for (const [name, visibility, access] of [
      ["open", "public", "public"],
      ["closed", "private", "private"],
      ["split", "public", "private"],
    ] as const) {
      const r = await newApp(app, alice, { name, description: "x", visibility });
      if (!r.ok) throw new Error(String(r.error));
      updateApp(app.db, r.value.app.id, { access });
    }
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
      redirect: "manual",
    });
    cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  }, 120_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a public app says anyone can read it", async () => {
    expect(await sentence("open")).toStartWith("Public: anyone can read this;");
  });

  test("a private app says it is private", async () => {
    expect(await sentence("closed")).toStartWith("Private: only you");
  });

  test("a private app on a public repository says the code is public (#620)", async () => {
    expect(await sentence("split")).toStartWith(
      "The code is public; the app answers only to you",
    );
    // Signed out, the page is seen as a stranger: never told "you".
    const out = await sentence("split", "");
    expect(out).toStartWith("The code is public; the app answers only to ");
    expect(out).not.toContain("you");
  });
});
