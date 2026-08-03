import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import {
  accessAllows,
  addTeamMember,
  createOrg,
  createTeam,
  getOrg,
  listTeams,
  orgAccess,
  removeTeamMember,
  OWNERS_TEAM,
} from "../src/core/orgs.ts";
import { canRead, canWrite, canAdmin } from "../src/core/repos.ts";
import { createRepo, getRepo } from "../src/core/repos.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "O",
  GIT_AUTHOR_EMAIL: "o@f.dev",
  GIT_COMMITTER_NAME: "O",
  GIT_COMMITTER_EMAIL: "o@f.dev",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

describe("org & team core", () => {
  let dataDir: string;
  let app: App;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-org-core-"));
    app = createApp({ dataDir, port: 0 });
  });
  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("permission resolves to the highest team a member is on", async () => {
    const founder = await createUser(app.db, {
      username: "founder",
      email: "f@f.dev",
      password: "org-core-pass",
    });
    const dev = await createUser(app.db, {
      username: "dev",
      email: "d@f.dev",
      password: "org-core-pass",
    });
    const reader = await createUser(app.db, {
      username: "reader",
      email: "r@f.dev",
      password: "org-core-pass",
    });
    const outsider = await createUser(app.db, {
      username: "outsider",
      email: "o@f.dev",
      password: "org-core-pass",
    });
    for (const r of [founder, dev, reader, outsider])
      if (!r.ok) throw new Error("user");
    if (!founder.ok || !dev.ok || !reader.ok || !outsider.ok) return;

    const org = createOrg(app.db, "acme", founder.value.id);
    expect(org.ok).toBe(true);
    if (!org.ok) return;
    // Founder is on the Owners team → admin.
    expect(orgAccess(app.db, org.value.id, founder.value)).toBe("admin");
    expect(getOrg(app.db, "acme")?.kind).toBe("org");

    const writers = createTeam(app.db, org.value.id, "Writers", "write");
    const readers = createTeam(app.db, org.value.id, "Readers", "read");
    if (!writers.ok || !readers.ok) throw new Error("team");
    addTeamMember(app.db, writers.value, dev.value.id);
    addTeamMember(app.db, readers.value, reader.value.id);
    // Dev is on both read and write → the higher one wins.
    addTeamMember(app.db, readers.value, dev.value.id);

    expect(orgAccess(app.db, org.value.id, dev.value)).toBe("write");
    expect(orgAccess(app.db, org.value.id, reader.value)).toBe("read");
    expect(orgAccess(app.db, org.value.id, outsider.value)).toBe("none");
    expect(orgAccess(app.db, org.value.id, undefined)).toBe("none");
    expect(
      listTeams(app.db, org.value.id)
        .map((t) => t.name)
        .sort(),
    ).toEqual(["Owners", "Readers", "Writers"]);
  });

  test("an org repo grants access by team permission", async () => {
    const founder = getUserByName(app.db, "founder")!;
    const dev = getUserByName(app.db, "dev")!;
    const reader = getUserByName(app.db, "reader")!;
    const outsider = getUserByName(app.db, "outsider")!;
    const org = getOrg(app.db, "acme")!;

    const repo = await createRepo(app.db, app.reposRoot, {
      ownerId: org.id,
      name: "svc",
      visibility: "private",
    });
    expect(repo.ok).toBe(true);
    if (!repo.ok) return;

    // Read: founder(admin), dev(write), reader(read) yes; outsider no.
    expect(canRead(app.db, repo.value, founder)).toBe(true);
    expect(canRead(app.db, repo.value, dev)).toBe(true);
    expect(canRead(app.db, repo.value, reader)).toBe(true);
    expect(canRead(app.db, repo.value, outsider)).toBe(false);
    // Write: founder + dev yes; reader no.
    expect(canWrite(app.db, repo.value, dev)).toBe(true);
    expect(canWrite(app.db, repo.value, reader)).toBe(false);
    // Admin: only founder (Owners/admin team).
    expect(canAdmin(app.db, repo.value, founder)).toBe(true);
    expect(canAdmin(app.db, repo.value, dev)).toBe(false);
  });

  test("the Owners team can't be emptied", async () => {
    const org = getOrg(app.db, "acme")!;
    const owners = listTeams(app.db, org.id).find(
      (t) => t.name === OWNERS_TEAM,
    )!;
    const founder = getUserByName(app.db, "founder")!;
    // Only the founder is an owner; removing them must be refused.
    expect(removeTeamMember(app.db, owners, founder.id)).toBe(false);
    expect(accessAllows(orgAccess(app.db, org.id, founder), "admin")).toBe(
      true,
    );
  });
});

