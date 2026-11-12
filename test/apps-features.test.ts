/**
 * Absorb, end to end with a real runtime: an app whose forge.json declares
 * a `feature` is absorbed by a site admin over the API, and its running
 * process is told `FORGE_FEATURE=1` and its `FORGE_SETTING_*`; a setting
 * changed redeploys it with the new value; un-absorbing tells it nothing
 * again. All of it with the crew off and no model credential anywhere:
 * absorbing is deterministic, and the crew only ever adds judgment on top.
 * `test/features.test.ts` holds the rules without processes.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { newApp } from "../src/actions/apps.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { featureVarsAt } from "../src/apps/feature_env.ts";
import type { AppRecord } from "../src/core/apps.ts";
import { getAbsorbed } from "../src/core/features.ts";
import { listRuns } from "../src/core/runs.ts";
import { crewHasCredential } from "../src/core/subscriptions.ts";
import { crewOffInPreview } from "../src/crew/preview.ts";
import type { Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import {
  APPS_DOMAIN,
  deploySettled,
  fetchAsHost,
  startAppsForge,
  stopAppsForge,
  type AppsForge,
} from "./helpers/apps-forge.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

// No model credential and the crew held off, for the whole file.
const MODEL_NAMES = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "FORGE_CLAUDE_CONFIG_DIR", "FORGE_APP_ENV", "FORGE_CREW_IN_PREVIEW"];
const saved = Object.fromEntries(MODEL_NAMES.map((n) => [n, process.env[n]]));

const feature = (name: string) => ({
  name,
  page: "/env",
  settings: {
    runHourUtc: {
      type: "int",
      default: 13,
      min: 0,
      max: 23,
      label: "Hour (UTC)",
    },
    scout: { type: "bool", default: true, label: "Search the web" },
  },
});
const forgeJson = (name: string) =>
  JSON.stringify({
    app: { run: "bun run feature.ts", health: "/healthz" },
    feature: feature(name),
  });

// The app shows what it was started with, and nothing more than FORGE_*.
const SERVER = `
const told = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("FORGE_")));
Bun.serve({
  port: Number(process.env.PORT),
  hostname: "127.0.0.1",
  fetch: (r) => new URL(r.url).pathname === "/healthz" ? new Response("ok") : Response.json(told),
});
`;

describe("absorbing a running app", () => {
  let forge: AppsForge;
  let repo: Repo;
  let record: AppRecord;
  let token: string;
  const host = `radar.${APPS_DOMAIN}`;

  const api = (method: string, path: string, body?: unknown) =>
    fetch(`${forge.servers.url}/api/v1/features/radar${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const told = async (): Promise<Record<string, string>> =>
    (await (await fetchAsHost(forge.servers, host, "/env")).json()) as Record<
      string,
      string
    >;
  /** Wait for the production deploy after `since` to finish well. */
  const deployed = async (since: number): Promise<void> => {
    const run = await deploySettled(
      forge.app,
      repo.id,
      (r) => r.env === "production" && Date.parse(r.createdAt) >= since,
    );
    if (run.state !== "ok")
      throw new Error(`deploy ${run.state}: ${run.summary}`);
  };

  beforeAll(async () => {
    for (const n of MODEL_NAMES) delete process.env[n];
    process.env["FORGE_APP_ENV"] = "preview";
    forge = await startAppsForge();
    const made = await newApp(forge.app, forge.alice, {
      name: "radar",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    ({ repo, app: record } = made.value);
    await deploySettled(forge.app, repo.id, (r) => r.env === "production");
    const since = Date.now() - 1;
    const committed = await commitToBranch(forge.app, forge.alice, repo, {
      message: "radar can be a feature",
      files: [
        { path: "forge.json", content: forgeJson("Radar") },
        { path: "feature.ts", content: SERVER },
      ],
    });
    if (!committed.ok) throw new Error(JSON.stringify(committed.error));
    await deployed(since);
    token = createToken(forge.app.db, forge.alice.id, "admin", "admin").token;
  }, 120_000);

  afterAll(async () => {
    await forge?.runtime.stop();
    if (forge) await stopAppsForge(forge);
    for (const [n, v] of Object.entries(saved))
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
  });

  test("the crew is off and no model credential exists", () => {
    expect(crewOffInPreview()).toBe(true);
    expect(crewHasCredential(forge.app.db)).toBe(false);
  });

  test("declared but not absorbed, the running app is told nothing", async () => {
    const env = await told();
    expect(env["FORGE_FEATURE"]).toBeUndefined();
    expect(
      Object.keys(env).filter((k) => k.startsWith("FORGE_SETTING_")),
    ).toEqual([]);
  });

  test("absorbed, it restarts holding FORGE_FEATURE and its defaults", async () => {
    const since = Date.now() - 1;
    const res = await api("PUT", "");
    expect(res.status).toBe(200);
    await deployed(since);
    expect(await told()).toMatchObject({
      FORGE_FEATURE: "1",
      FORGE_SETTING_RUN_HOUR_UTC: "13",
      FORGE_SETTING_SCOUT: "true",
    });
  }, 60_000);

  test("a setting changed redeploys it with the new value; a bad one changes nothing", async () => {
    expect(
      (await api("PATCH", "/settings", { settings: { runHourUtc: 24 } }))
        .status,
    ).toBe(422);
    const since = Date.now() - 1;
    expect(
      (
        await api("PATCH", "/settings", {
          settings: { runHourUtc: 9, scout: false },
        })
      ).status,
    ).toBe(200);
    await deployed(since);
    expect(await told()).toMatchObject({
      FORGE_SETTING_RUN_HOUR_UTC: "9",
      FORGE_SETTING_SCOUT: "false",
    });
  }, 60_000);

  test("a preview's forge.json does not rename the forge's menu entry", () => {
    featureVarsAt(forge.app.db, forge.app.config.dataDir, record.id, forgeJson("Not Radar"));
    expect(getAbsorbed(forge.app.db, record.id)?.name).toBe("Radar");
    featureVarsAt(forge.app.db, forge.app.config.dataDir, record.id, forgeJson("Radar 2"));
    // A production push does not rename it either: an admin accepts.
    expect(getAbsorbed(forge.app.db, record.id)?.name).toBe("Radar");
  });

  test("un-absorbed, it restarts told nothing again", async () => {
    const since = Date.now() - 1;
    expect((await api("DELETE", "")).status).toBe(200);
    await deployed(since);
    expect((await told())["FORGE_FEATURE"]).toBeUndefined();
  }, 60_000);

  test("nothing above started an agent run", () => {
    expect(listRuns(forge.app.db, repo.id, { kind: "agent", limit: 50 })).toEqual([]);
  });
});
