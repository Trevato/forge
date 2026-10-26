/** The flow panel's "Hot files" (#6420): most-touched first, capped at 10, "builds held" at HOT_PULLS, private files for the owner only. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createUser } from "../src/core/users.ts";
import { rememberPullFiles } from "../src/crew/hot_files.ts";
import { flowPanel } from "../src/web/pages/flow-panel.ts";

describe("flow panel hot files", () => {
  let dataDir: string;
  let app: App;
  let repoId: string;

  const draw = (kind: "owner" | "agent") =>
    String(flowPanel(app, { kind }, new URL("http://x/boards"), "/boards"));
  const section = (page: string) => page.slice(page.indexOf('id="hot-files"'), page.indexOf('id="hot-files"') + 6000);

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-hot-files-"));
    app = createApp({ dataDir, port: 0 });
    const u = await createUser(app.db, {
      origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
      password: "a-good-passphrase", adminIfFirst: true,
    });
    if (!u.ok) throw new Error(u.error);
    const made = await createRepo(app, u.value, { name: "shop" });
    if (!made.ok) throw new Error(String(made.error));
    repoId = made.value.id;
  });
  afterEach(async () => {
    rememberPullFiles(repoId, []);
    app.db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("with nothing learned it says so", () => {
    expect(draw("owner")).toContain("No file is touched by 3 or more open pulls");
  });

  test("twelve files: most-touched first, ten shown, held ones marked", () => {
    // Pull i touches file f when i < counts[f], so file f has counts[f] pulls.
    const counts = [7, 6, 5, 5, 4, 4, 3, 3, 3, 3, 3, 3];
    const pulls = Array.from({ length: 7 }, (_, i) => ({
      number: i + 1,
      files: counts.flatMap((c, f) => (i < c ? [`src/f${String(f).padStart(2, "0")}.ts`] : [])),
    }));
    rememberPullFiles(repoId, pulls);
    const page = section(draw("owner"));
    const listed = [...page.matchAll(/data-hot-file="([^"]+)"/g)].map((m) => m[1]);
    expect(listed).toHaveLength(10);
    expect(listed.slice(0, 4)).toEqual(["src/f00.ts", "src/f01.ts", "src/f02.ts", "src/f03.ts"]);
    expect(listed).not.toContain("src/f10.ts");
    expect(page.match(/builds held/g)).toHaveLength(4);
    expect(page).not.toContain("No file is touched");
  });

  test("a file below three pulls is not listed", () => {
    rememberPullFiles(repoId, [1, 2].map((number) => ({ number, files: ["a/b.ts"] })));
    expect(draw("owner")).toContain("No file is touched by 3 or more open pulls");
  });

  test("a private repository's files are for the owner only", () => {
    rememberPullFiles(repoId, [1, 2, 3].map((number) => ({ number, files: ["secret/plan.ts"] })));
    app.db.query("UPDATE repo SET visibility = 'private' WHERE id = ?1").run(repoId);
    expect(draw("owner")).toContain("secret/plan.ts");
    expect(draw("agent")).not.toContain("secret/plan.ts");
    app.db.query("UPDATE repo SET visibility = 'public' WHERE id = ?1").run(repoId);
    expect(draw("agent")).toContain("secret/plan.ts");
  });
});
