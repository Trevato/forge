/**
 * A spawned child's own keys and domain (#576): its secret key and SSH host
 * key are made in its own directory and are not the parent's; nothing in
 * its config points into the parent; its address is <name>--<parent's host>
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
import { createRun } from "../src/core/runs.ts";
import {
  budgetsOf,
  crewHasCredential,
  getSubscriptionByName,
  listGrants,
  pickSubscription,
  setBudget,
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
import { passkeyFields } from "./helpers/passkey.ts";

quietLogs();

const author = { name: "a", email: "a@x.invalid" };
const API_KEY = "sk-ant-api03-child-key-AAAAAAAAAAAAAAAAAAAAAAAA";
const OAUTH = "sk-ant-oat01-a-persons-own-plan-BBBBBBBBBBBBBBBB";
const OR_KEY = "sk-or-v1-child-openrouter-key-CCCCCCCCCCCCCCCC";

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
      origin: "seed",
      trusted: true,
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

  test("a setup-token or a subscription's credits key may go to a child under a budget; a key needs a budget; an empty key is refused", async () => {
    const oauth = await post({
      name: "maria",
      apps: ["alice/bakery"],
      dryRun: true,
      modelKey: OAUTH,
      budgetUsd: 5,
    });
    expect(oauth.status).toBe(200);
    expect(await oauth.json()).toMatchObject({ dryRun: true });
    const credits = await post({
      name: "maria",
      apps: ["alice/bakery"],
      dryRun: true,
      modelKey: "sk-ant-usr01-credits-that-come-with-the-plan-CCCCCCCC",
      budgetUsd: 5,
    });
    expect(credits.status).toBe(200);
    const gatewayForOauth = await post({
      name: "maria",
      apps: ["alice/bakery"],
      dryRun: true,
      modelKey: OAUTH,
      modelEndpoint: "https://openrouter.ai/api",
      budgetUsd: 5,
    });
    expect(gatewayForOauth.status).toBe(422);
    expect(await gatewayForOauth.text()).toContain("takes no base URL");
    const spaced = await post({
      name: "maria",
      apps: ["alice/bakery"],
      dryRun: true,
      modelKey: " \u200b ",
      budgetUsd: 5,
    });
    expect(spaced.status).toBe(422);
    expect(await spaced.text()).toContain("is empty");
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
          budgetUsd: 5,
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
          budgetUsd: 0,
        })
      ).status,
    ).toBe(422);
    // OpenRouter key + gateway URL is a valid plan (dry run — no child yet).
    const orPlan = await post({
      name: "orchild",
      apps: ["alice/bakery"],
      dryRun: true,
      modelKey: OR_KEY,
      modelEndpoint: "https://openrouter.ai/api/v1",
      budgetUsd: 5,
    });
    expect(orPlan.status).toBe(200);
    expect(await orPlan.json()).toMatchObject({ dryRun: true });
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
            budgetUsd: 5,
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

  test("a child is made with an API key and a budget; the answer and the dry run never show the key", async () => {
    const dry = await post({
      name: "maria",
      apps: ["alice/bakery"],
      modelKey: API_KEY,
      budgetUsd: 5,
    });
    expect(dry.status).toBe(200);
    const dryText = await dry.text();
    expect(dryText).not.toContain(API_KEY);
    expect(dryText).toContain("with a $5 budget it cannot raise");
    expect(dryText).toContain("use a key from a workspace with its own spend limit");
    const res = await post(
      {
        name: "maria",
        apps: ["alice/bakery"],
        dryRun: false,
        // Pasted with a Bearer prefix and a trailing newline: the child gets the key itself.
        modelKey: ` Bearer ${API_KEY}\n`,
        budgetUsd: 5,
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
      // The budget is on the key, locked; no repository ceiling is touched.
      expect(budgetsOf(child.db).get(sub.id)).toEqual({ budgetUsd: 5, spentUsd: 0, locked: true });
      expect(setBudget(child.db, sub.id, 1000)).toBe(false);
      expect(getRepo(child.db, "maria", "bakery")!.autonomyCeilingUsd).not.toBe(5);
      expect(crewHasCredential(child.db, {})).toBe(true);
    } finally {
      child.close();
    }
  });

  test("a retry with another key is refused plainly; the same key answers that the child exists", async () => {
    const other = await post({ name: "maria", apps: ["alice/bakery"], dryRun: false, modelKey: `${API_KEY}-other`, budgetUsd: 5 });
    expect(other.status).toBe(409);
    expect(await other.text()).toContain("already given a different model key");
    const same = await post({ name: "maria", apps: ["alice/bakery"], dryRun: false, modelKey: API_KEY, budgetUsd: 5 });
    expect(same.status).toBe(200);
    expect(((await same.json()) as { existed: boolean }).existed).toBe(true);
    // The same key pasted untidily is the same key: compared cleaned, not refused as another.
    const padded = await post({ name: "maria", apps: ["alice/bakery"], dryRun: false, modelKey: `\tbearer ${API_KEY} \n`, budgetUsd: 5 });
    expect(padded.status).toBe(200);
  });

  test("once the starter budget is spent, a run in the child gets no account: an assigned one, on any repository of its org", async () => {
    const child = createApp({ dataDir: childDir, port: 0 });
    try {
      const sub = getSubscriptionByName(child.db, STARTER_KEY)!;
      const org = getOrg(child.db, "maria")!;
      const bakery = getRepo(child.db, "maria", "bakery")!;
      // Any agent, any reason (a person's assignment included): the pick is the gate.
      const scope = { repoId: bakery.id, ownerId: org.id, agentId: "someone" };
      expect(pickSubscription(child.db, childDir, scope, new Date()).kind).toBe("ready");
      const run = createRun(child.db, { repoId: bakery.id, kind: "agent", reason: "assigned" });
      child.db.query("UPDATE run SET subscription_id = ?1, cost_usd = ?2 WHERE id = ?3").run(sub.id, 5, run.id);
      const spent = pickSubscription(child.db, childDir, scope, new Date());
      expect(spent.kind).toBe("resting");
      expect(spent.kind === "resting" && spent.said).toContain("$5 budget is spent");
      // A repository made in the org later is covered by the same org grant.
      const later = { repoId: "a-new-repository", ownerId: org.id, agentId: "someone" };
      expect(pickSubscription(child.db, childDir, later, new Date()).kind).toBe("resting");
      // Deleting the repository its runs were on gives nothing back: the
      // spend is a counter that only grows (#815).
      child.db.query("DELETE FROM repo WHERE id = ?1").run(bakery.id);
      expect(child.db.query("SELECT COUNT(*) AS n FROM run").get()).toEqual({ n: 0 });
      expect(budgetsOf(child.db).get(sub.id)!.spentUsd).toBe(5);
      expect(pickSubscription(child.db, childDir, later, new Date()).kind).toBe("resting");
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
        "anonymous",
        "apps",
        "beatKey",
        "keepAccess",
        "name",
        "org",
        "size",
        // The hash of the parent's status secret (#776): the child keeps only
        // the hash, so this names nothing in the parent and reveals no secret.
        "statusHash",
        "upstream",
        "url",
      ]);
      expect(JSON.stringify(record)).not.toContain(dir);
      expect(String(record["statusHash"])).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      child.close();
    }
  });

  test("the child's address is <name>--<parent's host>, recorded and shown on its home", async () => {
    const record = JSON.parse(
      await Bun.file(join(childDir, "parent.json")).text(),
    ) as { url: string };
    expect(record.url).toBe("https://maria--forge.test");
    const child = createApp({ dataDir: childDir, port: 0 });
    await firstBoot(child);
    const childServers = await serve(child);
    try {
      const token = (
        JSON.parse(spawnBody) as { claimUrl: string }
      ).claimUrl.split("/claim#")[1]!;
      const claimed = await fetch(`${childServers.url}/claim`, {
        method: "POST",
        headers: { origin: childServers.url },
        body: new URLSearchParams({
          ...{ token, username: "maria-owner", email: "m@x.test" },
          ...(await passkeyFields(childServers.url, "/claim/options", { token, username: "maria-owner", email: "m@x.test" })),
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
        'Your forge: <a href="https://maria--forge.test">maria--forge.test</a>',
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
