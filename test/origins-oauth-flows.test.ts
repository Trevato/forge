import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import {
  FLOW_TTL_MS,
  claimFlowByState,
  createFlow,
  finishFlow,
  flowSecrets,
  getFlowFor,
  pruneFlows,
  targetForShortCode,
  type AppRegistration,
} from "../src/origins/oauth.ts";

/**
 * The connect flows' bookkeeping: a state claims once, a short code reveals
 * nothing about why it failed, only the starter sees a flow, and pruning
 * takes the secrets with the rows. `now` is always passed in.
 */

const REGISTRATION: AppRegistration = {
  kind: "forgejo",
  apiUrl: "https://git.example/api/v1",
  webUrl: "https://git.example",
  clientId: "client-id",
  clientSecret: "client-secret-value",
};
const TARGET = "https://git.example/login/oauth/authorize?state=raw-state-1";

let dataDir: string;
let app: App;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-oauth-flows-"));
  app = createApp({ dataDir, port: 0 });
  // The flows are keyed by user id only; they need no real account.
  app.db.run("PRAGMA foreign_keys = OFF");
});
afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const start = (userId: string, state: string) =>
  createFlow(app.db, dataDir, {
    userId,
    flow: "code",
    app: REGISTRATION,
    state,
    verifier: "verifier-value",
    redirectUri: "https://forge.example/settings/origins/callback",
    target: TARGET,
  });

const rowText = (flowId: string): string =>
  JSON.stringify(
    app.db.query("SELECT * FROM oauth_flow WHERE id = ?1").get(flowId),
  );

const expireAt = (flowId: string, iso: string): void => {
  app.db.query("UPDATE oauth_flow SET expires_at = ?1 WHERE id = ?2").run(iso, flowId);
};

describe("claiming a flow by its state", () => {
  test("claims once; a replay and an unknown state answer nothing", () => {
    const flow = start("u-claim", "raw-state-1");
    const claimed = claimFlowByState(app.db, "raw-state-1", "u-claim");
    expect(claimed?.id).toBe(flow.id);
    expect(claimFlowByState(app.db, "raw-state-1", "u-claim")).toBeUndefined();
    expect(claimFlowByState(app.db, "never-issued", "u-claim")).toBeUndefined();
    expect(claimFlowByState(app.db, "", "u-claim")).toBeUndefined();
  });

  test("someone else's callback does not claim it, nor spend it", () => {
    start("u-owner", "raw-state-2");
    expect(claimFlowByState(app.db, "raw-state-2", "u-other")).toBeUndefined();
    expect(claimFlowByState(app.db, "raw-state-2", "u-owner")).toBeDefined();
  });

  test("the raw state and the secrets appear nowhere in the row", () => {
    const flow = start("u-raw", "raw-state-3-unique");
    const text = rowText(flow.id);
    expect(text).not.toContain("raw-state-3-unique");
    expect(text).not.toContain("verifier-value");
    expect(text).not.toContain("client-secret-value");
    expect(text).not.toContain("login/oauth/authorize");
  });
});

describe("a short code", () => {
  const now = new Date("2030-01-01T00:00:00.000Z");

  test("resolves a live flow", () => {
    const flow = start("u-short", "raw-state-4");
    expireAt(flow.id, new Date(now.getTime() + FLOW_TTL_MS).toISOString());
    expect(targetForShortCode(app.db, dataDir, flow.shortCode, now)).toBe(TARGET);
  });

  test("answers alike for an unknown, an expired and a finished flow", () => {
    const expired = start("u-short", "raw-state-5");
    expireAt(expired.id, new Date(now.getTime() - 1).toISOString());
    const finished = start("u-short", "raw-state-6");
    expireAt(finished.id, new Date(now.getTime() + FLOW_TTL_MS).toISOString());
    finishFlow(app.db, finished.id, { status: "done", detail: "" });

    const answers = [
      targetForShortCode(app.db, dataDir, "zzzzzzzzzz", now),
      targetForShortCode(app.db, dataDir, expired.shortCode, now),
      // finishing clears the code, so the old one finds nothing either
      targetForShortCode(app.db, dataDir, finished.shortCode, now),
      targetForShortCode(app.db, dataDir, "", now),
    ];
    for (const answer of answers) expect(answer).toBeUndefined();
  });
});

describe("who sees a flow", () => {
  test("its starter gets it; anyone else gets nothing", () => {
    const flow = start("u-starter", "raw-state-7");
    expect(getFlowFor(app.db, "u-starter", flow.id)?.id).toBe(flow.id);
    expect(getFlowFor(app.db, "u-intruder", flow.id)).toBeUndefined();
    expect(getFlowFor(app.db, "u-starter", "no-such-flow")).toBeUndefined();
  });
});

describe("pruning", () => {
  const now = new Date("2031-06-01T12:00:00.000Z");
  const iso = (ms: number): string => new Date(now.getTime() + ms).toISOString();
  const HOUR = 60 * 60 * 1000;
  const exists = (flowId: string): boolean =>
    app.db.query("SELECT 1 FROM oauth_flow WHERE id = ?1").get(flowId) !== null;

  test("drops expired and finished flows with their secrets, keeps the live one", () => {
    const live = start("u-prune", "raw-state-8");
    expireAt(live.id, iso(FLOW_TTL_MS));
    app.db.query("UPDATE oauth_flow SET created_at = ?1 WHERE id = ?2").run(iso(-1000), live.id);

    const expired = start("u-prune", "raw-state-9");
    expireAt(expired.id, iso(-1));

    const finished = start("u-prune", "raw-state-10");
    expireAt(finished.id, iso(FLOW_TTL_MS));
    finishFlow(app.db, finished.id, { status: "failed", detail: "denied" });
    app.db.query("UPDATE oauth_flow SET created_at = ?1 WHERE id = ?2").run(iso(-HOUR - 1000), finished.id);

    expect(flowSecrets(app.db, dataDir, live.id)?.verifier).toBe("verifier-value");
    expect(pruneFlows(app.db, now)).toBeGreaterThanOrEqual(2);

    expect(exists(live.id)).toBe(true);
    expect(exists(expired.id)).toBe(false);
    expect(exists(finished.id)).toBe(false);
    expect(flowSecrets(app.db, dataDir, expired.id)).toBeUndefined();
    expect(flowSecrets(app.db, dataDir, live.id)?.clientSecret).toBe("client-secret-value");
  });
});