describe("orgs over HTTP", () => {
  let dataDir: string;
  let work: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let founderToken = "";
  let devToken = "";

  async function gitCode(args: string[], cwd: string): Promise<number> {
    const p = Bun.spawn(["git", ...args], {
      cwd,
      env: gitEnv,
      stdout: "ignore",
      stderr: "ignore",
    });
    return await p.exited;
  }
  async function mkUser(username: string): Promise<string> {
    await fetch(`${base}/api/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username,
        email: `${username}@f.dev`,
        password: "org-http-pass",
      }),
    });
    return fetch(`${base}/api/v1/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username,
        password: "org-http-pass",
        name: "c",
        scope: "admin",
      }),
    })
      .then((r) => r.json())
      .then((j) => (j as { token: string }).token);
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-org-http-"));
    work = await mkdtemp(join(tmpdir(), "forge-org-work-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    founderToken = await mkUser("boss");
    devToken = await mkUser("worker");
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  test("create an org and a repo under it via the API", async () => {
    const org = await fetch(`${base}/api/v1/orgs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${founderToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "globex" }),
    });
    expect(org.status).toBe(201);

    const repo = await fetch(`${base}/api/v1/repos`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${founderToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "widget",
        owner: "globex",
        visibility: "private",
      }),
    });
    expect(repo.status).toBe(201);
    expect(((await repo.json()) as { ownerName: string }).ownerName).toBe(
      "globex",
    );
  });

  test("a non-member cannot create a repo under the org", async () => {
    const repo = await fetch(`${base}/api/v1/repos`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${devToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "sneaky", owner: "globex" }),
    });
    expect(repo.status).toBe(403);
  });

  test("a write-team member can push to the org repo; a stranger cannot even clone", async () => {
    // Put worker on a write team of globex.
    const org = getOrg(app.db, "globex")!;
    const writers = createTeam(app.db, org.id, "Writers", "write");
    if (!writers.ok) throw new Error("team");
    addTeamMember(app.db, writers.value, getUserByName(app.db, "worker")!.id);

    // worker clones and pushes to globex/widget.
    const workerRemote = `${base.replace("http://", `http://worker:${devToken}@`)}/globex/widget.git`;
    expect(await gitCode(["clone", workerRemote, "widget"], work)).toBe(0);
    const dir = join(work, "widget");
    await Bun.write(join(dir, "f.txt"), "worker was here\n");
    await gitCode(["-C", dir, "add", "."], work);
    await gitCode(
      [
        "-C",
        dir,
        "-c",
        "user.email=w@f.dev",
        "-c",
        "user.name=w",
        "commit",
        "-m",
        "x",
      ],
      work,
    );
    expect(await gitCode(["-C", dir, "push", "origin", "main"], work)).toBe(0);

    // A stranger with no membership can't even clone the private org repo.
    const strangerToken = await mkUser("nobody");
    const strangerRemote = `${base.replace("http://", `http://nobody:${strangerToken}@`)}/globex/widget.git`;
    expect(await gitCode(["clone", strangerRemote, "nope"], work)).not.toBe(0);
  });

  test("the org profile page lists its repos and teams for members", async () => {
    // boss owns globex; the profile shows the repo and the Owners/Writers teams.
    const cookie = await fetch(`${base}/api/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "boss", password: "org-http-pass" }),
    }).then((r) => (r.headers.get("set-cookie") ?? "").split(";")[0]);
    const html = await (
      await fetch(`${base}/globex`, { headers: { cookie: cookie ?? "" } })
    ).text();
    expect(html).toContain("organization");
    expect(html).toContain("widget");
    expect(html).toContain("Owners");
    expect(html).toContain("Writers");
  });
});
