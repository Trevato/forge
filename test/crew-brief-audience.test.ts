/**
 * A crew agent's brief, model and budget are the owner's configuration
 * (#946). A stranger and a reader see the crew's names and what they do;
 * the repository's writers, its crew and the forge's owner see the rest.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../src/actions/crew.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { addCrew } from "../src/core/agents.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

const BRIEF = "Q7BRIEFWORDS look after the parser";

describe("a crew agent's brief is the owner's configuration", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let olive: User;
  let rita: User;
  let wren: User;
  let scout: User;
  const token: Record<string, string> = {};

  const person = async (username: string, adminIfFirst = false) => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@f.dev`,
      password: "a-good-passphrase",
      adminIfFirst,
    });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  const get = (path: string, who?: string) =>
    fetch(`${servers.url}${path}`, {
      headers: who === undefined ? {} : { authorization: `Bearer ${token[who]}` },
    });
  const said = async (path: string, who?: string) => {
    const res = await get(path, who);
    return { status: res.status, text: await res.text() };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-crew-brief-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    olive = await person("olive", true);
    rita = await person("rita");
    wren = await person("wren");
    promote(app.db, wren);
    const made = await createAgent(app, olive, {
      username: "scout",
      brief: BRIEF,
      model: "q7model",
      budgetUsd: 7,
    });
    if (!made.ok) throw new Error(String(made.error));
    scout = made.value.user;
    // wren writes the public repository; rita only reads it.
    const repo = await createRepo(app, wren, { name: "lab", visibility: "public" });
    if (!repo.ok) throw new Error(String(repo.error));
    addCrew(app.db, repo.value.id, scout.id, wren.id);
    for (const u of [olive, rita, wren, scout])
      token[u.username] = createToken(app.db, u.id, "t", "ro").token;
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const hidden = (text: string) => {
    expect(text).not.toContain("Q7BRIEFWORDS");
    expect(text).not.toContain("q7model");
    expect(text).not.toContain("budgetUsd");
  };

  test("a stranger and a reader see the crew's names, never its brief, model or budget", async () => {
    for (const who of [undefined, "rita"]) {
      const crew = await said("/api/v1/repos/wren/lab/crew", who);
      expect(crew.status).toBe(200);
      expect(crew.text).toContain('"scout"');
      expect(crew.text).toContain('"role"');
      hidden(crew.text);
    }
  });

  test("a signed-in person who is not the owner sees no agent's configuration, forge-wide", async () => {
    for (const path of ["/api/v1/agents", "/api/v1/agents/scout"]) {
      const seen = await said(path, "rita");
      expect(seen.status).toBe(200);
      expect(seen.text).toContain("scout");
      hidden(seen.text);
    }
  });

  test("a writer and the forge's owner still see them", async () => {
    for (const who of ["wren", "olive"]) {
      const crew = await said("/api/v1/repos/wren/lab/crew", who);
      expect(crew.text).toContain("Q7BRIEFWORDS");
      expect(crew.text).toContain("q7model");
    }
    expect((await said("/api/v1/agents/scout", "olive")).text).toContain("Q7BRIEFWORDS");
  });

  test("the crew agent itself still reads its own brief", async () => {
    expect((await said("/api/v1/repos/wren/lab/crew", "scout")).text).toContain("Q7BRIEFWORDS");
    expect((await said("/api/v1/agents/scout", "scout")).text).toContain("Q7BRIEFWORDS");
  });
});
