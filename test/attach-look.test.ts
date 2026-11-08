/**
 * A person attaches a look to a pull (#1066): a PNG or JPEG at a stated
 * width with one line saying what it shows, kept like the crew's and shown
 * on the change's page. The refusals come first: a stranger, a reader, an
 * agent, an oversized or non-image upload — and nothing of theirs is kept.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createApp as insertApp, type AppRecord } from "../src/core/apps.ts";
import { deleteLooks, looksForEnv } from "../src/core/looks.ts";
import { previewEnv } from "../src/apps/data.ts";
import type { Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { encodePng } from "../src/design/image/png.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASSWORD = "a-good-passphrase";
const png = (w: number, h: number): string =>
  Buffer.from(encodePng(w, h, new Uint8Array(w * h * 4).fill(200))).toString(
    "base64",
  );
const PHONE = png(390, 844);
const JPEG = readFileSync(`${import.meta.dir}/fixtures/quads-baseline.jpg`).toString(
  "base64",
);

describe("attaching a look to a pull", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
  let bob: User;
  let bot: User;
  let repo: Repo;
  let record: AppRecord;
  let pull: Pull;
  const tokens: Record<string, string> = {};

  const post = (token: string | null, payload: unknown, number = pull.number) =>
    fetch(`${base}/api/v1/repos/alice/garden/pulls/${number}/looks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(payload),
    });
  const good = { width: "phone", says: "the empty garden", image: PHONE };
  const kept = () => looksForEnv(app.db, record.id, previewEnv(pull.number));
  const onDisk = () => {
    const dir = join(dataDir, "looks");
    return existsSync(dir) ? readdirSync(dir, { recursive: true }) : [];
  };

  const mcp = async (token: string, args: Record<string, unknown>) => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "attach_look", arguments: { app: "alice/garden", pull: pull.number, ...args } },
      }),
    });
    const body = (await res.json()) as any;
    const text: string = body.result.content[0].text;
    return body.result.isError === true
      ? { error: text, value: undefined }
      : { error: undefined, value: JSON.parse(text) };
  };

  const page = async (cookie: string) =>
    (
      await fetch(`${base}/alice/garden/pulls/${pull.number}`, {
        headers: cookie === "" ? {} : { cookie },
      })
    ).text();
  const signIn = async (username: string): Promise<string> => {
    const r = await fetch(`${base}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username, password: PASSWORD }),
      redirect: "manual",
    });
    return (r.headers.get("set-cookie") ?? "").split(";")[0]!;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-attach-look-"));
    app = createApp({ dataDir, port: 0 });
    const person = async (username: string): Promise<User> => {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: PASSWORD,
        adminIfFirst: username === "alice",
      });
      if (!made.ok) throw new Error(made.error);
      return made.value;
    };
    alice = await person("alice");
    bob = await person("bob");
    const made = await createRepo(app, alice, { name: "garden", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    await commitToBranch(app, alice, repo, {
      message: "seed",
      files: [{ path: "README.md", content: "# garden\n" }],
    });
    await commitToBranch(app, alice, repo, {
      branch: "one",
      base: "main",
      message: "one",
      files: [{ path: "one.md", content: "x\n" }],
    });
    const opened = await openPull(app, alice, repo, {
      title: "Change one",
      body: "",
      baseBranch: "main",
      headBranch: "one",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    pull = opened.value;
    const inserted = insertApp(app.db, { repoId: repo.id, slug: "garden", access: "public" });
    if (!inserted.ok) throw new Error(inserted.error);
    record = inserted.value;
    const agent = await createAgent(app, alice, { username: "bot" });
    if (!agent.ok) throw new Error(String(agent.error));
    bot = agent.value.user;
    expect(addToCrew(app, alice, repo, "bot").ok).toBe(true);
    servers = await serve(app);
    base = servers.url;
    tokens["alice"] = createToken(app.db, alice.id, "t", "rw").token;
    tokens["aliceRo"] = createToken(app.db, alice.id, "t", "ro").token;
    tokens["bob"] = createToken(app.db, bob.id, "t", "rw").token;
    tokens["bot"] = createToken(app.db, bot.id, "run", "rw").token;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a stranger, a reader, a read-only token and an agent are refused, and nothing is kept", async () => {
    expect((await post(null, good)).status).toBe(401);
    expect((await post(tokens["bob"]!, good)).status).toBe(403);
    expect((await post(tokens["aliceRo"]!, good)).status).toBe(403);
    expect((await post(tokens["bot"]!, good)).status).toBe(403);
    expect((await mcp(tokens["bob"]!, { ...good, dryRun: false })).error).toContain("person who can write");
    expect((await mcp(tokens["bot"]!, { ...good, dryRun: false })).error).toContain("person who can write");
    expect(kept()).toEqual([]);
    expect(onDisk()).toEqual([]);
  });

  test("an oversized or non-image upload, a bad width and a bad line are refused", async () => {
    const big = Buffer.concat([
      Buffer.from(PHONE, "base64"),
      Buffer.alloc(5 * 1024 * 1024),
    ]).toString("base64");
    expect((await post(tokens["alice"]!, { ...good, image: big })).status).toBe(413);
    const text = Buffer.from("<script>alert(1)</script>").toString("base64");
    expect((await post(tokens["alice"]!, { ...good, image: text })).status).toBe(422);
    const gif = readFileSync(`${import.meta.dir}/fixtures/quads.gif`).toString("base64");
    expect((await post(tokens["alice"]!, { ...good, image: gif })).status).toBe(422);
    // A PNG's signature with nothing behind it.
    const stub = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString("base64");
    expect((await post(tokens["alice"]!, { ...good, image: stub })).status).toBe(422);
    expect((await post(tokens["alice"]!, { ...good, image: "not base64!" })).status).toBe(422);
    expect((await post(tokens["alice"]!, { ...good, image: "" })).status).toBe(422);
    expect((await post(tokens["alice"]!, { ...good, width: "tablet" })).status).toBe(422);
    expect((await post(tokens["alice"]!, { ...good, says: "" })).status).toBe(422);
    expect((await post(tokens["alice"]!, { ...good, says: "two\nlines" })).status).toBe(422);
    expect((await post(tokens["alice"]!, { ...good, says: "x".repeat(201) })).status).toBe(422);
    expect((await post(tokens["alice"]!, good, 999)).status).toBe(404);
    expect(kept()).toEqual([]);
    expect(onDisk()).toEqual([]);
  });

  test("a person who writes attaches a PNG, and it shows beside the rest for writers only", async () => {
    const res = await post(tokens["alice"]!, {
      ...good,
      says: "<b>the empty garden</b>",
    });
    expect(res.status).toBe(201);
    const made = (await res.json()) as any;
    expect(made.width).toBe("phone");
    expect(made.by).toBe("alice");
    const desktop = await post(tokens["alice"]!, {
      width: "desktop",
      says: "the same, wide",
      image: JPEG,
    });
    expect(desktop.status).toBe(201);
    const rows = kept();
    expect(rows.map((l) => l.kind).sort()).toEqual(["desktop", "phone"]);
    expect(rows.every((l) => l.attachedBy === "alice")).toBe(true);

    const mine = await page(await signIn("alice"));
    expect(mine).toContain("attached by alice");
    expect(mine).toContain("&lt;b&gt;the empty garden&lt;/b&gt;");
    expect(mine).not.toContain("<b>the empty garden</b>");
    expect(mine).toContain('width="390" height="844"');
    expect(mine).toContain("the same, wide");
    // A reader who cannot write is not shown a stranger's picture, nor a person's.
    const theirs = await page(await signIn("bob"));
    expect(theirs).not.toContain("attached by");
    expect(await page("")).not.toContain("attached by");

    const phoneUrl = made.url as string;
    const cookie = await signIn("alice");
    const served = await fetch(`${base}${phoneUrl}`, { headers: { cookie } });
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    const wide = rows.find((l) => l.kind === "desktop")!;
    const jpg = await fetch(
      `${base}/alice/garden/looks/${wide.env}/${wide.commitOid}/${wide.page.slice(1)}-desktop.png`,
      { headers: { cookie } },
    );
    expect(jpg.headers.get("content-type")).toBe("image/jpeg");
    expect((await fetch(`${base}${phoneUrl}`)).status).toBe(404);
    expect(
      (await fetch(`${base}${phoneUrl}`, { headers: { cookie: await signIn("bob") } })).status,
    ).toBe(404);
  });

  test("the crew's retake of the preview does not age an attached look out", () => {
    const before = kept().length;
    expect(deleteLooks(app.db, record.id, previewEnv(pull.number), "f".repeat(40))).toEqual([]);
    expect(kept().length).toBe(before);
  });

  test("the MCP plans first, then attaches for a person's token", async () => {
    const before = kept().length;
    const dry = await mcp(tokens["alice"]!, good);
    expect(dry.value.dryRun).toBe(true);
    expect(kept().length).toBe(before);
    const bad = await mcp(tokens["alice"]!, { ...good, width: "tablet", dryRun: false });
    expect(bad.error).toContain("phone or desktop");
    const done = await mcp(tokens["alice"]!, { ...good, dryRun: false });
    expect(done.value.dryRun).toBe(false);
    expect(done.value.url).toContain("/alice/garden/looks/");
    expect(kept().length).toBe(before + 1);
  });

  test("MCP pull carries the looks of its pull, newest first; a pull with none has []", async () => {
    const call = async (token: string, number: number) => {
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "pull", arguments: { repo: "alice/garden", number } },
        }),
      });
      const body = (await res.json()) as any;
      return JSON.parse(body.result.content[0].text);
    };
    const done = await mcp(tokens["alice"]!, { ...good, says: "seen over MCP", dryRun: false });
    const seen = await call(tokens["alice"]!, pull.number);
    expect(seen.looks[0]).toMatchObject({
      width: "phone",
      says: "seen over MCP",
      by: "alice",
      commit: pull.headOid,
      url: done.value.url,
    });
    expect(seen.looks.length).toBe(kept().length);
    const ats = seen.looks.map((l: any) => l.at);
    expect(ats).toEqual([...ats].sort().reverse());
    // Not a writer: none.
    expect((await call(tokens["bob"]!, pull.number)).looks).toEqual([]);
    // A pull with no looks.
    await commitToBranch(app, alice, repo, {
      branch: "two", base: "main", message: "two", files: [{ path: "two.md", content: "x\n" }],
    });
    const second = await openPull(app, alice, repo, {
      title: "Change two", body: "", baseBranch: "main", headBranch: "two",
    });
    if (!second.ok) throw new Error(String(second.error));
    expect((await call(tokens["alice"]!, second.value.number)).looks).toEqual([]);
  });
});
