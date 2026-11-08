/**
 * The standing rule for a repository's decisions is reachable beyond the web
 * form (#1605): the JSON API's repository settings, an MCP tool that plans by
 * default, and a key in the terminal workspace. Only an admin who is not an
 * agent sets it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import type { Agent } from "../src/core/agents.ts";
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
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";
import { listAt } from "./mcp-list.ts";

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
const rule = (): string => getRepoById(app.db, repo.id)!.decisionsBy;

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
  dataDir = await mkdtemp(join(tmpdir(), "forge-decisions-by-"));
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

describe("the standing rule over the API", () => {
  test("anyone but an admin who is a person is refused", async () => {
    for (const who of ["dev", "mallory", "bot"]) {
      const res = await patch(admin[who]!, { decisionsBy: "decider" });
      expect(res.status).toBe(404);
      expect(rule()).toBe("me");
    }
  });

  test("the admin sets it and reads it back; a stranger value is refused", async () => {
    const set = await patch(admin["founder"]!, { decisionsBy: "decider_tell" });
    expect(set.status).toBe(200);
    expect(((await set.json()) as { decisionsBy: string }).decisionsBy).toBe("decider_tell");
    expect(rule()).toBe("decider_tell");
    expect((await patch(admin["founder"]!, { decisionsBy: "anyone" })).status).toBe(422);
    expect((await patch(admin["founder"]!, { description: "x" })).status).toBe(200);
    expect(rule()).toBe("decider_tell");
    const read = await fetch(`${servers.url}/api/v1/repos/acme/svc`, {
      headers: { authorization: `Bearer ${admin["mallory"]}` },
    });
    expect(((await read.json()) as { decisionsBy: string }).decisionsBy).toBe("decider_tell");
    await patch(admin["founder"]!, { decisionsBy: "me" });
  });
});

describe("the standing rule over MCP", () => {
  test("without `by` it says how it is set; with `by` it plans unless told otherwise", async () => {
    const said = await mcp(admin["mallory"]!, "decisions_by", { repo: "acme/svc" });
    expect(said.value.by).toBe("me");
    const planned = await mcp(admin["founder"]!, "decisions_by", {
      repo: "acme/svc",
      by: "decider",
    });
    expect(planned.value).toMatchObject({ dryRun: true, by: "decider", was: "me" });
    expect(rule()).toBe("me");
  });

  test("a writer, a reader and an agent cannot set it, nor plan it; a bad value is refused", async () => {
    for (const who of ["dev", "mallory", "bot"])
      for (const dryRun of [true, false]) {
        const tried = await mcp(admin[who]!, "decisions_by", {
          repo: "acme/svc",
          by: "decider",
          dryRun,
        });
        expect(tried.error).toContain("forbidden");
        expect(rule()).toBe("me");
      }
    const odd = await mcp(admin["founder"]!, "decisions_by", { repo: "acme/svc", by: "x" });
    expect(odd.error).toContain("me, decider or decider_tell");
  });

  test("the admin needs an admin token to set it", async () => {
    const rw = createToken(app.db, founder.id, "rw", "rw").token;
    const refused = await mcp(rw, "decisions_by", { repo: "acme/svc", by: "decider", dryRun: false });
    expect(refused.error).toContain("forbidden");
    expect(rule()).toBe("me");
    const set = await mcp(admin["founder"]!, "decisions_by", {
      repo: "acme/svc",
      by: "decider",
      dryRun: false,
    });
    expect(set.value).toMatchObject({ dryRun: false, by: "decider", was: "me" });
    expect(rule()).toBe("decider");
  });

  test("asks_decide no longer takes a `by`", async () => {
    const list = (await listAt(servers.url, admin["founder"]!)).result.tools as any[];
    expect(list.find((t) => t.name === "asks_decide").inputSchema.properties.by).toBeUndefined();
  });
});

describe("the standing rule in the terminal", () => {
  test("R cycles it for an admin who is a person, and says so", async () => {
    app.db.run("UPDATE repo SET decisions_by = 'me' WHERE id = ?1", [repo.id]);
    const terminal = headlessTerminal(160, 40);
    const { app: tui } = createForgeApp(
      app,
      { sshUsername: "founder", remoteAddress: "127.0.0.1", fingerprint: "SHA256:t", user: founder },
      { terminal, exitHooks: false },
    );
    tui.start();
    const press = async (...keys: string[]) => {
      for (const key of keys) {
        tui.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
        await settleApp(tui);
      }
    };
    await press("/");
    for (const ch of "svc") await press(ch);
    await press("enter", "enter");
    await press("R");
    expect(rule()).toBe("decider");
    expect(tui.screen.toText()).toContain("decisions here go by decider");
    await press("R");
    expect(rule()).toBe("decider_tell");
    tui.stop();
  });

  test("a reader's R changes nothing", async () => {
    app.db.run("UPDATE repo SET decisions_by = 'me' WHERE id = ?1", [repo.id]);
    const terminal = headlessTerminal(160, 40);
    const { app: tui } = createForgeApp(
      app,
      { sshUsername: "mallory", remoteAddress: "127.0.0.1", fingerprint: "SHA256:t", user: mallory },
      { terminal, exitHooks: false },
    );
    tui.start();
    const press = async (...keys: string[]) => {
      for (const key of keys) {
        tui.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
        await settleApp(tui);
      }
    };
    await press("/");
    for (const ch of "svc") await press(ch);
    await press("enter", "enter", "R");
    expect(rule()).toBe("me");
    tui.stop();
  });
});
