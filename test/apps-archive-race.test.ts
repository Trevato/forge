/**
 * Archive and Wake are each one transition, whatever runs beside them: two
 * Archives from the same stale view move the repository once, and a Wake
 * that lands while an Archive is still stopping the app leaves production
 * running, not an awake repository with its app down (review M2).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { updateRepoSettings } from "../src/actions/repos.ts";
import type { AppRecord } from "../src/core/apps.ts";
import { listEvents } from "../src/core/events.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { getRun } from "../src/core/runs.ts";
import { repoDir } from "../src/git/repos.ts";
import { resolveOid } from "../src/git/merge.ts";
import { startAppsForge, startHello, stopAppsForge, type AppsForge } from "./helpers/apps-forge.ts";

describe("archive and wake race", () => {
  let forge: AppsForge;
  let repo: Repo;
  let record: AppRecord;

  const fresh = (): Repo => {
    const now = getRepoById(forge.app.db, repo.id);
    if (now === undefined) throw new Error("repository gone");
    return now;
  };
  const archivedMoves = (): number =>
    listEvents(forge.app.db, { limit: 1000 }).filter((e) => {
      const changed = e.payload["changed"];
      return e.kind === "repo.settings_updated" && typeof changed === "object" && changed !== null && "archived" in changed;
    }).length;
  const production = () => forge.runtime.envStatus(record, "production")?.state;

  beforeAll(async () => {
    forge = await startAppsForge();
    ({ repo, record } = await startHello(forge));
  }, 90_000);

  afterAll(async () => {
    await forge.runtime.stop();
    await stopAppsForge(forge);
  });

  test("a Wake during an Archive's stop leaves production running", async () => {
    // A deploy in flight makes the Archive's stop wait for it: the Wake
    // lands in that window.
    const dir = repoDir(forge.app.reposRoot, repo.ownerName, repo.name);
    const tip = await resolveOid(dir, `refs/heads/${repo.defaultBranch}`);
    if (tip === undefined) throw new Error("no tip");
    const redeploy = forge.runtime.requestDeploy(record, fresh(), "production", tip, "redeploy");
    if (redeploy === undefined) throw new Error("no redeploy");
    for (let i = 0; i < 600 && getRun(forge.app.db, redeploy.id)?.state !== "running"; i++) await Bun.sleep(10);
    expect(getRun(forge.app.db, redeploy.id)?.state).toBe("running");
    const archiving = updateRepoSettings(forge.app, forge.alice, fresh(), { archived: true });
    const waking = updateRepoSettings(forge.app, forge.alice, fresh(), { archived: false });
    const [archived, woke] = await Promise.all([archiving, waking]);
    expect(archived.ok && woke.ok).toBe(true);
    expect(fresh().archivedAt).toBeNull();
    for (let i = 0; i < 300 && production() !== "running"; i++) await Bun.sleep(100);
    expect(production()).toBe("running");
  }, 90_000);

  test("two Archives from one stale view archive once", async () => {
    const stale = fresh();
    const before = archivedMoves();
    const [one, two] = await Promise.all([
      updateRepoSettings(forge.app, forge.alice, stale, { archived: true }),
      updateRepoSettings(forge.app, forge.alice, stale, { archived: true }),
    ]);
    expect(one.ok && two.ok).toBe(true);
    expect(fresh().archivedAt).not.toBeNull();
    expect(archivedMoves() - before).toBe(1);
    const woke = await updateRepoSettings(forge.app, forge.alice, fresh(), { archived: false });
    expect(woke.ok).toBe(true);
    for (let i = 0; i < 600 && production() !== "running"; i++) await Bun.sleep(100);
    expect(production()).toBe("running");
  }, 90_000);
});
