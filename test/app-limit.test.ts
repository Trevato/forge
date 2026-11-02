/**
 * The app limit (`actions/app_limit.ts`) called directly: an account at the
 * `apps` quota is refused, a forge admin never is, and no quota asks nothing.
 */
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appLimitWords, requireAppRoom } from "../src/actions/app_limit.ts";
import { createApp as createServer } from "../src/app.ts";
import { createApp } from "../src/core/apps.ts";
import { createRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { setQuota } from "../src/settings/quotas.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();
setDefaultTimeout(30_000);

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

/** A plain account and an admin, with `owned` apps under the plain one. */
async function world(owned: number) {
  const dir = await mkdtemp(join(tmpdir(), "forge-app-limit-"));
  dirs.push(dir);
  const app = createServer({ dataDir: dir, port: 0 });
  const mk = async (username: string, isAdmin: boolean) => {
    const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@x.test`, isAdmin });
    if (!made.ok) throw new Error("user");
    return made.value;
  };
  const admin = await mk("boss", true);
  const user = await mk("maker", false);
  for (let i = 0; i < owned; i++) {
    const repo = await createRepo(app.db, app.reposRoot, { ownerId: user.id, name: `r${i}` });
    if (!repo.ok) throw new Error(repo.error);
    const made = createApp(app.db, { repoId: repo.value.id, slug: `s${i}`, access: "public" });
    if (!made.ok) throw new Error(made.error);
  }
  return { app, admin, user };
}

test("at the limit a non-admin is refused; under it, ok", async () => {
  const { app, admin, user } = await world(2);
  setQuota(app.db, "apps", 2, admin.id);
  const full = requireAppRoom(app, user, user.id);
  expect(full.ok).toBe(false);
  if (!full.ok) expect(full.error).toBe("app_limit");
  setQuota(app.db, "apps", 3, admin.id);
  expect(requireAppRoom(app, user, user.id).ok).toBe(true);
});

test("a forge admin at or over the limit is never refused", async () => {
  const { app, admin, user } = await world(2);
  setQuota(app.db, "apps", 1, admin.id);
  expect(requireAppRoom(app, user, user.id).ok).toBe(false);
  expect(requireAppRoom(app, admin, user.id).ok).toBe(true);
  setQuota(app.db, "apps", 2, admin.id);
  expect(requireAppRoom(app, admin, user.id).ok).toBe(true);
});

test("with no quota set any count is ok", async () => {
  const { app, user } = await world(3);
  expect(requireAppRoom(app, user, user.id).ok).toBe(true);
});

test("the words name the count and never exceed the limit", async () => {
  const { app, admin, user } = await world(2);
  setQuota(app.db, "apps", 2, admin.id);
  expect(appLimitWords(app, user.id)).toContain("2 of 2 apps");
  setQuota(app.db, "apps", 1, admin.id);
  expect(appLimitWords(app, user.id)).toContain("1 of 1 apps");
  expect(appLimitWords(app, user.id)).not.toContain("2 of");
});
