/**
 * Apps: a production deploy of a release commit says which release in its
 * `app.serving` event (#6098); a preview of the same subject says nothing.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { listEvents } from "../src/core/events.ts";
import {
  deploySettled,
  startAppsForge,
  startHello,
  stopAppsForge,
  type AppsForge,
} from "./helpers/apps-forge.ts";

describe("apps: app.serving carries the release", () => {
  let forge: AppsForge;
  beforeAll(async () => {
    forge = await startAppsForge();
  }, 60_000);
  afterAll(async () => {
    await forge.runtime.stop();
    await stopAppsForge(forge);
  });

  test("production carries version and pulls; a preview of the same subject carries neither", async () => {
    const { app, alice } = forge;
    const { repo } = await startHello(forge);
    const message = "Release 0.9.0: First thing (#7);Second thing (#8)";
    const file = (content: string) => [{ path: "notes.txt", content }];

    const prod = await commitToBranch(app, alice, repo, { message, files: file("a\n") });
    if (!prod.ok) throw new Error(JSON.stringify(prod.error));
    const prodRun = await deploySettled(
      app,
      repo.id,
      (r) => r.env === "production" && r.commitOid === prod.value.commitOid,
    );
    expect(prodRun.state).toBe("ok");

    const preview = await commitToBranch(app, alice, repo, {
      branch: "rel",
      base: repo.defaultBranch,
      message,
      files: file("b\n"),
    });
    if (!preview.ok) throw new Error(JSON.stringify(preview.error));
    const opened = await openPull(app, alice, repo, {
      title: "Rel",
      baseBranch: repo.defaultBranch,
      headBranch: "rel",
    });
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    const env = `pull-${opened.value.number}`;
    await deploySettled(app, repo.id, (r) => r.env === env && r.commitOid === preview.value.commitOid);

    const events = listEvents(app.db, { repoId: repo.id, limit: 200 }).filter(
      (e) => e.kind === "app.serving",
    );
    const live = events.find((e) => e.payload["commitOid"] === prod.value.commitOid);
    expect(live?.payload["env"]).toBe("production");
    expect(live?.payload["version"]).toBe("0.9.0");
    expect(live?.payload["pulls"]).toEqual([
      { title: "First thing", number: 7 },
      { title: "Second thing", number: 8 },
    ]);
    const side = events.find((e) => e.payload["commitOid"] === preview.value.commitOid);
    expect(side?.payload["env"]).toBe(env);
    expect("version" in side!.payload).toBe(false);
    expect("pulls" in side!.payload).toBe(false);
  }, 120_000);
});
