/** The radar's night (#9592): a fake registry, a new release files one issue, a second run files none. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { addCrew, createAgentRow } from "../src/core/agents.ts";
import { createUser } from "../src/core/users.ts";
import { fileUpdates, updateBody } from "../src/flows/file.ts";
import { readRadar, refreshRadar, type Lookup } from "../src/flows/radar.ts";
import { readPins } from "../src/flows/pins.ts";
import { radarNight } from "../src/nightly/radar.ts";
import { startNightly } from "../src/nightly/service.ts";
import { nightlyLines } from "../src/nightly/says.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let app: App;
let dir: string;
let repo: Repo;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "radar-night-"));
  app = createApp({ dataDir: dir, port: 0 });
  const owner = await seedAdmin(app, { username: "alice", email: "alice@forge.test", password: "a-long-passphrase" });
  if (!owner.ok) throw new Error("no owner");
  const made = await createRepo(app, owner.value, { name: "site", visibility: "public" });
  if (!made.ok) throw new Error("no repo");
  repo = made.value;
  const files = [{ path: "package.json", content: JSON.stringify({ dependencies: { left: "1.2.3", mid: "^2.0.0" } }) }];
  const seeded = await commitToBranch(app, owner.value, repo, { message: "seed", files });
  if (!seeded.ok) throw new Error("no seed");
});
afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const PINS = readPins(JSON.stringify({ dependencies: { left: "1.2.3", mid: "^2.0.0", same: "3.0.0", rc: "1.0.0" }, devDependencies: { dev: "0.1.0" } }));
const registry = (latest: Record<string, string>): Lookup => async (name) => (latest[name] ? { latest: latest[name]! } : "unknown");
const issuesOf = () =>
  app.db.query<{ title: string; body: string }, [string]>("SELECT title, body FROM issue WHERE repo_id = ? AND title LIKE 'Update %' ORDER BY title").all(repo.id);

async function night(latest: Record<string, string>): Promise<number[]> {
  await refreshRadar(app.db, repo.id, PINS, registry(latest));
  return fileUpdates(app, repo, readRadar(app.db, repo.id, PINS));
}

describe("the radar files updates", () => {
  test("a new release files one issue per dependency, a second run none", async () => {
    const latest = { left: "1.2.4", mid: "3.0.0", same: "3.0.0", rc: "2.0.0-rc.1", dev: "0.2.0" };
    const first = await night(latest);
    expect(first).toHaveLength(3);
    expect(issuesOf().map((i) => i.title)).toEqual(["Update dev to 0.2.0", "Update left to 1.2.4", "Update mid to 3.0.0"]);
    expect(await night(latest)).toEqual([]);
    expect(issuesOf()).toHaveLength(3);
  });

  test("the body says what changed, why it helps and what could break", () => {
    const body = issuesOf().find((i) => i.title.startsWith("Update mid"))!.body;
    expect(body).toContain("**What changed.**");
    expect(body).toContain("major release");
    expect(body).toContain("**Why it is useful.**");
    expect(body).toContain("**What could break.** High");
  });

  test("a newer release while one is open files nothing; once closed, the newer release files again", async () => {
    expect(await night({ left: "1.3.0" })).toEqual([]);
    app.db.query("UPDATE issue SET state = 'closed' WHERE repo_id = ? AND title = 'Update left to 1.2.4'").run(repo.id);
    expect(await night({ left: "1.2.4" })).toEqual([]); // already filed once, however it closed
    expect(await night({ left: "1.3.0" })).toHaveLength(1);
  });

  test("autonomy decides who the issue is for", () => {
    const line = readRadar(app.db, repo.id, PINS).find((l) => l.name === "left")!;
    const w = line as typeof line & { gap: "minor" };
    expect(updateBody(w, true)).toContain("the crew takes it");
    expect(updateBody(w, false)).toContain("waits for a person");
  });

  test("an unreachable registry files nothing", async () => {
    const before = issuesOf().length;
    expect(await night({})).toEqual([]);
    expect(issuesOf()).toHaveLength(before);
  });
});

async function seedAgent(a: App, r: Repo, username: string): Promise<string> {
  const u = await createUser(a.db, { origin: "seed", username, email: `${username}@a.invalid`, agent: true });
  if (!u.ok) throw new Error("agent");
  createAgentRow(a.db, { userId: u.value.id, roles: ["builder"], createdBy: r.ownerId });
  addCrew(a.db, r.id, u.value.id, r.ownerId, "builder");
  return u.value.id;
}

describe("the radar routes what it files", () => {
  const assignee = (title: string) =>
    app.db
      .query<{ assignee_id: string | null }, [string, string]>("SELECT assignee_id FROM issue WHERE repo_id = ? AND title = ?")
      .get(repo.id, title)?.assignee_id ?? null;

  test("a non-autonomous repository's issue is assigned to its owner, a person", async () => {
    app.db.query("DELETE FROM issue WHERE repo_id = ?").run(repo.id);
    await night({ left: "1.2.4" });
    expect(assignee("Update left to 1.2.4")).toBe(repo.ownerId);
  });

  test("an autonomous repository's issue is assigned to a builder on the crew", async () => {
    const builder = await seedAgent(app, repo, "radar-builder");
    app.db.query("UPDATE repo SET autonomy = 'autonomous' WHERE id = ?").run(repo.id);
    app.db.query("DELETE FROM issue WHERE repo_id = ?").run(repo.id);
    const fresh = getRepoById(app.db, repo.id)!;
    await refreshRadar(app.db, repo.id, PINS, registry({ left: "1.2.4" }));
    fileUpdates(app, fresh, readRadar(app.db, repo.id, PINS));
    expect(assignee("Update left to 1.2.4")).toBe(builder);
    app.db.query("UPDATE repo SET autonomy = 'assisted' WHERE id = ?").run(repo.id);
  });
});

describe("the nightly service", () => {
  test("radarNight reads every repository with pins and says what it filed", async () => {
    app.db.query("DELETE FROM issue WHERE repo_id = ?").run(repo.id);
    const said = await radarNight(app, registry({ left: "1.2.3", mid: "2.1.0" }));
    expect(said).toMatch(/^read 1 repository; filed alice\/site#\d+\.$/);
    expect(await radarNight(app, registry({ left: "1.2.3", mid: "2.1.0" }))).toBe("read 1 repository; filed nothing.");
  });

  test("the radar keeps a slot and a record like the other nights", async () => {
    const handle = startNightly(app, { forgeUrl: "http://x", token: "t", radar: async () => "read 1 repository; filed nothing.", doing: { run: async () => ({ error: "off" }), propose: async () => undefined } })!;
    await handle.radar();
    await handle.stop();
    expect(nightlyLines(dir).some((l) => l.startsWith("radar:") && l.includes("filed nothing"))).toBe(true);
  });
});
