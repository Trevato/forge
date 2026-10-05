/**
 * A spawned child's own keys and domain (#576): its secret key and SSH host
 * key are made in its own directory and are not the parent's; nothing in
 * its config points into the parent; its address is <name>.<parent's host>
 * and its home shows it; it prints FORGE_APP_SSH verbatim or says the
 * terminal is off. And the one credential a spawner may hand a child — an
 * API-billed model key with a daily cap — is sealed with the child's key,
 * never kept or echoed by the parent, never a subscription token, and never
 * passed through an agent.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { childDirOf, STARTER_KEY } from "../src/actions/spawn.ts";
import { createApp, type App } from "../src/app.ts";
import { getRepo } from "../src/core/repos.ts";
import {
  crewHasCredential,
  getSubscriptionByName,
  listGrants,
} from "../src/core/subscriptions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { getOrg } from "../src/core/orgs.ts";
import { commitFiles } from "../src/git/write.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { loadKey, open } from "../src/kernel/secret.ts";
import { firstBoot } from "../src/spawn/first-boot.ts";
import { loadOrCreateHostKey } from "../src/ssh/keys.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const author = { name: "a", email: "a@x.invalid" };
const API_KEY = "sk-ant-api03-child-key-AAAAAAAAAAAAAAAAAAAAAAAA";
const OAUTH = "sk-ant-oat01-a-persons-own-plan-BBBBBBBBBBBBBBBB";

describe("a spawned child's own keys and domain", () => {
  let dir = "";
  let parent: App;
  let alice: User;
  let servers: Servers;
  let rw = "";
  let childDir = "";
  let spawnBody = "";

  const post = (
    body: Record<string, unknown>,
    extra: Record<string, string> = {},
  ) =>
    fetch(`${servers.url}/api/v1/forges`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${rw}`,
        "content-type": "application/json",
        ...extra,
      },
      body: JSON.stringify(body),
    });

  async function textUnder(root: string): Promise<string> {
    let out = "";
    for (const e of await readdir(root, {
      recursive: true,
      withFileTypes: true,
    }).catch(() => []))
      if (e.isFile())
        out += await Bun.file(join(e.parentPath, e.name))
          .text()
          .catch(() => "");
    return out;
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-child-keys-"));
    parent = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
    // The parent's own keys, so there is something not to copy.
    loadKey(dir);
    loadOrCreateHostKey(join(dir, "ssh"));
    const made = await createUser(parent.db, {
      username: "alice",
      email: "a@x.invalid",
      password: "a-long-passphrase-1",
      isAdmin: true,
    });
    if (!made.ok) throw new Error("user");
    alice = made.value;
    const repo = await createRepo(parent, alice, { name: "bakery" });
    if (!repo.ok) throw new Error("repo");
    const c = await commitFiles(repoDir(parent.reposRoot, "alice", "bakery"), {
      branch: "main",
      message: "bakery",
      files: [{ path: "README.md", content: "# bakery\n" }],
      author,
    });
    if (!c.ok) throw new Error("commit");
    rw = createToken(parent.db, alice.id, "rw", "rw").token;
    servers = await serve(parent);
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    parent.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("a subscription token never goes to a child, and a key needs a cap", async () => {
    const oauth = await post({
      name: "maria",
      apps: ["alice/bakery"],
      dryRun: false,
      modelKey: OAUTH,
      keyCapUsd: 5,
    });
    expect(oauth.status).toBe(422);
    expect(await oauth.text()).toContain(
      "a subscription token is a person's own plan",
    );
    expect(
      (
        await post({
          name: "maria",
          apps: ["alice/bakery"],
          dryRun: false,
          modelKey: API_KEY,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await post({
          name: "maria",
          apps: ["alice/bakery"],
          dryRun: false,
          keyCapUsd: 5,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await post({
          name: "maria",
          apps: ["alice/bakery"],
          dryRun: false,
          modelKey: API_KEY,
          keyCapUsd: 0,
        })
      ).status,
    ).toBe(422);
  });

  test("the MCP refuses to carry a model key", async () => {
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
          name: "spawn",
          arguments: {
            name: "maria",
            apps: ["alice/bakery"],
            dryRun: false,
            modelKey: API_KEY,
            keyCapUsd: 5,
          },
        },
      }),
    });
    const body = (await res.json()) as any;
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain(
      "never travels through an agent",
    );
  });

  test("a child is made with a capped API key; the answer and the dry run never show it", async () => {
    const dry = await post({
      name: "maria",
      apps: ["alice/bakery"],
      modelKey: API_KEY,
      keyCapUsd: 5,
    });
    expect(dry.status).toBe(200);
    const dryText = await dry.text();
    expect(dryText).not.toContain(API_KEY);
    expect(dryText).toContain("capped at $5 a day per app");
    const res = await post(
      {
        name: "maria",
        apps: ["alice/bakery"],
        dryRun: false,
        modelKey: API_KEY,
        keyCapUsd: 5,
      },
      { "idempotency-key": "maria-1" },
    );
    expect(res.status).toBe(201);
    spawnBody = await res.text();
    expect(spawnBody).not.toContain(API_KEY);
    childDir = childDirOf(
      parent,
      (JSON.parse(spawnBody) as { bodyId: string }).bodyId,
    );
  });

  test("nothing the parent keeps holds the key: not its database, ledger or idempotency table", async () => {
    const outside = (await textUnder(dir)).replaceAll(
      await textUnder(childDir),
      "",
    );
    expect(outside).not.toContain(API_KEY);
    const rows = parent.db.query("SELECT body FROM idempotency").all() as {
      body: string;
    }[];
    expect(rows.every((r) => !r.body.includes(API_KEY))).toBe(true);
    // In the child, it is sealed: nowhere in clear text either.
    expect(await textUnder(childDir)).not.toContain(API_KEY);
  });

  test("the child's secret key and SSH host key are its own", async () => {
    const parentKey = await Bun.file(join(dir, "secret.key")).bytes();
    const childKey = await Bun.file(join(childDir, "secret.key")).bytes();
    expect(childKey.length).toBe(32);
    expect(Buffer.from(childKey).equals(Buffer.from(parentKey))).toBe(false);
    const parentHost = await Bun.file(join(dir, "ssh", "host_ed25519")).text();
    const childHost = await Bun.file(
      join(childDir, "ssh", "host_ed25519"),
    ).text();
    expect(childHost).toContain("PRIVATE KEY");
    expect(childHost).not.toBe(parentHost);
  });

  test("the key is sealed with the child's key, opens only there, and is offered to its organisation", () => {
    const child = createApp({ dataDir: childDir, port: 0 });
    try {
      const sub = getSubscriptionByName(child.db, STARTER_KEY)!;
      expect(sub.kind).toBe("api_key");
      const row = child.db
        .query("SELECT token_enc FROM subscription WHERE id = ?1")
        .get(sub.id) as { token_enc: string };
      expect(open(childDir, row.token_enc, `subscription:${sub.id}`)).toEqual({
        ok: true,
        value: API_KEY,
      });
      expect(open(dir, row.token_enc, `subscription:${sub.id}`).ok).toBe(false);
      const org = getOrg(child.db, "maria")!;
      expect(listGrants(child.db, org.id).map((g) => g.subscriptionId)).toEqual(
        [sub.id],
      );
      expect(getRepo(child.db, "maria", "bakery")!.autonomyCeilingUsd).toBe(5);
      expect(crewHasCredential(child.db, {})).toBe(true);
    } finally {
      child.close();
    }
  });

  test("nothing in the child's config points into the parent", async () => {
    const child = createApp({ dataDir: childDir, port: 0 });
    try {
      for (const value of [child.config.dataDir, child.reposRoot])
        expect(relative(childDir, value).startsWith("..")).toBe(false);
      const record = JSON.parse(
        await Bun.file(join(childDir, "parent.json")).text(),
      ) as Record<string, unknown>;
      expect(Object.keys(record).sort()).toEqual([
        "keepAccess",
        "name",
        "org",
        "upstream",
        "url",
      ]);
      expect(JSON.stringify(record)).not.toContain(dir);
    } finally {
      child.close();
    }
  });

  test("the child's address is <name>.<parent's host>, recorded and shown on its home", async () => {
    const record = JSON.parse(
      await Bun.file(join(childDir, "parent.json")).text(),
    ) as { url: string };
    expect(record.url).toBe("https://maria.forge.test");
    const child = createApp({ dataDir: childDir, port: 0 });
    await firstBoot(child);
    const childServers = await serve(child);
    try {
      const token = (
        JSON.parse(spawnBody) as { claimUrl: string }
      ).claimUrl.split("/claim/")[1]!;
      const claimed = await fetch(`${childServers.url}/claim/${token}`, {
        method: "POST",
        headers: { origin: childServers.url },
        body: new URLSearchParams({
          username: "maria-owner",
          email: "m@x.test",
          password: "a-long-maria-passphrase",
        }),
        redirect: "manual",
      });
      expect(claimed.status).toBe(303);
      const cookie = (claimed.headers.get("set-cookie") ?? "").split(";")[0]!;
      const home = (
        await (
          await fetch(`${childServers.url}/`, { headers: { cookie } })
        ).text()
      ).replace(/\s+/g, " ");
      expect(home).toContain(
        'Your forge: <a href="https://maria.forge.test">maria.forge.test</a>',
      );
      // No SSH of its own and no host command: the keys page says the terminal is off.
      const keys = await (
        await fetch(`${childServers.url}/settings/keys`, {
          headers: { cookie },
        })
      ).text();
      expect(keys).toContain("The terminal is off on this forge.");
      // Given FORGE_APP_SSH by its host, it prints that verbatim.
      child.config.appSsh = "ssh -p 2222 maria@forge.test";
      const keys2 = await (
        await fetch(`${childServers.url}/settings/keys`, {
          headers: { cookie },
        })
      ).text();
      expect(keys2).toContain("ssh -p 2222 maria@forge.test");
      expect(keys2).not.toContain("The terminal is off on this forge.");
    } finally {
      childServers.stop();
      child.close();
    }
  });
});
