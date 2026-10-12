/**
 * The claim link, round two (#729, #730). The secret travels in the URL's
 * fragment — `https://child/claim#<token>` — so no server, edge or proxy
 * on the way sees it in a request line or a Referer: the page reads it in
 * the browser and posts it in the body. Any site admin of the parent can
 * re-issue a link for a child nobody has claimed; the old one dies at once.
 * Through MCP the link stays out of the agent's conversation unless asked
 * for there on purpose (#839).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { childDirOf } from "../src/actions/spawn.ts";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { commitFiles } from "../src/git/write.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { firstBoot } from "../src/spawn/first-boot.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASSWORD = "a-long-claim-passphrase";

describe("the claim link in the fragment, and its re-issue", () => {
  let dir = "";
  let parent: App;
  let parentServers: Servers;
  let child: App;
  let childServers: Servers;
  let adminRw = "";
  let adminRo = "";
  let bobRw = "";
  let first = "";
  let second = "";

  const reissue = (token: string, name = "maria", origin?: string) =>
    fetch(`${parentServers.url}/api/v1/forges/${name}/claim-link`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        ...(origin ? { origin } : {}),
      },
    });
  const claim = (form: Record<string, string>, path = "/claim") =>
    fetch(`${childServers.url}${path}`, {
      method: "POST",
      headers: { origin: childServers.url },
      body: new URLSearchParams(form),
      redirect: "manual",
    });
  const tokenOf = (url: string) => url.split("#")[1] ?? "";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-claim-link-"));
    parent = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
    const alice = await createUser(parent.db, {
      trusted: true,
      username: "alice",
      email: "a@x.test",
      password: PASSWORD,
      isAdmin: true,
    });
    const bob = await createUser(parent.db, {
      trusted: true,
      username: "bob",
      email: "b@x.test",
      password: PASSWORD,
    });
    if (!alice.ok || !bob.ok) throw new Error("users");
    adminRw = createToken(parent.db, alice.value.id, "rw", "rw").token;
    adminRo = createToken(parent.db, alice.value.id, "ro", "ro").token;
    bobRw = createToken(parent.db, bob.value.id, "rw", "rw").token;
    const repo = await createRepo(parent, alice.value, { name: "bakery" });
    if (!repo.ok) throw new Error("repo");
    const c = await commitFiles(repoDir(parent.reposRoot, "alice", "bakery"), {
      branch: "main",
      message: "bakery",
      files: [{ path: "README.md", content: "# bakery\n" }],
      author: { name: "a", email: "a@x.invalid" },
    });
    if (!c.ok) throw new Error("commit");
    parentServers = await serve(parent);
    const made = await fetch(`${parentServers.url}/api/v1/forges`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminRw}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "maria",
        apps: ["alice/bakery"],
        dryRun: false,
      }),
    });
    if (made.status !== 201)
      throw new Error(`spawn ${made.status} ${await made.text()}`);
    const body = (await made.json()) as { claimUrl: string; bodyId: string };
    first = body.claimUrl;
    child = createApp({ dataDir: childDirOf(parent, body.bodyId), port: 0 });
    await firstBoot(child);
    childServers = await serve(child);
  }, 60_000);

  afterAll(async () => {
    childServers.stop();
    child.close();
    parentServers.stop();
    parent.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("the link carries its secret in the fragment, never in the path or a query", () => {
    expect(first).toMatch(
      /^https:\/\/maria--forge\.test\/claim#[A-Za-z0-9_-]{43}$/,
    );
  });

  test("the claim page itself is fetched with no secret, and holds none", async () => {
    const page = await fetch(`${childServers.url}/claim`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).not.toContain(tokenOf(first));
    // The page takes the fragment in the browser and drops it from the address.
    expect(html).toContain("location.hash");
    expect(html).toContain("replaceState");
    expect(html).toContain('name="token"');
  });

  test("an unclaimed forge's sign-in page leads to the claim page; the parent's does not", async () => {
    expect(await (await fetch(`${childServers.url}/signin`)).text()).toContain('href="/claim"');
    expect(await (await fetch(`${parentServers.url}/signin`)).text()).not.toContain('href="/claim"');
  });

  test("a token in a query string is never read: only the form's body counts", async () => {
    const res = await fetch(
      `${childServers.url}/claim?token=${tokenOf(first)}`,
      {
        method: "POST",
        headers: { origin: childServers.url },
        body: new URLSearchParams({
          username: "q",
          email: "q@x.test",
          password: PASSWORD,
        }),
        redirect: "manual",
      },
    );
    expect(res.status).toBe(404);
    expect(getUserByName(child.db, "q")).toBeUndefined();
  });

  test("only the parent's admin, with a token that may write, re-issues a link", async () => {
    expect((await reissue(bobRw)).status).toBe(403);
    expect((await reissue(adminRo)).status).toBe(403);
    expect((await reissue(adminRw, "nobody")).status).toBe(404);
    expect(
      (await reissue(adminRw, "maria", "https://evil.test")).status,
    ).toBeLessThan(500);
  });

  test("a re-issued link works and the old one is dead at once", async () => {
    const res = await reissue(adminRw);
    expect(res.status).toBe(201);
    second = ((await res.json()) as { claimUrl: string }).claimUrl;
    expect(second).toMatch(/\/claim#[A-Za-z0-9_-]{43}$/);
    expect(tokenOf(second)).not.toBe(tokenOf(first));
    const old = await claim({
      token: tokenOf(first),
      username: "old",
      email: "old@x.test",
      password: PASSWORD,
    });
    expect(old.status).toBe(404);
    expect(getUserByName(child.db, "old")).toBeUndefined();
    // A reserved name is refused for what it is (#720), and the link is
    // not spent by the refusal.
    const reserved = await claim({
      token: tokenOf(second),
      username: "admin",
      email: "admin@x.test",
      password: PASSWORD,
    });
    expect(reserved.status).toBe(422);
    expect(await reserved.text()).toContain("That name is reserved.");
    expect(getUserByName(child.db, "admin")).toBeUndefined();
    const ok = await claim({
      token: tokenOf(second),
      username: "maria-owner",
      email: "m@x.test",
      password: PASSWORD,
    });
    expect(ok.status).toBe(303);
    expect(getUserByName(child.db, "maria-owner")?.isAdmin).toBe(true);
  });

  test("once claimed, the sign-in page no longer offers a claim", async () => {
    expect(await (await fetch(`${childServers.url}/signin`)).text()).not.toContain('href="/claim"');
  });

  test("a claimed forge's link is not re-issued", async () => {
    const res = await reissue(adminRw);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("already claimed");
  });

  test("a replay of the re-issue under one Idempotency-Key never returns the link", async () => {
    // A fresh child, so the first answer has a link to hide.
    const made = await fetch(`${parentServers.url}/api/v1/forges`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminRw}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "kai",
        apps: ["alice/bakery"],
        dryRun: false,
      }),
    });
    expect(made.status).toBe(201);
    const send = () =>
      fetch(`${parentServers.url}/api/v1/forges/kai/claim-link`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${adminRw}`,
          "idempotency-key": "kai-re-1",
        },
      });
    const a = (await (await send()).json()) as { claimUrl: string };
    expect(a.claimUrl).toContain("/claim#");
    const b = (await (await send()).json()) as { claimUrl: string };
    expect(b.claimUrl).not.toContain("/claim#");
  });

  test("MCP claim_link keeps the link out of the conversation unless reveal is sent (#839)", async () => {
    const call = async (token: string, args: Record<string, unknown>) => {
      const res = await fetch(`${parentServers.url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "claim_link", arguments: args },
        }),
      });
      const r = ((await res.json()) as any).result;
      return { error: r.isError === true, text: r.content[0].text as string };
    };
    // Without reveal nothing is re-issued and no link is in the answer.
    const kept = await call(adminRw, { name: "kai" });
    expect(kept.error).toBe(false);
    expect(kept.text).not.toContain("/claim#");
    expect(JSON.parse(kept.text)).toMatchObject({
      reissued: false,
      says: expect.stringContaining("/forges"),
    });
    // Asked for on purpose: a link, said plainly to be a live secret.
    const shown = await call(adminRw, { name: "kai", reveal: true });
    expect(shown.error).toBe(false);
    const body = JSON.parse(shown.text) as { claimUrl: string; says: string };
    expect(body.claimUrl).toMatch(/\/claim#[A-Za-z0-9_-]{43}$/);
    expect(body.says).toContain("live secret");
    // Revealing is a re-issue: a token that may only read gets nothing.
    const ro = await call(adminRo, { name: "kai", reveal: true });
    expect(ro.error).toBe(true);
    expect(ro.text).not.toContain("/claim#");
  });
});
