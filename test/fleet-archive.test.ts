/**
 * The `archive` fleet verb: many repositories archived in one operation,
 * previewed by default, and woken again by the operation's own undo, inside
 * the day the undo is kept.
 */
import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import {
  UNDO_WINDOW_MS,
  applyFleetOp,
  previewFleetOp,
  undoFleetOp,
} from "../src/actions/fleet.ts";
import { createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

describe("fleet archive", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let token: string;
  let alice: User;
  let bob: User;
  let repos: Repo[];
  let bobs: Repo;

  const person = async (username: string) => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      allowReserved: true,
      adminIfFirst: username === "root",
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
    });
    if (!made.ok) throw new Error(made.error);
    promote(app.db, made.value);
    return made.value;
  };
  const repoOf = async (owner: User, name: string) => {
    const made = await createRepo(app, owner, { name, visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    return made.value;
  };
  const archived = (repo: Repo) => getRepoById(app.db, repo.id)!.archivedAt !== null;
  const wake = async (repo: Repo) => {
    if (archived(repo)) await updateRepoSettings(app, alice, repo, { archived: false });
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-fleet-archive-"));
    app = await createApp({ dataDir });
    await person("root");
    alice = await person("alice");
    bob = await person("bob");
    repos = [];
    for (const name of ["one", "two", "three", "four"]) repos.push(await repoOf(alice, name));
    bobs = await repoOf(bob, "garden");
    servers = await serve(app);
    token = createToken(app.db, alice.id, "admin", "admin").token;
  }, 30_000);

  afterEach(async () => {
    setSystemTime();
    for (const repo of repos) await wake(repo);
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const Q = "repo owner:alice";
  const action = { verb: "archive", value: true };

  test("a preview changes nothing", () => {
    const plan = previewFleetOp(app, alice, Q, action);
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.value.counts.change).toBe(4);
    expect(repos.some(archived)).toBe(false);
  });

  test("archive three, undo, all three awake", async () => {
    const ids = repos.slice(0, 3).map((r) => r.id);
    const applied = await applyFleetOp(app, alice, "repo owner:alice", action);
    if (!applied.ok) throw new Error(applied.error.message);
    const mine = applied.value.rows.filter((r) => ids.includes(r.repoId));
    expect(mine.every((r) => r.outcome === "ok")).toBe(true);
    expect(repos.every(archived)).toBe(true);
    const undone = await undoFleetOp(app, alice, applied.value.id);
    expect(undone.ok).toBe(true);
    expect(repos.some(archived)).toBe(false);
  });

  test("one already archived is unchanged and stays archived after undo", async () => {
    await updateRepoSettings(app, alice, repos[0]!, { archived: true });
    const applied = await applyFleetOp(app, alice, "repo owner:alice", action);
    if (!applied.ok) throw new Error(applied.error.message);
    const first = applied.value.rows.find((r) => r.repoId === repos[0]!.id)!;
    expect(first.outcome).toBe("unchanged");
    const undone = await undoFleetOp(app, alice, applied.value.id);
    expect(undone.ok).toBe(true);
    expect(archived(repos[0]!)).toBe(true);
    expect(repos.slice(1).some(archived)).toBe(false);
  });

  test("a row the actor does not administer is refused and stays awake", async () => {
    const applied = await applyFleetOp(app, alice, "repo", action);
    if (!applied.ok) throw new Error(applied.error.message);
    const row = applied.value.rows.find((r) => r.repoId === bobs.id);
    expect(row?.outcome).toBe("refused");
    expect(archived(bobs)).toBe(false);
    for (const repo of repos) await wake(repo);
    const own = await applyFleetOp(app, bob, "repo owner:alice", action);
    if (!own.ok) throw new Error(own.error.message);
    expect(own.value.rows.every((r) => r.outcome === "refused")).toBe(true);
    expect(repos.some(archived)).toBe(false);
  });

  test("a value that is not a boolean is refused", () => {
    for (const value of ["yes", 1, null]) {
      const plan = previewFleetOp(app, alice, Q, { verb: "archive", value });
      expect(plan.ok).toBe(false);
    }
  });

  test("an undo after 24 hours is refused", async () => {
    const applied = await applyFleetOp(app, alice, Q, action);
    if (!applied.ok) throw new Error(applied.error.message);
    setSystemTime(new Date(Date.now() + UNDO_WINDOW_MS + 60_000));
    const undone = await undoFleetOp(app, alice, applied.value.id);
    expect(undone.ok).toBe(false);
    if (!undone.ok) expect(undone.error.code).toBe("expired");
    expect(repos.every(archived)).toBe(true);
  });

  const api = (path: string, body: unknown) =>
    fetch(`${servers.url}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("the API door archives, and its undo is refused after 24 hours", async () => {
    const dry = await api("/api/v1/fleet/ops", { query: Q, action });
    expect(dry.status).toBe(200);
    expect(repos.some(archived)).toBe(false);
    const done = await api("/api/v1/fleet/ops", { query: Q, action, dryRun: false });
    expect(done.status).toBe(201);
    const op = (await done.json()) as { id: string };
    expect(repos.every(archived)).toBe(true);
    setSystemTime(new Date(Date.now() + UNDO_WINDOW_MS + 60_000));
    const late = await api(`/api/v1/fleet/ops/${op.id}/undo`, {});
    expect(late.status).toBe(409);
    expect(JSON.stringify(await late.json())).toContain("expired");
    expect(repos.every(archived)).toBe(true);
  });

  test("the MCP door undoes an archive inside the day and not after it", async () => {
    const mcp = async (operation: string) => {
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
          params: {
            name: "limb",
            arguments: { app: "alice/one", action: "undo", operation, dryRun: false },
          },
        }),
      });
      const body = (await res.json()) as any;
      return { error: body.result.isError === true, text: body.result.content[0].text as string };
    };
    const first = await applyFleetOp(app, alice, Q, action);
    if (!first.ok) throw new Error(first.error.message);
    expect((await mcp(first.value.id)).error).toBe(false);
    expect(repos.some(archived)).toBe(false);
    const second = await applyFleetOp(app, alice, Q, action);
    if (!second.ok) throw new Error(second.error.message);
    setSystemTime(new Date(Date.now() + UNDO_WINDOW_MS + 60_000));
    const late = await mcp(second.value.id);
    expect(late.error).toBe(true);
    expect(late.text).toContain("expired");
    expect(repos.every(archived)).toBe(true);
  });
});
