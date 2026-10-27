/**
 * A repository's FLOW ONLY switch (#6392): one setting its admin reads and
 * sets from Settings, the API and the MCP. A writer who is not admin is
 * refused at every door; turning it on makes the `flow` label. Nothing obeys
 * it yet.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { listLabels } from "../src/core/issues.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import type { Agent } from "../src/core/agents.ts";
import { addTeamMember, createOrg, createTeam, listTeams, OWNERS_TEAM } from "../src/core/orgs.ts";
import { createRepo, getRepoById, type Repo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let founder: User;
let dev: User;
let repo: Repo;
let bot: Agent;
const token: Record<string, string> = {};

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};
const flowOnly = (): boolean => getRepoById(app.db, repo.id)!.flowOnly;
const hasLabel = (): boolean =>
  listLabels(app.db, repo.id).some((l) => l.name === "flow");

const patch = (who: string, body: unknown) =>
  fetch(`${servers.url}/api/v1/repos/acme/svc`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token[who]}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function mcp(who: string, args: unknown): Promise<{ error?: string; value?: any }> {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token[who]}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "repo_settings", arguments: args },
    }),
  });
  const body = (await res.json()) as any;
  const text: string = body.result.content[0].text;
  return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
}

const web = (who: User, value: string, headers: Record<string, string> = {}) =>
  fetch(`${servers.url}/acme/svc/settings/flow-only`, {
    method: "POST",
    headers: {
      cookie: `forge_session=${createSession(app.db, who.id).token}`,
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body: new URLSearchParams({ flowOnly: value }),
    redirect: "manual",
  });

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-flow-only-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const make = async (username: string) =>
    ok(
      await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: true,
      }),
    );
  founder = await make("founder");
  dev = await make("dev");
  const org = ok(createOrg(app.db, "acme", founder.id));
  const writers = ok(createTeam(app.db, org.id, "Writers", "write"));
  addTeamMember(app.db, writers, dev.id);
  repo = ok(
    await createRepo(app.db, app.reposRoot, { ownerId: org.id, name: "svc", visibility: "public" }),
  );
  bot = ok(await createAgent(app, founder, { username: "bot" }));
  expect(addToCrew(app, founder, repo, "bot").ok).toBe(true);
  // The hardest agent to refuse: on the team that administers the repository.
  const owners = listTeams(app.db, org.id).find((t) => t.name === OWNERS_TEAM)!;
  addTeamMember(app.db, owners, bot.user.id);
  for (const u of [founder, dev, bot.user]) token[u.username] = createToken(app.db, u.id, "admin", "admin").token;
}, 30_000);

afterAll(async () => {
  servers?.stop();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("FLOW ONLY", () => {
  test("it starts off, and the API says so", async () => {
    expect(flowOnly()).toBe(false);
    const res = await fetch(`${servers.url}/api/v1/repos/acme/svc`);
    expect(((await res.json()) as { flowOnly: boolean }).flowOnly).toBe(false);
  });

  test("a writer who is not admin is refused at every door", async () => {
    expect((await patch("dev", { flowOnly: true })).status).toBe(404);
    expect((await mcp("dev", { repo: "acme/svc", flowOnly: true })).error).toBeDefined();
    const refused = await web(dev, "1");
    expect(refused.status).toBe(404);
    expect(flowOnly()).toBe(false);
    expect(hasLabel()).toBe(false);
  });

  test("an agent that administers the repository cannot switch it, on or off", async () => {
    expect((await patch("bot", { flowOnly: true })).status).toBe(404);
    expect((await mcp("bot", { repo: "acme/svc", flowOnly: true })).error).toBeDefined();
    expect(flowOnly()).toBe(false);
    await patch("founder", { flowOnly: true });
    expect((await patch("bot", { flowOnly: false })).status).toBe(404);
    expect((await mcp("bot", { repo: "acme/svc", flowOnly: false })).error).toBeDefined();
    expect(flowOnly()).toBe(true);
    await patch("founder", { flowOnly: false });
  });

  test("Settings draws the form for an admin only, not a writer or a guest", async () => {
    const seen = async (headers: Record<string, string>) =>
      (await fetch(`${servers.url}/acme/svc/settings`, { headers })).text();
    const asDev = `forge_session=${createSession(app.db, dev.id).token}`;
    expect(await seen({ cookie: asDev })).not.toContain('id="flow-only"');
    expect(await seen({})).not.toContain('id="flow-only"');
    const asFounder = `forge_session=${createSession(app.db, founder.id).token}`;
    expect(await seen({ cookie: asFounder })).toContain('id="flow-only"');
  });

  test("the API's admin turns it on, with its label, and off", async () => {
    const on = await patch("founder", { flowOnly: true });
    expect(on.status).toBe(200);
    expect(((await on.json()) as { flowOnly: boolean }).flowOnly).toBe(true);
    expect(flowOnly()).toBe(true);
    expect(hasLabel()).toBe(true);
    expect((await patch("founder", { flowOnly: false })).status).toBe(200);
    expect(flowOnly()).toBe(false);
    // Turning it on again does not make a second label.
    await patch("founder", { flowOnly: true });
    expect(listLabels(app.db, repo.id).filter((l) => l.name === "flow").length).toBe(1);
    await patch("founder", { flowOnly: false });
  });

  test("a non-boolean is a 422 and nothing changes", async () => {
    expect((await patch("founder", { flowOnly: "yes" })).status).toBe(422);
    expect(flowOnly()).toBe(false);
  });

  test("the MCP's admin reads, turns it on and off", async () => {
    expect((await mcp("founder", { repo: "acme/svc" })).value.flowOnly).toBe(false);
    expect((await mcp("founder", { repo: "acme/svc", flowOnly: true })).value.flowOnly).toBe(true);
    expect(flowOnly()).toBe(true);
    expect((await mcp("founder", { repo: "acme/svc", flowOnly: false })).value.flowOnly).toBe(false);
    expect(flowOnly()).toBe(false);
    expect((await mcp("founder", { repo: "acme/svc", flowOnly: "no" })).error).toBeDefined();
  });

  test("Settings shows it to the admin, and its form turns it on and off", async () => {
    const cookie = `forge_session=${createSession(app.db, founder.id).token}`;
    const page = await (await fetch(`${servers.url}/acme/svc/settings`, { headers: { cookie } })).text();
    expect(page).toContain("Flow only:");
    expect((await web(founder, "1")).status).toBe(303);
    expect(flowOnly()).toBe(true);
    expect((await web(founder, "0")).status).toBe(303);
    expect(flowOnly()).toBe(false);
    expect((await web(founder, "2")).status).toBe(303);
    expect(flowOnly()).toBe(false);
  });

  test("the form refuses a foreign Origin before it writes", async () => {
    const res = await web(founder, "1", { origin: "http://evil.example" });
    expect(res.status).toBe(403);
    expect(flowOnly()).toBe(false);
  });
});
