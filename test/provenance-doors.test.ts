/**
 * "Show where this came from" through the API and MCP (#3293): a person who
 * administers the repository switches it; an admin agent is refused before
 * anything in the same request is saved; a reader sees the trail only while
 * it is shown.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { addTeamMember, createOrg, listTeams, OWNERS_TEAM } from "../src/core/orgs.ts";
import { getProvenance, recordProvenance } from "../src/core/provenance.ts";
import {
  createRepo,
  forkRepo,
  getRepoById,
  type Repo,
} from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { trailRows } from "../src/tui/screens/about.ts";
import type { Session } from "../src/tui/session.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("the trail through the API and MCP", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let repo: Repo;
  let fork: Repo;
  let botToken = "";
  let founderToken = "";
  let readerToken = "";
  let nextId = 1;

  const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.value;
  };
  const patch = (token: string, body: unknown) =>
    fetch(`${servers.url}/api/v1/repos/acme/arm`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const read = async (token: string) =>
    ((await (
      await fetch(`${servers.url}/api/v1/repos/acme/arm`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()) as { provenance: { source: string } | null }).provenance;
  const tool = async (token: string, name: string, args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: nextId++,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const body = (await res.json()) as any;
    const text: string = body.result.content[0].text;
    return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-provenance-doors-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const person = async (username: string, adminIfFirst: boolean) =>
      ok(
        await createUser(app.db, {
          origin: "seed",
          trusted: true,
          username,
          email: `${username}@forge.local`,
          adminIfFirst,
        }),
      );
    const founder = await person("founder", true);
    const reader = await person("reader", false);
    const org = ok(createOrg(app.db, "acme", founder.id));
    repo = ok(
      await createRepo(app.db, app.reposRoot, { ownerId: org.id, name: "arm", visibility: "public" }),
    );
    ok(
      await createRepo(app.db, app.reposRoot, { ownerId: org.id, name: "plain", visibility: "public" }),
    );
    recordProvenance(app.db, repo.id, {
      url: "https://github.com/Trevato/SO-ARM100",
      parents: ["TheRobotStudio/SO-ARM100"],
    });
    // A fork made here of the migrated one, with no record of its own.
    fork = ok(await forkRepo(app.db, app.reposRoot, repo, reader.id, "arm"));
    const bot = ok(await createAgent(app, founder, { username: "bot" }));
    expect(addToCrew(app, founder, repo, "bot").ok).toBe(true);
    const owners = listTeams(app.db, org.id).find((t) => t.name === OWNERS_TEAM)!;
    addTeamMember(app.db, owners, bot.user.id);
    botToken = createToken(app.db, bot.user.id, "admin", "admin").token;
    founderToken = createToken(app.db, founder.id, "admin", "admin").token;
    readerToken = createToken(app.db, reader.id, "admin", "admin").token;
  }, 30_000);

  afterAll(async () => {
    servers?.stop();
    app?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an admin agent's PATCH saves nothing at all; a person's does both", async () => {
    const refused = await patch(botToken, { description: "renamed", showProvenance: false });
    expect(refused.status).toBe(404);
    expect(getRepoById(app.db, repo.id)!.description).toBe("");
    expect(getProvenance(app.db, repo.id)?.shown).toBe(true);

    expect((await patch(readerToken, { showProvenance: false })).status).toBe(404);
    // The same refusal on a repository with no record: nothing to tell them apart.
    const plainPatch = await fetch(`${servers.url}/api/v1/repos/acme/plain`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${readerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ showProvenance: false }),
    });
    expect(plainPatch.status).toBe(404);
    expect((await patch(founderToken, { showProvenance: "no" })).status).toBe(422);
    expect(getProvenance(app.db, repo.id)?.shown).toBe(true);

    const done = await patch(founderToken, { description: "an arm", showProvenance: false });
    expect(done.status).toBe(200);
    expect(getRepoById(app.db, repo.id)!.description).toBe("an arm");
    expect(getProvenance(app.db, repo.id)?.shown).toBe(false);
    expect(await read(readerToken)).toBeNull();
    expect((await patch(founderToken, { showProvenance: true })).status).toBe(200);
    expect((await read(readerToken))?.source).toBe("github.com/Trevato/SO-ARM100");
  });

  test("MCP: `repo` carries the trail, `trail` plans by default and refuses an agent and a reader", async () => {
    const facts = await tool(readerToken, "repo", { repo: "acme/arm" });
    expect(facts.value.provenance.parents).toEqual([
      { fullName: "TheRobotStudio/SO-ARM100", url: "https://github.com/TheRobotStudio/SO-ARM100" },
    ]);
    expect((await tool(readerToken, "trail", { repo: "acme/arm" })).value).toMatchObject({
      migrated: true,
      shown: true,
    });

    const plan = await tool(founderToken, "trail", { repo: "acme/arm", shown: false });
    expect(plan.value).toMatchObject({ shown: false, was: true, dryRun: true });
    expect(getProvenance(app.db, repo.id)?.shown).toBe(true);

    for (const token of [botToken, readerToken]) {
      const no = await tool(token, "trail", { repo: "acme/arm", shown: false, dryRun: false });
      expect(no.error).toContain("only an admin");
      expect(getProvenance(app.db, repo.id)?.shown).toBe(true);
    }

    const hid = await tool(founderToken, "trail", { repo: "acme/arm", shown: false, dryRun: false });
    expect(hid.value).toMatchObject({ shown: false, dryRun: false });
    expect((await tool(readerToken, "repo", { repo: "acme/arm" })).value.provenance).toBeNull();
    // Hidden from a reader; the record is still the admin's to read.
    // To a reader a hidden trail reads exactly like a repository never migrated.
    const hidden = (await tool(readerToken, "trail", { repo: "acme/arm" })).value;
    const never = (await tool(readerToken, "trail", { repo: "acme/plain" })).value;
    expect(hidden).toEqual({ migrated: false, shown: false, provenance: null });
    expect(hidden).toEqual(never);
    expect(
      (await tool(founderToken, "trail", { repo: "acme/arm" })).value.provenance.source,
    ).toBe("github.com/Trevato/SO-ARM100");
    await tool(founderToken, "trail", { repo: "acme/arm", shown: true, dryRun: false });
    expect(getProvenance(app.db, repo.id)?.shown).toBe(true);
  });

  test("a fork made here inherits the parent's trail through every door, and loses it when the parent hides it", async () => {
    const page = async (): Promise<string> => {
      const text = await (await fetch(`${servers.url}/reader/arm`)).text();
      return /<p class="repo-lineage" data-lineage>[\s\S]*?<\/p>/.exec(text)?.[0] ?? "";
    };
    const api = async () =>
      ((await (await fetch(`${servers.url}/api/v1/repos/reader/arm`)).json()) as {
        provenance: unknown;
      }).provenance;
    const mcp = async () =>
      (await tool(readerToken, "repo", { repo: "reader/arm" })).value.provenance;
    const about = () =>
      trailRows({ db: app.db, user: undefined } as unknown as Session, fork);
    const parentFacts = (await tool(readerToken, "repo", { repo: "acme/arm" })).value.provenance;

    expect(await page()).toContain("forked from");
    expect(await page()).toContain("migrated from");
    expect(await page()).toContain("TheRobotStudio/SO-ARM100");
    expect(await api()).toEqual(parentFacts);
    expect(await mcp()).toEqual(parentFacts);
    expect(about()).toEqual([
      ["migrated from", "github.com/Trevato/SO-ARM100"],
      ["fork of", "TheRobotStudio/SO-ARM100"],
    ]);

    // Only the parent's admin hides it; then no door names it.
    expect((await patch(founderToken, { showProvenance: false })).status).toBe(200);
    try {
      expect(await page()).toContain("forked from");
      expect(await page()).not.toContain("migrated from");
      expect(await api()).toBeNull();
      expect(await mcp()).toBeNull();
      expect(about()).toEqual([]);
    } finally {
      expect((await patch(founderToken, { showProvenance: true })).status).toBe(200);
    }
  });
});
