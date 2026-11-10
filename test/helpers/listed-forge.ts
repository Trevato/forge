/** A forge with alice's `notes`: two commits on main, a branch `feature/x`, and the crew running it,
 * served so a test reads the pages as a browser gets them. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../../src/actions/repos.ts";
import { createBranch } from "../../src/actions/branches.ts";
import { createApp, type App } from "../../src/app.ts";
import { createSession } from "../../src/core/sessions.ts";
import { forgeHttp, type ForgeHttp } from "../../src/http/server.ts";
import { seedAdmin } from "./admin.ts";

export interface ListedForge {
  app: App;
  /** The body of a GET as alice. */
  get(path: string): Promise<string>;
  close(): Promise<void>;
}

export async function listedForge(): Promise<ListedForge> {
  const dataDir = await mkdtemp(join(tmpdir(), "forge-keys-listed-"));
  const app = createApp({ dataDir, port: 0 });
  const http: ForgeHttp = forgeHttp(app);
  const admin = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!admin.ok) throw new Error(admin.error);
  const made = await createRepo(app, admin.value, { name: "notes", visibility: "public", description: "" });
  if (!made.ok) throw new Error(String(made.error));
  for (const n of [1, 2]) {
    const done = await commitToBranch(app, admin.value, made.value, { message: `Change ${n}`, files: [{ path: `f${n}.txt`, content: String(n) }] });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
  }
  const branch = await createBranch(app, admin.value, made.value, { name: "feature/x" });
  if (!branch.ok) throw new Error(String(branch.error));
  app.db.run("UPDATE repo SET autonomy = 'autonomous' WHERE id = ?1", [made.value.id]);
  const cookie = `forge_session=${createSession(app.db, admin.value.id).token}`;
  return {
    app,
    get: async (path) => (await http.handle(new Request(`http://forge.test${path}`, { headers: { cookie } }))).text(),
    close: async () => {
      app.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
