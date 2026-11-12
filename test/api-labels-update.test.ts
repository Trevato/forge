/** `PATCH /api/v1/repos/:owner/:name/labels/:id` renames or recolours a label, keeping its id. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { LABEL_WORDS } from "../src/actions/label_words.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { createIssue, labelsFor, setIssueLabels } from "../src/core/issues.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("PATCH …/labels/:id", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let admin: string;
  let rw: string;
  let bob: string;
  let issueId: string;
  const base = () => `${servers.url}/api/v1/repos/alice/game/labels`;
  const patch = (token: string, id: string, payload: unknown) =>
    fetch(`${base()}/${id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  const create = async (name: string, color = "d73a4a") => {
    const res = await fetch(base(), {
      method: "POST",
      headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
      body: JSON.stringify({ name, color }),
    });
    return (await res.json()) as { id: string; name: string; color: string };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-api-labels-update-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string, first = false) => {
      const u = await createUser(app.db, {
        origin: "seed", trusted: true, username,
        email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first,
      });
      if (!u.ok) throw new Error(u.error);
      return u.value;
    };
    const alice = await mk("alice", true);
    const b = await mk("bob");
    admin = createToken(app.db, alice.id, "a", "admin").token;
    rw = createToken(app.db, alice.id, "rw", "rw").token;
    bob = createToken(app.db, b.id, "b", "admin").token;
    const made = await createRepo(app, alice, { name: "game", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const issue = createIssue(app.db, { repoId: made.value.id, authorId: alice.id, title: "t" });
    if (!issue.ok) throw new Error(issue.error);
    issueId = issue.value.id;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("renames, recolours, and an issue still carries the label", async () => {
    const label = await create("bgu");
    setIssueLabels(app.db, issueId, [label.id]);
    const renamed = await patch(admin, label.id, { name: "bug" });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toEqual({ id: label.id, name: "bug", color: "d73a4a" });
    const recoloured = await patch(admin, label.id, { color: "0E8A16" });
    expect(recoloured.status).toBe(200);
    expect(await recoloured.json()).toEqual({ id: label.id, name: "bug", color: "0e8a16" });
    expect(labelsFor(app.db, issueId)).toEqual([{ id: label.id, name: "bug", color: "0e8a16" }]);
  });

  test("only an admin token may", async () => {
    const [label] = ((await (await fetch(base())).json()) as any).items;
    expect((await patch(rw, label.id, { name: "x" })).status).toBe(403);
    expect((await patch(bob, label.id, { name: "x" })).status).toBe(404);
    expect((await fetch(base() + "/" + label.id, { method: "PATCH", body: "{}" })).status).toBe(401);
    expect((await (await fetch(base())).json() as any).items[0].name).toBe("bug");
  });

  test("an unknown id is 404", async () => {
    expect((await patch(admin, "nope", { name: "x" })).status).toBe(404);
  });

  test("nothing to change, a taken name and a bad colour are 422", async () => {
    const other = await create("ui", "6b7280");
    const none = await patch(admin, other.id, {});
    expect(none.status).toBe(422);
    const taken = await patch(admin, other.id, { name: "BUG" });
    expect(taken.status).toBe(422);
    expect(await taken.json()).toMatchObject({ error: "taken", message: LABEL_WORDS.taken });
    const bad = await patch(admin, other.id, { color: "red" });
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ error: "invalid", message: LABEL_WORDS.shape });
    expect((await patch(admin, other.id, { name: 5 })).status).toBe(422);
  });
});
