/**
 * `GET /api/v1/fleet/rows`: the rows `/fleet` shows for one query line, per
 * kind; a private repository hidden from a stranger; refusals in 422.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createIssue } from "../src/core/issues.ts";
import { createRun } from "../src/core/runs.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

describe("GET /api/v1/fleet/rows", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let cookie: string;

  const get = (path: string, withCookie?: string) =>
    fetch(`${servers.url}${path}`, withCookie ? { headers: { cookie: withCookie } } : {});
  const api = (q: string, extra = "") =>
    get(`/api/v1/fleet/rows?${new URLSearchParams({ q })}${extra}`, cookie);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-fleet-rows-api-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    promote(app.db, made.value);
    const alice: User = made.value;
    for (const [name, visibility] of [["engine", "private"], ["tools", "public"]] as const) {
      const repo = await createRepo(app, alice, { name, visibility });
      if (!repo.ok) throw new Error(String(repo.error));
      createRun(app.db, { repoId: repo.value.id, kind: "agent" });
      const i = createIssue(app.db, { repoId: repo.value.id, authorId: alice.id, title: `issue in ${name}` });
      if (!i.ok) throw new Error(i.error);
    }
    cookie = `forge_session=${createSession(app.db, alice.id).token}`;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  for (const kind of ["repo", "run", "issue"] as const) {
    test(`${kind}: the API and /fleet select the same rows`, async () => {
      const line = `${kind} owner:alice`;
      const res = await api(line);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { kind: string; columns: { key: string }[]; items: Record<string, string>[] };
      expect(body.kind).toBe(kind);
      expect(body.columns.length).toBeGreaterThan(0);
      expect(body.items.length).toBe(2);
      const page = await (await get(`/fleet?${new URLSearchParams({ q: line })}`, cookie)).text();
      expect(page).toContain(`data-count="${body.items.length}"`);
      for (const item of body.items) expect(page).toContain(`href="/${item.repo}"`);
    });
  }

  test("a private repository's rows are hidden from a stranger", async () => {
    for (const kind of ["repo", "run", "issue"]) {
      const res = await get(`/api/v1/fleet/rows?${new URLSearchParams({ q: `${kind} owner:alice` })}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: { repo: string }[] };
      expect(body.items.map((r) => r.repo)).toEqual(["alice/tools"]);
    }
  });

  test("sort orders the items", async () => {
    const names = async (sort: string) =>
      ((await (await api("repo owner:alice", `&sort=${sort}`)).json()) as { items: { repo: string }[] }).items.map((r) => r.repo);
    expect(await names("repo")).toEqual(["alice/engine", "alice/tools"]);
    expect(await names("-repo")).toEqual(["alice/tools", "alice/engine"]);
    expect((await api("repo", "&sort=nope")).status).toBe(422);
  });

  test("a line that does not parse, an empty one and an overlong one are 422", async () => {
    const bad = await api("repo spent:4");
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { message: string }).message).toContain('repo has no field "spent"');
    expect((await api("")).status).toBe(422);
    expect((await api(`repo name:${"a".repeat(500)}`)).status).toBe(422);
  });
});
