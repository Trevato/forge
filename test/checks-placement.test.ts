/**
 * `checks.placement` (#1815): `process` is today's check; `job` runs it as a
 * cluster Job through a stand-in kube client, streams its log into the run
 * and records the node and the placement.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { parseSelector, parseTolerations, placementFromEnv } from "../src/checks/placement.ts";
import { startChecks, type ChecksHandle } from "../src/checks/service.ts";
import { runRows } from "../src/tui/screens/runlist.ts";
import { placementLine } from "../src/web/studio/sandbox.ts";
import { runPayload } from "../src/actions/runs.ts";
import { placementWords } from "../src/checks/placement.ts";
import { listRuns, type Run } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import type { Repo } from "../src/core/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { setCapacity } from "../src/core/capacity.ts";
import { readRunLog } from "../src/runs/log.ts";

const checkJson = (run: string): string => `{"check": {"run": ${JSON.stringify(run)}, "install": ""}}\n`;

describe("placement from the environment", () => {
  const job = {
    FORGE_CHECKS_PLACEMENT: "job",
    FORGE_CHECKS_IMAGE: "oven/bun:1",
    FORGE_CHECKS_CLAIM: "checks-root",
  };
  test("process is the default, and what is malformed leaves it", () => {
    expect(placementFromEnv({})).toEqual({ mode: "process" });
    expect(placementFromEnv({ FORGE_CHECKS_PLACEMENT: "process" })).toEqual({ mode: "process" });
    expect(placementFromEnv({ FORGE_CHECKS_PLACEMENT: "job" })).toEqual({ mode: "process" });
    expect(placementFromEnv({ ...job, FORGE_CHECKS_NODE_SELECTOR: "bad key=x" })).toEqual({ mode: "process" });
    expect(placementFromEnv({ ...job, FORGE_CHECKS_TOLERATIONS: "[{\"effect\":\"Sometimes\"}]" })).toEqual({ mode: "process" });
  });
  test("job carries its node selector and tolerations", () => {
    expect(
      placementFromEnv({
        ...job,
        FORGE_CHECKS_NODE_SELECTOR: "pool=ci, arch=arm64",
        FORGE_CHECKS_TOLERATIONS: '[{"key":"ci","operator":"Exists","effect":"NoSchedule"}]',
      }),
    ).toEqual({
      mode: "job",
      image: "oven/bun:1",
      claim: "checks-root",
      nodeSelector: { pool: "ci", arch: "arm64" },
      tolerations: [{ key: "ci", operator: "Exists", effect: "NoSchedule" }],
    });
    expect(parseSelector("a")).toBeUndefined();
    expect(parseTolerations("{}")).toBeUndefined();
  });
});

describe("checks placed", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let checks: ChecksHandle;
  let alice: User;
  let repo: Repo;
  const calls: { method: string; url: string; body?: string }[] = [];
  let exit = 0;

  // A stand-in kube API: the Job succeeds at once, its pod on node n7.
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ method: String(init.method), url, ...(typeof init.body === "string" ? { body: init.body } : {}) });
    const path = new URL(url).pathname;
    if (init.method === "POST" || init.method === "DELETE") return Response.json({});
    if (path.endsWith("/log")) return new Response("from the job\nsecond line\n");
    if (path.endsWith("/pods"))
      return Response.json({
        items: [
          {
            metadata: { name: "p1" },
            spec: { nodeName: "n7" },
            status: { containerStatuses: [{ state: { terminated: { exitCode: exit } } }] },
          },
        ],
      });
    return Response.json({ status: exit === 0 ? { succeeded: 1 } : { failed: 1 } });
  };

  async function settled(oid: string): Promise<Run> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const run = listRuns(app.db, repo.id, { kind: "check", limit: 50 }).find((r) => r.commitOid === oid);
      if (run && (run.state === "ok" || run.state === "failed")) return run;
      await Bun.sleep(50);
    }
    throw new Error("check did not settle");
  }

  async function boot(placement: Parameters<typeof startChecks>[1]["placement"]): Promise<void> {
    dataDir = await mkdtemp(join(tmpdir(), "forge-placement-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    checks = startChecks(app, {
      forgeUrl: servers.url,
      concurrency: 1,
      placement,
      job: {
        fetch: fetch as never,
        credentials: { server: "https://k", token: "tok", namespace: "forge" },
        pollMs: 1,
      },
    });
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const made = await createRepo(app, alice, { name: "lib", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
  }
  async function down(): Promise<void> {
    await checks.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
  const push = async (run: string) => {
    const c = await commitToBranch(app, alice, repo, {
      message: "Declare a check",
      files: [{ path: "forge.json", content: checkJson(run) }],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    return c.value.commitOid;
  };

  describe("job", () => {
    beforeAll(() =>
      boot({
        mode: "job",
        image: "oven/bun:1",
        claim: "checks-root",
        nodeSelector: { pool: "ci" },
        tolerations: [{ key: "ci", operator: "Exists" }],
      }),
    );
    afterAll(down);
    // Egress is enforced by default, which keeps checks in cells.
    beforeAll(() => {
      setCapacity(app.db, "cells.egress", "report", alice.id);
    });

    test("a check runs as a Job: log in the run, node and placement recorded", async () => {
      const run = await settled(await push("exit 0"));
      expect(run.state).toBe("ok");
      expect(run.placement).toBe("job");
      expect(run.node).toBe("n7");
      const log = readRunLog(dataDir, run.id).lines.join("\n");
      expect(log).toContain("from the job");
      expect(log).toContain("$ exit 0");
      const made = JSON.parse(calls.find((c) => c.method === "POST")!.body!);
      const pod = made.spec.template.spec;
      expect(pod.nodeSelector).toEqual({ pool: "ci" });
      expect(pod.tolerations).toEqual([{ key: "ci", operator: "Exists" }]);
      expect(pod.volumes[0].persistentVolumeClaim.claimName).toBe("checks-root");
      expect(pod.volumes[0].persistentVolumeClaim.claimName).toBe("checks-root");
      expect(pod.containers[0].volumeMounts[0].subPath).toBe(run.id);
      expect(pod.automountServiceAccountToken).toBe(false);
      expect(pod.containers[0].resources.limits.memory).toMatch(/Mi$/);
      expect(made.spec.template.metadata.labels["forge-check"]).toBe("true");
      expect(run.sandboxEnforced).toBe(false);
      expect(run.sandboxNote).toBe("egress not enforced on a cluster job");
      expect(pod.containers[0].image).toBe("oven/bun:1");
      expect(pod.containers[0].command.at(-1)).toBe("exit 0");
      expect(calls.some((c) => c.method === "DELETE")).toBe(true);
    });

    test("the page, the terminal and the events say where a job ran; a process run says nothing", async () => {
      const run = await settled(await push("exit 0 # page"));
      expect(run.placement).toBe("job");
      const page = await (await globalThis.fetch(`${servers.url}/alice/lib/runs/${run.id}`)).text();
      // A stranger reads that it was a cluster job, never on which node (#2917).
      expect(page).toContain("Ran as a cluster job.");
      expect(page).not.toContain("job on n7");
      expect(String(placementLine(run))).toContain("Ran as a cluster job on n7.");
      expect(runRows([run], new Map())[0]!.meta).toContain("ran as a cluster job on n7");
      expect(runPayload(run)).toMatchObject({ placement: "job", node: "n7" });
      const plain = { ...run, placement: "process", node: "" };
      expect(placementLine(plain)).toBeNull();
      expect(runRows([plain], new Map())[0]!.meta).not.toContain("cluster");
      expect(runPayload(plain)).not.toHaveProperty("node");
    });

    test("a node name from the cluster is escaped on the page and clean in the terminal", () => {
      const odd = { placement: "job", node: "<b>n\u001b[31m7" };
      expect(placementWords(odd)).toBe("ran as a cluster job on <b>n[31m7");
      expect(String(placementLine({ ...odd } as never))).toContain("&lt;b&gt;");
    });

    test("a failing Job fails the check, still on its node", async () => {
      exit = 2;
      try {
        const run = await settled(await push("exit 2"));
        expect(run.state).toBe("failed");
        expect(run.summary).toContain("second line");
        expect(run.node).toBe("n7");
      } finally {
        exit = 0;
      }
    });
  });

  describe("job under enforce", () => {
    beforeAll(() => boot({ mode: "job", image: "oven/bun:1", claim: "checks-root", nodeSelector: {}, tolerations: [] }));
    afterAll(down);

    test("never calls the cluster: the check runs in a cell and says why", async () => {
      calls.length = 0;
      const run = await settled(await push("echo in a cell"));
      expect(run.state).toBe("ok");
      expect(run.placement).toBe("process");
      expect(run.node).toBe("");
      expect(calls).toHaveLength(0);
      const log = readRunLog(dataDir, run.id).lines.join("\n");
      expect(log).toContain("placement: job skipped, egress is enforced and a Job cannot hold it");
      expect(log).toContain("in a cell");
      const page = await (await globalThis.fetch(`${servers.url}/alice/lib/runs/${run.id}`)).text();
      expect(page).not.toContain("cluster job");
    });

    test("is read per run: flipping to report sends the next check to a Job", async () => {
      setCapacity(app.db, "cells.egress", "report", alice.id);
      const run = await settled(await push("echo flipped"));
      expect(run.placement).toBe("job");
      expect(calls.some((c) => c.method === "POST")).toBe(true);
    });
  });

  describe("process", () => {
    beforeAll(() => boot(undefined));
    afterAll(down);

    test("the default runs here, calls no cluster and records process", async () => {
      calls.length = 0;
      const run = await settled(await push("echo here"));
      expect(run.state).toBe("ok");
      expect(run.placement).toBe("process");
      expect(run.node).toBe("");
      expect(readRunLog(dataDir, run.id).lines.join("\n")).toContain("here");
      expect(calls).toHaveLength(0);
    });
  });
});
