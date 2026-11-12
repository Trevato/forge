/**
 * An app whose `/` answers an error is not "ready": the deploy's proof
 * fetches `/` as well as the health path (#10565).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { enableApp } from "../src/actions/apps.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { rootFault } from "../src/apps/runtime.ts";
import {
  deploySettled,
  startAppsForge,
  stopAppsForge,
  type AppsForge,
} from "./helpers/apps-forge.ts";

const serveRoot = (status: number, headers: Record<string, string> = {}) =>
  Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) =>
      new URL(req.url).pathname === "/health"
        ? new Response("ok")
        : new Response("x", { status, headers }),
  });

describe("rootFault", () => {
  test.each([404, 500])("%d on / is named", async (status) => {
    const server = serveRoot(status);
    try {
      expect(await rootFault(server.port!)).toContain(`/ answered ${status}`);
    } finally {
      server.stop(true);
    }
  });

  test("200 and a redirect pass", async () => {
    const ok = serveRoot(200);
    const moved = serveRoot(302, { location: "/login" });
    try {
      expect(await rootFault(ok.port!)).toBeUndefined();
      expect(await rootFault(moved.port!)).toBeUndefined();
    } finally {
      ok.stop(true);
      moved.stop(true);
    }
  });
});

describe("a deploy proves /", () => {
  let forge: AppsForge;
  beforeAll(async () => {
    forge = await startAppsForge();
  }, 60_000);
  afterAll(async () => {
    await forge.runtime.stop();
    await stopAppsForge(forge);
  });

  const deployWith = async (name: string, rootStatus: number) => {
    const made = await createRepo(forge.app, forge.alice, { name, visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const repo = made.value;
    const run = `exec bun -e "Bun.serve({port:Number(process.env.PORT),hostname:'127.0.0.1',fetch:(r)=>new URL(r.url).pathname==='/health'?new Response('ok'):new Response('x',{status:${rootStatus}})})"\n`;
    const committed = await commitToBranch(forge.app, forge.alice, repo, {
      message: "An app",
      files: [
        {
          path: "forge.json",
          content: JSON.stringify({
            app: { run: "sh run.sh", install: "", health: "/health", ready: 10 },
          }),
        },
        { path: "run.sh", content: run },
      ],
    });
    if (!committed.ok) throw new Error(JSON.stringify(committed.error));
    const enabled = enableApp(forge.app, forge.alice, repo, {});
    if (!enabled.ok) throw new Error(String(enabled.error));
    return deploySettled(forge.app, repo.id, (r) => r.env === "production");
  };

  test("a healthy health route with a 404 / fails, naming the status", async () => {
    const done = await deployWith("rootless", 404);
    expect(done.state).toBe("failed");
    expect(done.summary).toContain("/ answered 404");
  }, 60_000);

  test("one answering 200 passes", async () => {
    const done = await deployWith("rooted", 200);
    expect(done.state).toBe("ok");
  }, 60_000);
});
