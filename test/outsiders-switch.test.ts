/**
 * "Outsiders may trigger the crew" is reachable beyond the web form (#755):
 * the JSON API's repository settings and an MCP tool that plans by default.
 * Only an admin of the repository sets it — a writer who is not admin, a
 * reader and an agent (even one on the owners' team) are refused — and the
 * map and `audit` say which way it is set.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import type { Agent } from "../src/core/agents.ts";
import { listEvents } from "../src/core/events.ts";
import {
  addTeamMember,
  createOrg,
  createTeam,
  listTeams,
  OWNERS_TEAM,
} from "../src/core/orgs.ts";
import { createRepo, getRepoById, type Repo } from "../src/core/repos.ts";
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
let mallory: User;
let bot: Agent;
let repo: Repo;
const admin: Record<string, string> = {};

const ok = <T>(
  r: { ok: true; value: T } | { ok: false; error: unknown },
): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};
const outsiders = (): boolean => getRepoById(app.db, repo.id)!.crewOutsiders;

const patch = (token: string, body: unknown) =>
  fetch(`${servers.url}/api/v1/repos/acme/svc`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

async function mcp(
  token: string,
  name: string,
  args: unknown,
): Promise<{ error?: string; value?: any }> {
  const res = await fetch(`${servers.url}/mcp`, {
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
      params: { name, arguments: args },
    }),
  });
  const body = (await res.json()) as any;
  const text: string = body.result.content[0].text;
  return body.result.isError === true
    ? { error: text }
    : { value: JSON.parse(text) };
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-outsiders-"));
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
  mallory = await make("mallory");
  const org = ok(createOrg(app.db, "acme", founder.id));
  const writers = ok(createTeam(app.db, org.id, "Writers", "write"));
  addTeamMember(app.db, writers, dev.id);
  repo = ok(
    await createRepo(app.db, app.reposRoot, {
      ownerId: org.id,
      name: "svc",
      visibility: "public",
    }),
  );
  bot = ok(await createAgent(app, founder, { username: "bot" }));
  expect(addToCrew(app, founder, repo, "bot").ok).toBe(true);
  // The hardest agent to refuse: on the team that administers the repository.
  const owners = listTeams(app.db, org.id).find((t) => t.name === OWNERS_TEAM)!;
  addTeamMember(app.db, owners, bot.user.id);
  for (const u of [founder, dev, mallory, bot.user])
    admin[u.username] = createToken(app.db, u.id, "admin", "admin").token;
}, 30_000);

afterAll(async () => {
  servers?.stop();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("the outsiders switch over the API", () => {
  test("a writer who is not admin, a reader and an agent cannot change it", async () => {
    for (const who of ["dev", "mallory", "bot"]) {
      const res = await patch(admin[who]!, { crewOutsiders: true });
      expect(res.status).toBe(404);
      expect(outsiders()).toBe(false);
    }
  });

  test("the repository's admin sets it, and the change is recorded", async () => {
    const on = await patch(admin["founder"]!, { crewOutsiders: true });
    expect(on.status).toBe(200);
    expect(
      ((await on.json()) as { crewOutsiders: boolean }).crewOutsiders,
    ).toBe(true);
    expect(outsiders()).toBe(true);
    const off = await patch(admin["founder"]!, { crewOutsiders: false });
    expect(off.status).toBe(200);
    expect(outsiders()).toBe(false);
    const recorded = listEvents(app.db, { repoId: repo.id })
      .filter((e) => e.kind === "repo.crew_outsiders")
      .map((e) => e.payload["on"]);
    // Newest first: on, then off.
    expect(recorded).toEqual([false, true]);
  });
});

describe("the outsiders switch over MCP", () => {
  test("without `on` it says which way it is set; with `on` it plans unless told otherwise", async () => {
    const said = await mcp(admin["mallory"]!, "outsiders", {
      repo: "acme/svc",
    });
    expect(said.value.on).toBe(false);
    const planned = await mcp(admin["founder"]!, "outsiders", {
      repo: "acme/svc",
      on: true,
    });
    expect(planned.value).toMatchObject({ dryRun: true, on: true, was: false });
    expect(outsiders()).toBe(false);
  });

  test("a writer who is not admin, a reader and an agent cannot set it, nor plan it", async () => {
    for (const who of ["dev", "mallory", "bot"])
      for (const dryRun of [true, false]) {
        const tried = await mcp(admin[who]!, "outsiders", {
          repo: "acme/svc",
          on: true,
          dryRun,
        });
        expect(tried.error).toContain("forbidden");
        expect(outsiders()).toBe(false);
      }
  });

  test("the admin needs an admin token to set it", async () => {
    const rw = createToken(app.db, founder.id, "rw", "rw").token;
    const refused = await mcp(rw, "outsiders", {
      repo: "acme/svc",
      on: true,
      dryRun: false,
    });
    expect(refused.error).toContain("forbidden");
    expect(outsiders()).toBe(false);
    const set = await mcp(admin["founder"]!, "outsiders", {
      repo: "acme/svc",
      on: true,
      dryRun: false,
    });
    expect(set.value).toMatchObject({ dryRun: false, on: true, was: false });
    expect(outsiders()).toBe(true);
  });
});

describe("the map and audit say which way it is set", () => {
  test("both report the switch", async () => {
    const map = await fetch(`${servers.url}/api/v1/repos/acme/svc/map`, {
      headers: { authorization: `Bearer ${admin["mallory"]}` },
    });
    expect(
      ((await map.json()) as { crewOutsiders: boolean }).crewOutsiders,
    ).toBe(outsiders());
    const audited = await mcp(admin["founder"]!, "audit", { repo: "acme/svc" });
    expect(audited.value[0].crewOutsiders).toBe(outsiders());
    const mapTool = await mcp(admin["founder"]!, "map", { app: "acme/svc" });
    expect(mapTool.value.crewOutsiders).toBe(outsiders());
  });
});

describe("no door flips the switch by leaving it out", () => {
  test("a settings form without the switch (the studio's About card) leaves it as it is; the settings page's form sets it", async () => {
    const post = (fields: Record<string, string>) =>
      fetch(`${servers.url}/acme/svc/settings`, {
        method: "POST",
        headers: { authorization: `Bearer ${admin["founder"]}` },
        body: new URLSearchParams(fields),
        redirect: "manual",
      });
    const before = outsiders();
    expect(before).toBe(true);
    // Saved from a form that does not show the switch: unchanged.
    expect(
      (await post({ description: "About", visibility: "public" })).status,
    ).toBe(303);
    expect(outsiders()).toBe(true);
    // The PATCH without the field: unchanged.
    expect((await patch(admin["founder"]!, { description: "Again" })).status).toBe(200);
    expect(outsiders()).toBe(true);
    // The settings page shows it: unchecked there turns it off.
    expect(
      (
        await post({
          description: "About",
          visibility: "public",
          crewOutsidersShown: "1",
        })
      ).status,
    ).toBe(303);
    expect(outsiders()).toBe(false);
  });
});
