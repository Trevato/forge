/** Archiving is a person's call: an admin agent's PATCH is refused, and nothing changes. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { addTeamMember, createOrg, listTeams, OWNERS_TEAM } from "../src/core/orgs.ts";
import { createRepo, getRepoById, type Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let repo: Repo;
let botToken = "";
let founderToken = "";

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};
const patch = (token: string, archived: boolean) =>
  fetch(`${servers.url}/api/v1/repos/acme/svc`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ archived }),
  });

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-archive-agent-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const founder = ok(
    await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "founder",
      email: "founder@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    }),
  );
  const org = ok(createOrg(app.db, "acme", founder.id));
  repo = ok(
    await createRepo(app.db, app.reposRoot, { ownerId: org.id, name: "svc", visibility: "public" }),
  );
  const bot = ok(await createAgent(app, founder, { username: "bot" }));
  expect(addToCrew(app, founder, repo, "bot").ok).toBe(true);
  const owners = listTeams(app.db, org.id).find((t) => t.name === OWNERS_TEAM)!;
  addTeamMember(app.db, owners, bot.user.id);
  botToken = createToken(app.db, bot.user.id, "admin", "admin").token;
  founderToken = createToken(app.db, founder.id, "admin", "admin").token;
}, 30_000);

afterAll(async () => {
  servers?.stop();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("an admin agent cannot archive, a person can", async () => {
  const refused = await patch(botToken, true);
  expect(refused.status).toBeGreaterThanOrEqual(400);
  expect(getRepoById(app.db, repo.id)!.archivedAt).toBeNull();
  expect((await patch(founderToken, true)).status).toBe(200);
  expect(getRepoById(app.db, repo.id)!.archivedAt).not.toBeNull();
  expect((await patch(botToken, false)).status).toBeGreaterThanOrEqual(400);
  expect(getRepoById(app.db, repo.id)!.archivedAt).not.toBeNull();
});
